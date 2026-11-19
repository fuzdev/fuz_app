/**
 * Rooms over the WebSocket connection registry: members seated in a room by
 * key, relayed messages, per-member state, and occupancy watches. The TS twin
 * of the Rust spine's `fuz_realtime::RoomRegistry`.
 *
 * A room is a key (`RoomId`) the consumer chooses — e.g. a voice room keyed
 * by a space id — holding **seats** and **watches**. A seat is one actor's
 * membership on one connection, with a random `MemberId` that clients address
 * each other by (a connection id never reaches the wire) and a small
 * client-encoded state string. Seats are keyed by connection and actor: a
 * connection whose requests act as different actors of one account (the
 * dispatcher's `acting` selector) holds a seat per actor, and a leave, send,
 * or state set touches only the acting actor's own seat; an event skips the
 * seat that caused it, not its connection. A watch sees the members without
 * joining; it is one per connection and room, whichever actor last asked for
 * it. The registry relays opaque payloads between members and knows nothing of
 * what they carry. Rooms live in memory and die with the process: a restart
 * drops every room and clients rejoin.
 *
 * The verbs over it — the specs, the authorizer hook, the per-connection
 * limiter — are `actions/room_action_specs.ts` and `actions/room_actions.ts`;
 * this module holds the state and the fan-out.
 *
 * ## One step, one order
 *
 * The Rust registry holds rooms, seats, watches, joins in flight, and the
 * per-connection and per-actor indexes under one lock, since exclusivity and
 * eviction span rooms. Here every method runs to completion without an
 * `await`, so JavaScript's single thread gives the same guarantee: no check is
 * ever separated from the mutation it guards. Every notification is queued
 * inside that step through `ConnectionRegistry.send_to`, which never waits, so
 * each room's events carry a `seq` that orders them: one counter per room,
 * bumped by every event in the room. A room with no seats and no watches is
 * deleted; a new one starts its `seq` again at zero.
 *
 * `seq` orders a room's events, and lets a client drop the events at or below
 * the snapshot a join or watch answered; it is not contiguous per client (an
 * addressed message bumps it, and only the addressee sees that one), and it
 * restarts when a room is deleted and created again. Event order across rooms
 * is unspecified; within a room it is the `seq`.
 *
 * Nothing here waits: a recipient that cannot take a frame is closed for the
 * overflow (`WS_CLOSE_OUTBOUND_OVERFLOW`) by the connection registry, and its
 * seats are then released like any other disconnect.
 *
 * ## Two-phase join
 *
 * A join is `reserve_seat`, the consumer's authorizer, then `admit_seat`. The
 * reserve puts the join **in flight** before the authorizer reads anything,
 * refused when the socket has already closed, and returns a `PendingSeat`;
 * `admit_seat` always consumes it, and a caller that never reaches the admit
 * calls `withdraw` (in a `finally` — the Rust guard's drop). While in flight
 * the join is reachable: an eviction that names its actor or room refuses it,
 * one that names a scope marks it, so the admit refuses when the verdict's
 * scope is that one, and the connection's own `leave` of the room refuses it
 * as superseded. That closes the race of an eviction against an authorizer: a
 * consumer evicts after its write commits, and its authorizer reads under READ
 * COMMITTED, so the eviction either precedes the reserve — then its commit
 * precedes the authorizer's read, which denies — or follows it and reaches the
 * join in flight.
 *
 * The argument holds only for authority the authorizer **reads inside that
 * window**, after the reserve, from the database. Anything loaded before the
 * reserve — the request's own role grants, which the dispatcher reads before
 * the handler runs — may predate an eviction that also precedes the reserve
 * and so found nothing in flight to reach: the stale read would admit an
 * evicted actor. The authorizer hook (`RoomAuthorize`) therefore gets the
 * caller's ids and the database, never the request's grants. Watches run the
 * same two phases (`reserve_watch`, `admit_watch`).
 *
 * Unlike the Rust join, whose request future is dropped when its socket
 * closes, a TS join keeps running after the close: the admit refuses it, since
 * the close marks every join in flight on the connection and the admit reads
 * the socket's signal.
 *
 * The admit seats the member unless it was refused meanwhile, its socket
 * closed, or the room is full. A refused join displaces nothing.
 *
 * ## Exclusivity and the rejoin guard
 *
 * With `exclusive` an actor holds one seat across the registry: the newest
 * **admitted** join wins (two sockets racing settle by which admits last, not
 * which sent first), and the seat it displaces hears `room_seat_lost` with
 * reason `moved` and `moved_to`, the new seat's room. Either way a connection
 * holds one seat per room for each actor; joining again as that actor moves its
 * old seat the same way.
 *
 * A seat whose socket died never hears that it moved. Its client, on
 * reconnecting, rejoins naming the seat it held (`rejoin_of`), and must not
 * take back the seat its actor holds now. So an exclusive registry keeps a
 * short per-actor **tombstone** of seats that ended without a leave: each seat
 * moved away, and each released by its disconnect, which counts as moved once
 * the actor is seated again by any other join. A rejoin naming a moved seat is
 * refused (`seat_moved`) instead of seated; one naming a seat released by its
 * disconnect and not moved since is seated, as is any other. Tombstones last
 * `ROOM_REJOIN_TOMBSTONE_TTL_MS`, at most `ROOM_REJOIN_TOMBSTONES_PER_ACTOR`
 * per actor; past either bound a rejoin is seated like a fresh join.
 *
 * ## Disconnect
 *
 * The first seat or watch a connection reserves adds **one** listener to the
 * connection's socket signal (`ConnectionRegistry.socket_signal` — the signal
 * every close path aborts), and the connection keeps it for its life, however
 * many joins and leaves it makes. When the signal aborts, the registry
 * releases every seat (`room_member_left` with reason `disconnected`), watch,
 * and join in flight the connection holds — on the next microtask, as the Rust
 * waiter runs as its own task, so a close made inside a fan-out (an overflow)
 * never re-enters the registry mid-step.
 *
 * ## Eviction
 *
 * `evict` is the consumer's call when its own authority changes, made after
 * the change commits: by actor, by actor within a scope, by room, or by scope
 * (`RoomEvictTarget`), covering seats, watches, and joins in flight alike, so
 * an evicted actor keeps neither a seat nor a watch. Its socket still hears the
 * room while another actor of the same account is seated there or holds the
 * watch, on that actor's own authority.
 *
 * ## Bounds
 *
 * Seats are bounded by the rooms' cap (and by one per actor when exclusive),
 * watches per connection, joins in flight by the connection's in-flight
 * request cap, listeners at one per connection, and tombstones as above.
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';

import { create_uuid, type Uuid } from '../primitive_schemas.ts';
import type { ConnectionRegistry } from './connection_registry.ts';
import {
	DEFAULT_ROOM_MAX_MEMBERS,
	DEFAULT_ROOM_MAX_PAYLOAD_BYTES,
	DEFAULT_ROOM_MAX_STATE_BYTES,
	DEFAULT_ROOM_MAX_WATCHES_PER_CONNECTION,
	room_member_joined_notification_spec,
	room_member_left_notification_spec,
	room_member_state_notification_spec,
	room_message_notification_spec,
	room_seat_lost_notification_spec,
	room_watch_ended_notification_spec,
	type MemberId,
	type RoomEvictReason,
	type RoomId,
	type RoomLeftReason,
	type RoomMember,
	type RoomMemberJoinedParams,
	type RoomMemberLeftParams,
	type RoomMemberStateParams,
	type RoomMessageParams,
	type RoomOccupancy,
	type RoomSeatLostParams,
	type RoomSeatLostReason,
	type RoomTopology,
	type RoomWatchEndedParams
} from './room_action_specs.ts';
import { utf8_length } from './transports.ts';

/**
 * How long an exclusive registry remembers a seat that ended without a leave,
 * for the rejoin guard (module doc). Twin of the Rust
 * `ROOM_REJOIN_TOMBSTONE_TTL` (15 minutes).
 */
export const ROOM_REJOIN_TOMBSTONE_TTL_MS = 15 * 60 * 1000;

/** The most tombstones an exclusive registry keeps per actor; past it the oldest goes. */
export const ROOM_REJOIN_TOMBSTONES_PER_ACTOR = 8;

/**
 * The most scope evictions one join or watch in flight records; past it the
 * join or watch is refused outright, whatever its verdict's scope.
 *
 * A client sees what any eviction of its request in flight answers: the join
 * or watch is refused as if the room were missing (`room_not_found` from the
 * verbs). It trips only when more distinct scopes than this are evicted during
 * one authorizer read. Both twins hold the same bound.
 */
export const MAX_POISONED_SCOPES = 16;

/**
 * The fewest actors the tombstone map holds before it sweeps expired entries;
 * it sweeps again at twice what a sweep leaves.
 */
const TOMBSTONE_SWEEP_FLOOR = 64;

/**
 * A consumer's tag for the authority a seat or watch was admitted under, from
 * the authorizer's verdict — e.g. the group whose membership let the actor in.
 * Eviction targets it: when that authority changes, the consumer evicts the
 * scope, or an actor within it.
 */
export type RoomScope = string;

/**
 * A room operation's refusal — the twin of the Rust `RoomError`:
 *
 * - `connection_closed` — the connection is gone or closing, so nothing is seated on it
 * - `evicted` — an eviction reached the join or watch while it was in flight
 * - `join_superseded` — the connection left the room while its join was in flight
 * - `seat_moved` — the seat a rejoin names moved elsewhere since
 * - `full` — the room seats its maximum already
 * - `not_joined` — the connection holds no seat in the room
 * - `member_not_found` — the addressee is not a member of the room
 * - `payload_too_large` — the payload is over `max_payload_bytes`
 * - `state_too_large` — the state is over `max_state_bytes`
 * - `watch_limit` — the connection watches `max_watches_per_connection` rooms already
 */
export type RoomError =
	| 'connection_closed'
	| 'evicted'
	| 'join_superseded'
	| 'seat_moved'
	| 'full'
	| 'not_joined'
	| 'member_not_found'
	| 'payload_too_large'
	| 'state_too_large'
	| 'watch_limit';

/** A room operation's outcome: its value, or its refusal. */
export type RoomResult<T> = Result<{ value: T }, { error: RoomError }>;

/** A `RoomRegistry`'s bounds and rules; each omitted field takes its default. */
export interface RoomRegistryOptions {
	/**
	 * One seat per actor across the whole registry: an admitted join moves the
	 * actor's other seat, wherever it is, and the newest admitted seat wins
	 * (`room_seat_lost` with reason `moved` to the seat it displaced). Default
	 * `false`.
	 */
	readonly exclusive?: boolean;
	/**
	 * The most members a room seats, a positive integer; an authorizer's
	 * verdict may lower it for one join, never raise it. Default
	 * `DEFAULT_ROOM_MAX_MEMBERS`.
	 */
	readonly max_members_per_room?: number;
	/** The longest message payload, in UTF-8 bytes. Default `DEFAULT_ROOM_MAX_PAYLOAD_BYTES`. */
	readonly max_payload_bytes?: number;
	/** The longest member state, in UTF-8 bytes. Default `DEFAULT_ROOM_MAX_STATE_BYTES`. */
	readonly max_state_bytes?: number;
	/**
	 * The most rooms one connection watches at once. Default
	 * `DEFAULT_ROOM_MAX_WATCHES_PER_CONNECTION`.
	 */
	readonly max_watches_per_connection?: number;
	/** What the join answers as the room's topology. Default `'mesh'`. */
	readonly topology?: RoomTopology;
	/**
	 * The monotonic clock the tombstones age by, in ms. Default
	 * `performance.now`; a test passes its own to drive the expiry.
	 */
	readonly now?: () => number;
}

/** A registry's resolved options — every bound set. */
export interface RoomRegistryLimits {
	readonly exclusive: boolean;
	readonly max_members_per_room: number;
	readonly max_payload_bytes: number;
	readonly max_state_bytes: number;
	readonly max_watches_per_connection: number;
	readonly topology: RoomTopology;
}

/** A join to seat: who, on which connection, into which room. */
export interface RoomSeatRequest {
	readonly connection_id: Uuid;
	readonly actor_id: Uuid;
	readonly room_id: RoomId;
	/**
	 * The seat this join takes up again after a reconnect — refused as
	 * `seat_moved` on an exclusive registry when that seat has moved since
	 * (module doc); ignored otherwise.
	 */
	readonly rejoin_of?: MemberId | null;
}

/** What the authorizer's verdict and the request add at admission. */
export interface RoomSeatAdmit {
	/** The authority the seat is admitted under, for eviction. */
	readonly scope?: RoomScope | null;
	/**
	 * This join's member cap, a non-negative integer, below the registry's;
	 * omitted keeps the registry's.
	 */
	readonly max_members?: number | null;
	/** The member's initial state. */
	readonly state?: string | null;
}

/**
 * What an admitted join answers: the seat, and the room as of `seq` — the seq
 * of the joiner's own `room_member_joined`, so a client drops every buffered
 * event at or below it. `members` holds every member, the joiner included, in
 * seating order.
 */
export interface RoomJoined {
	readonly room_id: RoomId;
	readonly member_id: MemberId;
	readonly seq: number;
	readonly members: Array<RoomMember>;
	readonly topology: RoomTopology;
}

/** What `RoomRegistry.evict` removes. */
export type RoomEvictTarget =
	/** Every seat and watch of an actor. */
	| { readonly kind: 'actor'; readonly actor_id: Uuid }
	/** An actor's seats and watches admitted under one scope. */
	| { readonly kind: 'actor_in_scope'; readonly actor_id: Uuid; readonly scope: RoomScope }
	/** Every seat and watch of a room. */
	| { readonly kind: 'room'; readonly room_id: RoomId }
	/** Every seat and watch admitted under a scope. */
	| { readonly kind: 'scope'; readonly scope: RoomScope };

/** What one `RoomRegistry.evict` removed. */
export interface RoomEvicted {
	/** Seated members removed. */
	seats: number;
	/** Watches removed. */
	watches: number;
	/**
	 * Joins and watches in flight it reached: refused outright by an actor or
	 * room target, marked by a scope target (refused at admission only if
	 * their verdict names the scope).
	 */
	pending: number;
}

/** What a pending seat or watch carries privately: its registry, ticket, and release. */
interface PendingHandle {
	readonly registry: RoomRegistry;
	readonly ticket: number;
	/** Forgets the entry in flight; `null` once withdrawn or handed to an admit. */
	forget: (() => void) | null;
}

const pending_handles: WeakMap<PendingSeat | PendingWatch, PendingHandle> = new WeakMap();

/** Release a pending seat or watch, once. */
const withdraw_pending = (pending: PendingSeat | PendingWatch): void => {
	const handle = pending_handles.get(pending);
	const forget = handle?.forget;
	if (!handle || !forget) return;
	handle.forget = null;
	forget();
};

/**
 * A join in flight, between `RoomRegistry.reserve_seat` and
 * `RoomRegistry.admit_seat`. The admit consumes it; a caller that never
 * reaches the admit — a refusal, a cancelled request, a throwing authorizer —
 * calls `withdraw`, which removes it (in a `finally`, as the Rust guard's drop
 * does). Withdrawing an admitted or withdrawn seat does nothing.
 */
export class PendingSeat {
	/** The member id the seat will have once admitted. */
	readonly member_id: MemberId;
	/** The room the join is for. */
	readonly room_id: RoomId;

	constructor(member_id: MemberId, room_id: RoomId) {
		this.member_id = member_id;
		this.room_id = room_id;
	}

	/** Withdraw the join, if it is still in flight. */
	withdraw(): void {
		withdraw_pending(this);
	}
}

/**
 * A watch in flight, between `RoomRegistry.reserve_watch` and
 * `RoomRegistry.admit_watch` — the watch half of `PendingSeat`.
 */
export class PendingWatch {
	/** The room the watch is for. */
	readonly room_id: RoomId;

	constructor(room_id: RoomId) {
		this.room_id = room_id;
	}

	/** Withdraw the watch, if it is still in flight. */
	withdraw(): void {
		withdraw_pending(this);
	}
}

interface Seat {
	member_id: MemberId;
	connection_id: Uuid;
	actor_id: Uuid;
	scope: RoomScope | null;
	state: string | null;
}

interface Watcher {
	connection_id: Uuid;
	actor_id: Uuid;
	scope: RoomScope | null;
}

interface Room {
	seq: number;
	/** In seating order. */
	seats: Array<Seat>;
	/** One per connection. */
	watchers: Array<Watcher>;
}

/** What one connection holds. */
interface ConnectionRooms {
	/** The socket signal its listener waits on. */
	signal: AbortSignal;
	/** Each room's seats on this connection, by actor — one unless requests act as several actors of the account. */
	seats: Map<RoomId, Map<Uuid, MemberId>>;
	watches: Set<RoomId>;
	pending: Set<number>;
}

type PendingKind =
	{ type: 'seat'; member_id: MemberId; rejoin_of: MemberId | null } | { type: 'watch' };

interface Pending {
	kind: PendingKind;
	connection_id: Uuid;
	actor_id: Uuid;
	room_id: RoomId;
	/** Why it will be refused at admission, once something refused it. */
	refused: RoomError | null;
	/** Scopes evicted while it was in flight. */
	poisoned: Array<RoomScope>;
}

interface Tombstone {
	member_id: MemberId;
	at: number;
	/** Moved away, or released by a disconnect and the actor seated since. */
	moved: boolean;
}

/**
 * Why seats and watchers leave a room, which decides what `#remove` tells:
 * the room hears `room_member_left` for each removed seat, with the
 * matching reason; a move also
 * tells each removed seat `room_seat_lost` (`moved_to` its new room), and an
 * eviction tells each removed seat `room_seat_lost` and each removed watcher
 * `room_watch_ended`. A leave and a disconnect tell the removed no more.
 */
type Departure =
	| { kind: 'left' }
	| { kind: 'disconnected' }
	| { kind: 'moved'; to: RoomId }
	| { kind: 'evicted'; reason: RoomEvictReason };

/** `actor_id`'s seat in the room on `conn`, or `null`. */
const conn_seat = (conn: ConnectionRooms, room_id: RoomId, actor_id: Uuid): MemberId | null =>
	conn.seats.get(room_id)?.get(actor_id) ?? null;

const conn_set_seat = (
	conn: ConnectionRooms,
	room_id: RoomId,
	actor_id: Uuid,
	member_id: MemberId
): void => {
	let by_actor = conn.seats.get(room_id);
	if (!by_actor) {
		by_actor = new Map();
		conn.seats.set(room_id, by_actor);
	}
	by_actor.set(actor_id, member_id);
};

/** Forget `actor_id`'s seat in the room on `conn`, if it is still `member_id`. */
const conn_clear_seat = (
	conn: ConnectionRooms,
	room_id: RoomId,
	actor_id: Uuid,
	member_id: MemberId
): void => {
	const by_actor = conn.seats.get(room_id);
	if (!by_actor) return;
	if (by_actor.get(actor_id) === member_id) by_actor.delete(actor_id);
	if (by_actor.size === 0) conn.seats.delete(room_id);
};

const ok = <T>(value: T): RoomResult<T> => ({ ok: true, value });
const refuse = <T>(error: RoomError): RoomResult<T> => ({ ok: false, error });

const members_of = (room: Room): Array<RoomMember> =>
	room.seats.map((seat) => ({
		member_id: seat.member_id,
		actor_id: seat.actor_id,
		state: seat.state
	}));

/**
 * The connection of every seat but `except`'s. A connection holding another
 * seat beside `except`'s (another actor of the account) is included.
 */
const member_connections = (room: Room, except: MemberId | null): Set<Uuid> => {
	const ids: Set<Uuid> = new Set();
	for (const seat of room.seats) {
		if (seat.member_id !== except) ids.add(seat.connection_id);
	}
	return ids;
};

/** The connections a member event goes to: every member's but the seat `except`'s, and every watcher's. */
const recipients_of = (room: Room, except: MemberId | null): Set<Uuid> => {
	const ids = member_connections(room, except);
	for (const watcher of room.watchers) ids.add(watcher.connection_id);
	return ids;
};

/** Whether an eviction `target` names a seat or watch of `actor_id`, admitted under `scope`, in `room_id`. */
const target_matches = (
	target: RoomEvictTarget,
	actor_id: Uuid,
	scope: RoomScope | null,
	room_id: RoomId
): boolean => {
	switch (target.kind) {
		case 'actor':
			return actor_id === target.actor_id;
		case 'actor_in_scope':
			return actor_id === target.actor_id && scope === target.scope;
		case 'room':
			return room_id === target.room_id;
		case 'scope':
			return scope === target.scope;
	}
};

const poison = (pending: Pending, scope: RoomScope): void => {
	if (pending.poisoned.includes(scope)) return;
	if (pending.poisoned.length >= MAX_POISONED_SCOPES) {
		pending.refused = 'evicted';
	} else {
		pending.poisoned.push(scope);
	}
};

/** A positive integer option, or its default; anything else throws. */
const resolve_count = (name: string, value: number | undefined, fallback: number, min: number) => {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < min) {
		throw new Error(`RoomRegistry: ${name} must be an integer of at least ${min}, got ${resolved}`);
	}
	return resolved;
};

/**
 * The room registry: see the module doc.
 *
 * Build one over the connection registry its WebSocket endpoint uses
 * (`new RoomRegistry(connections, options)`); a connection id from any other
 * registry names no socket here, so its reserves refuse as
 * `connection_closed`. Two WS endpoints sharing one connection registry share
 * one room registry.
 */
export class RoomRegistry {
	/** The registry's resolved bounds and rules. */
	readonly options: RoomRegistryLimits;

	readonly #connections: ConnectionRegistry;
	readonly #now: () => number;

	readonly #rooms: Map<RoomId, Room> = new Map();
	readonly #by_connection: Map<Uuid, ConnectionRooms> = new Map();
	/** Joins and watches in flight, by ticket. */
	readonly #pending: Map<number, Pending> = new Map();
	#last_ticket = 0;
	/** Each actor's one seat, on an exclusive registry. */
	readonly #seat_of_actor: Map<Uuid, { room_id: RoomId; member_id: MemberId }> = new Map();
	/** Seats ended without a leave, per actor, on an exclusive registry. */
	readonly #tombstones: Map<Uuid, Array<Tombstone>> = new Map();
	/** The actor count past which the tombstones sweep. */
	#tombstone_sweep_at = 0;

	/**
	 * @throws Error when a bound is not an integer in range (`max_members_per_room`
	 *   at least 1, the byte and watch bounds at least 0)
	 */
	constructor(connections: ConnectionRegistry, options: RoomRegistryOptions = {}) {
		this.#connections = connections;
		this.#now = options.now ?? (() => performance.now());
		this.options = Object.freeze({
			exclusive: options.exclusive ?? false,
			max_members_per_room: resolve_count(
				'max_members_per_room',
				options.max_members_per_room,
				DEFAULT_ROOM_MAX_MEMBERS,
				1
			),
			max_payload_bytes: resolve_count(
				'max_payload_bytes',
				options.max_payload_bytes,
				DEFAULT_ROOM_MAX_PAYLOAD_BYTES,
				0
			),
			max_state_bytes: resolve_count(
				'max_state_bytes',
				options.max_state_bytes,
				DEFAULT_ROOM_MAX_STATE_BYTES,
				0
			),
			max_watches_per_connection: resolve_count(
				'max_watches_per_connection',
				options.max_watches_per_connection,
				DEFAULT_ROOM_MAX_WATCHES_PER_CONNECTION,
				0
			),
			topology: options.topology ?? 'mesh'
		});
	}

	/**
	 * Phase one of a join: put it in flight before the authorizer runs (module
	 * doc, "Two-phase join").
	 *
	 * @returns the join in flight, or `connection_closed` when the connection
	 *   is gone or closing, or `seat_moved` when the request is a rejoin of a
	 *   seat that has moved (exclusive registries)
	 * @mutates this - records the join in flight, and on the connection's first
	 *   reserve adds its one disconnect listener
	 */
	reserve_seat(request: RoomSeatRequest): RoomResult<PendingSeat> {
		const { connection_id, actor_id, room_id } = request;
		const rejoin_of = request.rejoin_of ?? null;
		if (
			this.options.exclusive &&
			rejoin_of !== null &&
			this.#rejoin_moved(actor_id, rejoin_of, this.#now())
		) {
			return refuse('seat_moved');
		}
		const conn = this.#connection_entry(connection_id);
		if (!conn) return refuse('connection_closed');
		const member_id = create_uuid();
		return ok(
			this.#reserve(
				conn,
				{ type: 'seat', member_id, rejoin_of },
				connection_id,
				actor_id,
				new PendingSeat(member_id, room_id)
			)
		);
	}

	/**
	 * Phase two of a join: seat the member (module doc). Consumes `pending`,
	 * whatever it answers.
	 *
	 * Moves the actor's own seat in the room on this connection, and on an
	 * exclusive registry the actor's seat anywhere, to this one: each hears
	 * `room_seat_lost` with reason `moved`, its room `room_member_left` with
	 * reason `moved`. Then the room hears `room_member_joined`.
	 *
	 * @returns the seat and the room, or `state_too_large`; `evicted`,
	 *   `join_superseded`, or `connection_closed` when the join was refused in
	 *   flight or its socket closed; `seat_moved` for a rejoin of a moved seat;
	 *   `full` when the room seats its cap (the lower of the registry's and
	 *   `admit.max_members`) after the moves this join makes
	 * @throws Error when `admit.max_members` is not a non-negative integer (a
	 *   consumer's authorizer bug), checked once the join passes its other
	 *   refusals; `pending` is consumed all the same
	 * @mutates this - seats the member, moving what the join displaces
	 */
	admit_seat(pending: PendingSeat, admit: RoomSeatAdmit = {}): RoomResult<RoomJoined> {
		const ticket = this.#disarm(pending);
		if (ticket === null) return refuse('evicted');
		const member_state = admit.state ?? null;
		if (member_state !== null && utf8_length(member_state) > this.options.max_state_bytes) {
			this.#take_pending(ticket);
			return refuse('state_too_large');
		}
		const scope = admit.scope ?? null;
		const exclusive = this.options.exclusive;

		const entry = this.#take_pending(ticket);
		if (!entry || entry.kind.type !== 'seat') return refuse('evicted');
		const { member_id, rejoin_of } = entry.kind;
		if (entry.refused !== null) return refuse(entry.refused);
		const { connection_id, actor_id, room_id } = entry;
		const conn = this.#by_connection.get(connection_id);
		if (!conn || conn.signal.aborted) return refuse('connection_closed');
		const own_seat = conn_seat(conn, room_id, actor_id);
		if (scope !== null && entry.poisoned.includes(scope)) return refuse('evicted');
		const now = this.#now();
		if (exclusive && rejoin_of !== null && this.#rejoin_moved(actor_id, rejoin_of, now)) {
			return refuse('seat_moved');
		}

		// the seats this join moves: the actor's own on this connection in the
		// room, and on an exclusive registry the actor's, wherever it is
		const displaced: Array<{ room_id: RoomId; member_id: MemberId }> = [];
		if (own_seat !== null) displaced.push({ room_id, member_id: own_seat });
		const actor_seat = exclusive ? this.#seat_of_actor.get(actor_id) : undefined;
		if (actor_seat && !displaced.some((d) => d.member_id === actor_seat.member_id)) {
			displaced.push({ room_id: actor_seat.room_id, member_id: actor_seat.member_id });
		}

		const registry_cap = this.options.max_members_per_room;
		const cap_in = admit.max_members ?? null;
		if (cap_in !== null && !(Number.isSafeInteger(cap_in) && cap_in >= 0)) {
			throw new Error(`RoomRegistry: max_members must be an integer of at least 0, got ${cap_in}`);
		}
		const cap = cap_in === null ? registry_cap : Math.min(cap_in, registry_cap);
		const seated = this.#rooms.get(room_id)?.seats.length ?? 0;
		const freed = displaced.filter((d) => d.room_id === room_id).length;
		if (Math.max(seated - freed, 0) >= cap) return refuse('full');

		for (const d of displaced) {
			const removed = this.#remove(d.room_id, [d.member_id], [], { kind: 'moved', to: room_id });
			if (exclusive) {
				for (const seat of removed) this.#push_tombstone(seat.actor_id, seat.member_id, now, true);
			}
		}

		const room = this.#room_entry(room_id);
		room.seats.push({ member_id, connection_id, actor_id, scope, state: member_state });
		const seq = ++room.seq;
		this.#send(recipients_of(room, member_id), room_member_joined_notification_spec.method, {
			room_id,
			seq,
			member: { member_id, actor_id, state: member_state }
		} satisfies RoomMemberJoinedParams);
		const members = members_of(room);
		conn_set_seat(conn, room_id, actor_id, member_id);
		if (exclusive) {
			this.#seat_of_actor.set(actor_id, { room_id, member_id });
			this.#settle_tombstones(actor_id, rejoin_of, now);
		}
		return ok({ room_id, member_id, seq, members, topology: this.options.topology });
	}

	/**
	 * End `actor_id`'s seat in the room on the connection (`room_member_left`
	 * with reason `left`), and refuse that actor's joins of the room still in
	 * flight on it (`join_superseded`). Another actor's seat on the same
	 * connection is untouched. Idempotent.
	 *
	 * @returns `true` when it ended or refused anything
	 * @mutates this - removes the seat, marks the joins in flight
	 */
	leave(connection_id: Uuid, actor_id: Uuid, room_id: RoomId): boolean {
		const conn = this.#by_connection.get(connection_id);
		if (!conn) return false;
		const seat = conn_seat(conn, room_id, actor_id);
		let left = false;
		for (const ticket of conn.pending) {
			const pending = this.#pending.get(ticket);
			if (
				pending &&
				pending.room_id === room_id &&
				pending.actor_id === actor_id &&
				pending.kind.type === 'seat' &&
				pending.refused === null
			) {
				pending.refused = 'join_superseded';
				left = true;
			}
		}
		if (seat !== null) {
			this.#remove(room_id, [seat], [], { kind: 'left' });
			left = true;
		}
		return left;
	}

	/**
	 * Relay `payload` from `actor_id`'s seat in the room on the connection to
	 * the member `to`, or with `null` to every other member (`room_message`).
	 * Watchers get no messages.
	 *
	 * @returns the message's `seq`, or `payload_too_large`, `not_joined`, or
	 *   `member_not_found` when `to` names no member of the room — or names the
	 *   sender's own seat: a seat never addresses itself
	 */
	send(
		connection_id: Uuid,
		actor_id: Uuid,
		room_id: RoomId,
		to: MemberId | null,
		payload: string
	): RoomResult<number> {
		if (utf8_length(payload) > this.options.max_payload_bytes) return refuse('payload_too_large');
		const conn = this.#by_connection.get(connection_id);
		const from = conn ? conn_seat(conn, room_id, actor_id) : null;
		if (from === null) return refuse('not_joined');
		const room = this.#rooms.get(room_id);
		if (!room) return refuse('not_joined');
		let recipients: Set<Uuid>;
		if (to === null) {
			recipients = member_connections(room, from);
		} else {
			if (to === from) return refuse('member_not_found');
			const addressee = room.seats.find((seat) => seat.member_id === to);
			if (!addressee) return refuse('member_not_found');
			recipients = new Set([addressee.connection_id]);
		}
		const seq = ++room.seq;
		this.#send(recipients, room_message_notification_spec.method, {
			room_id,
			seq,
			from,
			to,
			payload
		} satisfies RoomMessageParams);
		return ok(seq);
	}

	/**
	 * Set `actor_id`'s member state in the room on the connection, telling the
	 * other members and the watchers (`room_member_state`).
	 *
	 * @returns its `seq`, or `state_too_large` or `not_joined`
	 */
	set_state(
		connection_id: Uuid,
		actor_id: Uuid,
		room_id: RoomId,
		member_state: string
	): RoomResult<number> {
		if (utf8_length(member_state) > this.options.max_state_bytes) return refuse('state_too_large');
		const conn = this.#by_connection.get(connection_id);
		const member_id = conn ? conn_seat(conn, room_id, actor_id) : null;
		if (member_id === null) return refuse('not_joined');
		const room = this.#rooms.get(room_id);
		if (!room) return refuse('not_joined');
		const seat = room.seats.find((s) => s.member_id === member_id);
		if (!seat) return refuse('not_joined');
		seat.state = member_state;
		const seq = ++room.seq;
		this.#send(recipients_of(room, member_id), room_member_state_notification_spec.method, {
			room_id,
			seq,
			member_id,
			state: member_state
		} satisfies RoomMemberStateParams);
		return ok(seq);
	}

	/**
	 * Phase one of a watch, as `reserve_seat` is of a join.
	 *
	 * @returns the watch in flight, or `connection_closed`, or `watch_limit`
	 *   when the connection watches its maximum of other rooms
	 * @mutates this - records the watch in flight, and on the connection's
	 *   first reserve adds its one disconnect listener
	 */
	reserve_watch(connection_id: Uuid, actor_id: Uuid, room_id: RoomId): RoomResult<PendingWatch> {
		const conn = this.#connection_entry(connection_id);
		if (!conn) return refuse('connection_closed');
		if (
			!conn.watches.has(room_id) &&
			conn.watches.size >= this.options.max_watches_per_connection
		) {
			return refuse('watch_limit');
		}
		return ok(
			this.#reserve(conn, { type: 'watch' }, connection_id, actor_id, new PendingWatch(room_id))
		);
	}

	/**
	 * Phase two of a watch: from now on the connection hears the room's member
	 * events. Watching a room already watched answers its occupancy again and
	 * takes the new scope and actor. Consumes `pending`, whatever it answers.
	 *
	 * @returns the room's occupancy, or `evicted` or `connection_closed` when
	 *   the watch was refused in flight or its socket closed, or `watch_limit`
	 * @mutates this - records the watch
	 */
	admit_watch(pending: PendingWatch, scope: RoomScope | null = null): RoomResult<RoomOccupancy> {
		const ticket = this.#disarm(pending);
		if (ticket === null) return refuse('evicted');
		const entry = this.#take_pending(ticket);
		if (!entry || entry.kind.type !== 'watch') return refuse('evicted');
		if (entry.refused !== null) return refuse(entry.refused);
		if (scope !== null && entry.poisoned.includes(scope)) return refuse('evicted');
		const { connection_id, room_id } = entry;
		const conn = this.#by_connection.get(connection_id);
		if (!conn || conn.signal.aborted) return refuse('connection_closed');
		if (
			!conn.watches.has(room_id) &&
			conn.watches.size >= this.options.max_watches_per_connection
		) {
			return refuse('watch_limit');
		}
		conn.watches.add(room_id);
		const room = this.#room_entry(room_id);
		const watcher = room.watchers.find((w) => w.connection_id === connection_id);
		if (watcher) {
			watcher.actor_id = entry.actor_id;
			watcher.scope = scope;
		} else {
			room.watchers.push({ connection_id, actor_id: entry.actor_id, scope });
		}
		return ok({ room_id, seq: room.seq, members: members_of(room) });
	}

	/**
	 * Stop the connection's watch of the room. Idempotent. A watch still in
	 * flight is untouched — a client stops one by cancelling its request.
	 *
	 * @returns `true` when it was watching
	 */
	unwatch(connection_id: Uuid, room_id: RoomId): boolean {
		const watching = this.#by_connection.get(connection_id)?.watches.has(room_id) ?? false;
		if (watching) {
			this.#remove(room_id, [], [connection_id], { kind: 'left' });
		}
		return watching;
	}

	/**
	 * Remove the seats and watches `target` names, and refuse its joins and
	 * watches in flight (module doc, "Eviction"). Each removed seat hears
	 * `room_seat_lost`, its room `room_member_left`, each removed watch
	 * `room_watch_ended`, all with `reason`.
	 *
	 * A join in flight has no scope until its verdict, so a scope target marks
	 * it instead, and its admit refuses when its verdict's scope is that one; a
	 * join marked by more scopes than `MAX_POISONED_SCOPES` is refused outright.
	 *
	 * @returns what it removed and reached
	 */
	evict(target: RoomEvictTarget, reason: RoomEvictReason): RoomEvicted {
		const evicted: RoomEvicted = { seats: 0, watches: 0, pending: 0 };

		for (const pending of this.#pending.values()) {
			if (pending.refused !== null) continue;
			switch (target.kind) {
				case 'actor':
					if (pending.actor_id !== target.actor_id) continue;
					pending.refused = 'evicted';
					break;
				case 'room':
					if (pending.room_id !== target.room_id) continue;
					pending.refused = 'evicted';
					break;
				case 'actor_in_scope':
					if (pending.actor_id !== target.actor_id) continue;
					poison(pending, target.scope);
					break;
				case 'scope':
					poison(pending, target.scope);
					break;
			}
			evicted.pending++;
		}

		const room_ids: Array<RoomId> =
			target.kind === 'room' ? [target.room_id] : [...this.#rooms.keys()];
		for (const room_id of room_ids) {
			const room = this.#rooms.get(room_id);
			if (!room) continue;
			const seats = room.seats
				.filter((seat) => target_matches(target, seat.actor_id, seat.scope, room_id))
				.map((seat) => seat.member_id);
			const watchers = room.watchers
				.filter((watcher) => target_matches(target, watcher.actor_id, watcher.scope, room_id))
				.map((watcher) => watcher.connection_id);
			if (seats.length === 0 && watchers.length === 0) continue;
			evicted.seats += seats.length;
			evicted.watches += watchers.length;
			this.#remove(room_id, seats, watchers, { kind: 'evicted', reason });
		}
		return evicted;
	}

	/**
	 * The room's members as of its current `seq`.
	 *
	 * @returns the occupancy, or `null` when no room by that id exists (no seats and no watches)
	 */
	occupancy(room_id: RoomId): RoomOccupancy | null {
		const room = this.#rooms.get(room_id);
		if (!room) return null;
		return { room_id, seq: room.seq, members: members_of(room) };
	}

	/**
	 * Drop every room, seat, watch, and tombstone, telling no one, and refuse
	 * every join and watch in flight (`evicted`). For a test server's reset
	 * between cases; the connections' disconnect listeners stay.
	 *
	 * @mutates this - empties the registry
	 */
	clear(): void {
		this.#rooms.clear();
		this.#seat_of_actor.clear();
		this.#tombstones.clear();
		for (const pending of this.#pending.values()) {
			if (pending.refused === null) pending.refused = 'evicted';
		}
		for (const conn of this.#by_connection.values()) {
			conn.seats.clear();
			conn.watches.clear();
		}
	}

	/**
	 * Connections the registry tracks — each that reserved a seat or watch and
	 * has not closed — each holding the one disconnect listener. For tests and
	 * telemetry.
	 */
	connection_count(): number {
		return this.#by_connection.size;
	}

	/**
	 * The connection's entry, created — with its disconnect listener — on its
	 * first reserve; `null` when the connection is gone or closing.
	 */
	#connection_entry(connection_id: Uuid): ConnectionRooms | null {
		const existing = this.#by_connection.get(connection_id);
		if (existing) return existing.signal.aborted ? null : existing;
		const signal = this.#connections.socket_signal(connection_id);
		if (!signal || signal.aborted) return null;
		// the release runs on the next microtask, as the Rust waiter runs as its
		// own task: a close made inside a fan-out (an overflow) aborts this signal
		// mid-step, and must not re-enter the registry there
		signal.addEventListener(
			'abort',
			() => queueMicrotask(() => this.#release_connection(connection_id)),
			{ once: true }
		);
		const conn: ConnectionRooms = {
			signal,
			seats: new Map(),
			watches: new Set(),
			pending: new Set()
		};
		this.#by_connection.set(connection_id, conn);
		return conn;
	}

	/**
	 * Release everything a closed connection holds: its seats
	 * (`room_member_left` with reason `disconnected`), watches, and joins and
	 * watches in flight.
	 */
	#release_connection(connection_id: Uuid): void {
		const conn = this.#by_connection.get(connection_id);
		if (!conn) return;
		this.#by_connection.delete(connection_id);
		for (const ticket of conn.pending) {
			const pending = this.#pending.get(ticket);
			if (pending && pending.refused === null) pending.refused = 'connection_closed';
		}
		for (const room_id of conn.watches) {
			this.#remove(room_id, [], [connection_id], { kind: 'disconnected' });
		}
		const now = this.#now();
		for (const [room_id, by_actor] of conn.seats) {
			for (const member_id of by_actor.values()) {
				const removed = this.#remove(room_id, [member_id], [], { kind: 'disconnected' });
				if (this.options.exclusive) {
					for (const seat of removed) {
						this.#push_tombstone(seat.actor_id, seat.member_id, now, false);
					}
				}
			}
		}
	}

	/** Put a join or watch in flight on `conn`, and hand `pending` its ticket. */
	#reserve<P extends PendingSeat | PendingWatch>(
		conn: ConnectionRooms,
		kind: PendingKind,
		connection_id: Uuid,
		actor_id: Uuid,
		pending: P
	): P {
		const ticket = ++this.#last_ticket;
		conn.pending.add(ticket);
		this.#pending.set(ticket, {
			kind,
			connection_id,
			actor_id,
			room_id: pending.room_id,
			refused: null,
			poisoned: []
		});
		pending_handles.set(pending, {
			registry: this,
			ticket,
			forget: () => this.#take_pending(ticket)
		});
		return pending;
	}

	/** The room by id, created empty when there is none. */
	#room_entry(room_id: RoomId): Room {
		let room = this.#rooms.get(room_id);
		if (!room) {
			room = { seq: 0, seats: [], watchers: [] };
			this.#rooms.set(room_id, room);
		}
		return room;
	}

	/** Take a pending seat's or watch's ticket for its admit, or `null` when it is withdrawn, spent, or another registry's. */
	#disarm(pending: PendingSeat | PendingWatch): number | null {
		const handle = pending_handles.get(pending);
		if (!handle) return null;
		if (handle.registry !== this) {
			// another registry's: release it there, as a dropped Rust guard would
			withdraw_pending(pending);
			return null;
		}
		if (!handle.forget) return null;
		handle.forget = null;
		return handle.ticket;
	}

	#take_pending(ticket: number): Pending | null {
		const pending = this.#pending.get(ticket);
		if (!pending) return null;
		this.#pending.delete(ticket);
		this.#by_connection.get(pending.connection_id)?.pending.delete(ticket);
		return pending;
	}

	/** Queue one notification for each connection, never waiting. */
	#send(ids: ReadonlySet<Uuid>, method: string, params: unknown): void {
		if (ids.size === 0) return;
		const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
		for (const id of ids) this.#connections.send_to(id, frame);
	}

	/**
	 * Remove seats and watchers from one room, then tell everyone what `why`
	 * says (`Departure`); delete the room if it is left empty.
	 *
	 * @returns the removed seats
	 */
	#remove(
		room_id: RoomId,
		seats: ReadonlyArray<MemberId>,
		watchers: ReadonlyArray<Uuid>,
		why: Departure
	): Array<Seat> {
		const left: RoomLeftReason = why.kind === 'evicted' ? why.reason : why.kind;
		const seat_lost: { reason: RoomSeatLostReason; moved_to: RoomId | null } | null =
			why.kind === 'moved'
				? { reason: 'moved', moved_to: why.to }
				: why.kind === 'evicted'
					? { reason: why.reason, moved_to: null }
					: null;
		const watch_ended = why.kind === 'evicted' ? why.reason : null;
		const room = this.#rooms.get(room_id);
		if (!room) return [];
		const removed_seats = room.seats.filter((seat) => seats.includes(seat.member_id));
		room.seats = room.seats.filter((seat) => !seats.includes(seat.member_id));
		const removed_watchers = room.watchers.filter((w) => watchers.includes(w.connection_id));
		room.watchers = room.watchers.filter((w) => !watchers.includes(w.connection_id));

		// the room's remaining members and watchers hear each departure
		const recipients = recipients_of(room, null);
		for (const seat of removed_seats) {
			const seq = ++room.seq;
			this.#send(recipients, room_member_left_notification_spec.method, {
				room_id,
				seq,
				member_id: seat.member_id,
				reason: left
			} satisfies RoomMemberLeftParams);
			if (seat_lost) {
				this.#send(new Set([seat.connection_id]), room_seat_lost_notification_spec.method, {
					room_id,
					member_id: seat.member_id,
					reason: seat_lost.reason,
					moved_to: seat_lost.moved_to
				} satisfies RoomSeatLostParams);
			}
		}
		if (watch_ended !== null) {
			for (const watcher of removed_watchers) {
				this.#send(new Set([watcher.connection_id]), room_watch_ended_notification_spec.method, {
					room_id,
					reason: watch_ended
				} satisfies RoomWatchEndedParams);
			}
		}
		if (room.seats.length === 0 && room.watchers.length === 0) this.#rooms.delete(room_id);

		for (const seat of removed_seats) {
			const conn = this.#by_connection.get(seat.connection_id);
			if (conn) conn_clear_seat(conn, room_id, seat.actor_id, seat.member_id);
			const actor_seat = this.#seat_of_actor.get(seat.actor_id);
			if (actor_seat?.room_id === room_id && actor_seat.member_id === seat.member_id) {
				this.#seat_of_actor.delete(seat.actor_id);
			}
		}
		for (const watcher of removed_watchers) {
			this.#by_connection.get(watcher.connection_id)?.watches.delete(room_id);
		}
		return removed_seats;
	}

	/** Whether `actor_id`'s seat `member_id` has moved since it ended. */
	#rejoin_moved(actor_id: Uuid, member_id: MemberId, now: number): boolean {
		const tombstones = this.#live_tombstones(actor_id, now);
		return tombstones?.some((t) => t.member_id === member_id && t.moved) ?? false;
	}

	/** Remember a seat of `actor_id` that ended without a leave. */
	#push_tombstone(actor_id: Uuid, member_id: MemberId, now: number, moved: boolean): void {
		const tombstones = (this.#tombstones.get(actor_id) ?? []).filter(
			(t) => !tombstone_expired(t, now)
		);
		tombstones.push({ member_id, at: now, moved });
		while (tombstones.length > ROOM_REJOIN_TOMBSTONES_PER_ACTOR) tombstones.shift();
		this.#tombstones.set(actor_id, tombstones);
		if (this.#tombstones.size > Math.max(this.#tombstone_sweep_at, TOMBSTONE_SWEEP_FLOOR)) {
			for (const [actor, list] of this.#tombstones) {
				const live = list.filter((t) => !tombstone_expired(t, now));
				if (live.length === 0) this.#tombstones.delete(actor);
				else this.#tombstones.set(actor, live);
			}
			this.#tombstone_sweep_at = this.#tombstones.size * 2;
		}
	}

	/**
	 * `actor_id` was just seated (by a rejoin of `rejoin_of`, or fresh): the
	 * rejoined seat's tombstone is spent, and every other seat it lost to a
	 * disconnect now counts as moved.
	 */
	#settle_tombstones(actor_id: Uuid, rejoin_of: MemberId | null, now: number): void {
		const tombstones = this.#live_tombstones(actor_id, now);
		if (!tombstones) return;
		const kept = tombstones.filter((t) => t.member_id !== rejoin_of);
		for (const t of kept) t.moved = true;
		if (kept.length === 0) this.#tombstones.delete(actor_id);
		else this.#tombstones.set(actor_id, kept);
	}

	/** `actor_id`'s unexpired tombstones, pruning the expired ones. */
	#live_tombstones(actor_id: Uuid, now: number): Array<Tombstone> | null {
		const tombstones = this.#tombstones.get(actor_id);
		if (!tombstones) return null;
		const live = tombstones.filter((t) => !tombstone_expired(t, now));
		this.#tombstones.set(actor_id, live);
		return live;
	}
}

const tombstone_expired = (tombstone: Tombstone, now: number): boolean =>
	now - tombstone.at >= ROOM_REJOIN_TOMBSTONE_TTL_MS;
