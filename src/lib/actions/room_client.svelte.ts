/**
 * The frontend side of rooms: `RoomClient` keeps, for each room a page joins
 * or watches, a reactive `RoomState` — its members and their state, the
 * caller's own seat — over the WS-only `room_*` verbs and the `room_*`
 * notifications the server pushes (`actions/room_action_specs.ts`).
 *
 * ## Desired state, converged one request at a time
 *
 * `RoomState.join`, `leave`, `watch`, `unwatch`, and `set_state` record what
 * the page wants; one runner per room then sends whatever requests close the
 * gap, one at a time. The server dispatches a socket's requests concurrently,
 * so a leave sent right after a join could otherwise reach the registry first
 * (and refuse the join as superseded), and two state sets could land out of
 * order. A burst of calls converges: join, leave, join while the first join is
 * in flight sends that one join, whose seat stands; a leave while seated is
 * sent before the next join. While the socket is down nothing is sent and the
 * wants wait for it. `RoomState.send` is the exception: it goes out at once,
 * since a caller that cares about the order of its sends (the WebRTC mesh,
 * `rtc/rtc_mesh.svelte.ts`) serializes them itself.
 *
 * Every verb runs untracked, so a page may call `join` or `watch` from an
 * `$effect` (with `leave` or `unwatch` in its teardown) without the effect
 * depending on the room state the verb reads and writes.
 *
 * Listeners are isolated: one that throws is logged and the others still
 * hear the event, and the join, replay, or teardown that called it carries on.
 *
 * ## `seq`
 *
 * Every member event carries its room's `seq`, and a join or watch answers the
 * room as of a `seq`. Events can arrive before that answer, so while a room's
 * first answer is outstanding they are buffered; the answer's members are
 * applied, then the buffer replays, dropping every event at or below the
 * answer's `seq`. Once a room is live, an event at or below the last applied
 * `seq` is dropped, so a connection that both watches a room and sits in it,
 * which the server tells each event once, applies it once. A later answer
 * whose `seq` is behind the live stream is not applied over it. A message
 * (which reaches only a seat) that arrives on a live watch while the join is
 * in flight is held, and delivered once the seat is taken.
 *
 * ## Seats lost, and reconnects
 *
 * `room_seat_lost` ends a seat the server took: `moved` (a newer join of the
 * same actor took over, `moved_to` naming its room), `evicted`, or
 * `room_closed`. None is rejoined. A socket that closes loses every seat and
 * watch with it, and the client tells them apart: a seat lost to the
 * disconnect is rejoined on the next connection, naming the seat it held
 * (`rejoin_of`), and a refusal as `room_seat_moved` — the actor took a seat
 * elsewhere meanwhile — ends it as moved, so two tabs never trade a seat back
 * and forth. A rejoin refused `rate_limited` is retried after the refusal's
 * `retry_after`, still naming the seat, up to `ROOM_REJOIN_RATE_LIMITED_RETRIES_MAX`
 * times. Watches are taken again.
 *
 * The client learns of a new connection through `RoomRpc.connection`, an
 * identity that changes each time the socket opens. The client follows it on
 * its own: its constructor makes an `$effect.root` whose effect reads it and
 * calls `sync_connection`, so a close and a reopen are seen even when they
 * land in one batch, and `dispose` ends it. On the server the compiler makes
 * `$effect.root` a no-op, and nothing follows; `sync_connection` stays public
 * for that case and for tests, and runs on its own before each request and
 * notification.
 *
 * ```ts
 * const rooms = new RoomClient(create_room_rpc(socket));
 * ```
 *
 * Notifications reach the client through `receive`, from the RPC client's
 * `lookup_action_handler` for the `'receive'` phase (with
 * `room_notification_action_specs` among the RPC client's specs):
 *
 * ```ts
 * lookup_action_handler: (method, phase) =>
 *   phase === 'receive' && is_room_notification_method(method)
 *     ? (event) => rooms.receive(method, event.data.input)
 *     : undefined
 * ```
 *
 * `dispose` leaves every seat and drops every watch, for a clean teardown.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import { parse, type Infer, type Schema } from '@fuzdev/fuz_schema/schema.ts';
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

import type { Uuid } from '../primitive_schemas.ts';
import type { JsonrpcErrorObject, JsonrpcRequestId } from '../http/jsonrpc.ts';
import {
	JSONRPC_ERROR_CODES,
	jsonrpc_error_messages,
	to_thrown_jsonrpc_error
} from '../http/jsonrpc_errors.ts';
import { safe_parse_dropping_unknown_keys } from '../http/schema_helpers.ts';
import {
	ERROR_ROOM_JOIN_SUPERSEDED,
	ERROR_ROOM_NOT_JOINED,
	ERROR_ROOM_SEAT_MOVED,
	RoomJoinOutput,
	RoomLeaveOutput,
	RoomMemberJoinedParams,
	RoomMemberLeftParams,
	RoomMemberStateParams,
	RoomMessageParams,
	RoomOccupancy,
	RoomSeatLostParams,
	RoomStateSetOutput,
	RoomUnwatchOutput,
	RoomWatchEndedParams,
	room_join_action_spec,
	room_leave_action_spec,
	room_member_joined_notification_spec,
	room_member_left_notification_spec,
	room_member_state_notification_spec,
	room_message_notification_spec,
	room_seat_lost_notification_spec,
	room_send_action_spec,
	room_state_set_action_spec,
	room_unwatch_action_spec,
	room_watch_action_spec,
	room_watch_ended_notification_spec,
	type MemberId,
	type RoomEvictReason,
	type RoomId,
	type RoomIdInput,
	type RoomJoinInput,
	type RoomLeftReason,
	type RoomMember,
	type RoomSeatLostReason,
	type RoomSendInput,
	type RoomStateSetInput,
	type RoomTopology
} from './room_action_specs.ts';

// -- The verbs ------------------------------------------------------------------

/** A room verb's answer: its output, or the JSON-RPC error that refused it. */
export type RoomRpcResult<T> = Result<{ value: T }, { error: JsonrpcErrorObject }>;

/**
 * The room verbs over one socket, and the socket's identity — what
 * `RoomClient` needs of the connection. `create_room_rpc` builds it over a
 * `FrontendWebsocketClient`; a test passes a fake.
 */
export interface RoomRpc {
	room_join: (input: RoomJoinInput) => Promise<RoomRpcResult<RoomJoinOutput>>;
	room_leave: (input: RoomIdInput) => Promise<RoomRpcResult<RoomLeaveOutput>>;
	room_send: (input: RoomSendInput) => Promise<RoomRpcResult<null>>;
	room_state_set: (input: RoomStateSetInput) => Promise<RoomRpcResult<RoomStateSetOutput>>;
	room_watch: (input: RoomIdInput) => Promise<RoomRpcResult<RoomOccupancy>>;
	room_unwatch: (input: RoomIdInput) => Promise<RoomRpcResult<RoomUnwatchOutput>>;
	/**
	 * The open connection — a value that changes each time the socket opens,
	 * compared by identity — or `null` while the socket is down. Seats and
	 * watches belong to one connection; when this changes they are gone.
	 * Reactive when it reads reactive state, so an `$effect` calling
	 * `RoomClient.sync_connection` reruns on a change.
	 */
	readonly connection: object | null;
}

/**
 * What `create_room_rpc` needs of the socket — a `FrontendWebsocketClient`
 * satisfies it. `ws` is the current `WebSocket`, a new one per connection.
 */
export interface RoomRpcSocket {
	readonly connected: boolean;
	readonly ws: object | null;
	request: (
		method: string,
		params: unknown,
		options?: { signal?: AbortSignal; queue?: boolean; id?: JsonrpcRequestId }
	) => Promise<unknown>;
}

/**
 * The room verbs straight over the socket's `request`, never through the RPC
 * client's transports: those fall back to HTTP while the socket is down, and
 * the room verbs are mounted only on a WebSocket endpoint. A request is never
 * queued — while the socket is down it fails at once, and `RoomClient` sends
 * it again on the next connection. Answers are parsed with the verbs' output
 * schemas, forward-compatibly as the RPC client reads a remote result (keys a
 * newer server added are dropped, `safe_parse_dropping_unknown_keys`); one
 * that still doesn't parse is an `internal_error`.
 *
 * @param socket - the socket the room verbs go over
 * @returns the verbs, and `connection` — the open `WebSocket`, else `null`
 */
export const create_room_rpc = (socket: RoomRpcSocket): RoomRpc => {
	const call =
		<T>(method: string, output: Schema) =>
		async (input: unknown): Promise<RoomRpcResult<T>> => {
			let result: unknown;
			try {
				result = await socket.request(method, input, { queue: false });
			} catch (error) {
				return {
					ok: false,
					error:
						to_thrown_jsonrpc_error(error) ??
						jsonrpc_error_messages.internal_error(to_error_message(error))
				};
			}
			const parsed = safe_parse_dropping_unknown_keys(output, result);
			if (!parsed.ok) {
				return {
					ok: false,
					error: jsonrpc_error_messages.internal_error(`${method}: malformed answer`)
				};
			}
			return { ok: true, value: parsed.value as T };
		};
	return {
		room_join: call(room_join_action_spec.method, room_join_action_spec.output),
		room_leave: call(room_leave_action_spec.method, room_leave_action_spec.output),
		room_send: call(room_send_action_spec.method, room_send_action_spec.output),
		room_state_set: call(room_state_set_action_spec.method, room_state_set_action_spec.output),
		room_watch: call(room_watch_action_spec.method, room_watch_action_spec.output),
		room_unwatch: call(room_unwatch_action_spec.method, room_unwatch_action_spec.output),
		get connection() {
			return socket.connected ? socket.ws : null;
		}
	};
};

const ROOM_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
	room_member_joined_notification_spec.method,
	room_member_left_notification_spec.method,
	room_member_state_notification_spec.method,
	room_message_notification_spec.method,
	room_seat_lost_notification_spec.method,
	room_watch_ended_notification_spec.method
]);

/** Whether `method` is one of the `room_*` notifications `RoomClient.receive` takes. */
export const is_room_notification_method = (method: string): boolean =>
	ROOM_NOTIFICATION_METHODS.has(method);

// -- Room state -----------------------------------------------------------------

/** The caller's seat in a room, from the join's answer. */
export interface RoomSeat {
	room_id: RoomId;
	member_id: MemberId;
	topology: RoomTopology;
	/** The consumer's `join_extra` value (ICE servers, say), `null` without one. */
	extra: unknown;
}

/** Why the server ended the caller's seat — `room_seat_lost`, or a rejoin refused as moved. */
export interface RoomSeatEnded {
	reason: RoomSeatLostReason;
	/** The room a `moved` seat moved to, `null` when not known (a rejoin refused as moved). */
	moved_to: RoomId | null;
}

/**
 * Why a seat ended, as `RoomListener.unseated` hears it: the caller left, the
 * socket closed (`disconnected`, rejoined on the next connection), the server
 * ended it (`RoomSeatLostReason`), or the client was disposed (`closed`).
 */
export type RoomUnseatedReason = 'left' | 'disconnected' | 'closed' | RoomSeatLostReason;

/**
 * Where a room's seat stands: `idle` (not wanted), `joining`, `rejoining` (a
 * seat lost to a disconnect, waiting to be taken again), `joined`.
 */
export type RoomSeatStatus = 'idle' | 'joining' | 'rejoining' | 'joined';

/**
 * A subscriber to one room's events, in `seq` order, except a message held
 * for a join in flight, which is heard once the seat is taken, after the
 * member events that passed it. Member events come
 * through a seat or a watch alike; `seated` and `unseated` bracket a seat, and
 * `message` reaches only a seat. Every member is the room's own value, the
 * same one `RoomState.members` holds.
 */
export interface RoomListener {
	/** A seat was taken — `RoomState.members` already holds the room as of the answer. */
	seated?: (seat: RoomSeat) => void;
	/** The seat ended. */
	unseated?: (seat: RoomSeat, reason: RoomUnseatedReason) => void;
	member_joined?: (member: RoomMember) => void;
	member_left?: (member_id: MemberId, reason: RoomLeftReason) => void;
	member_state?: (member: RoomMember) => void;
	message?: (message: RoomMessageParams) => void;
}

/** Options for `RoomState.join`. */
export interface RoomJoinOptions {
	/**
	 * The member state to join with, kept as `RoomState.local_state`; omitted,
	 * the state set last (or none).
	 */
	state?: string;
}

/** Options for `RoomClient`. */
export interface RoomClientOptions {
	/**
	 * The actor every verb acts as, on a multi-actor account (the `acting`
	 * selector); omitted, the account's default actor. One client serves one
	 * actor: the server tells a connection each event once, whichever of its
	 * actors it concerns.
	 */
	acting?: Uuid;
	/** Where dispatch diagnostics go; `null` or omitted, nowhere. */
	log?: Logger | null;
	/** `setTimeout`, for a rate-limited rejoin's wait; omitted, the global. */
	set_timeout?: (callback: () => void, ms: number) => unknown;
	/** `clearTimeout`, given what `set_timeout` returned; omitted, the global. */
	clear_timeout?: (handle: unknown) => void;
}

/**
 * How many times a rejoin refused `rate_limited` is retried, each after the
 * refusal's `retry_after`, before the seat is given up as refused.
 */
export const ROOM_REJOIN_RATE_LIMITED_RETRIES_MAX = 3;

/** The wait before a rate-limited rejoin's retry when the refusal names none. */
const REJOIN_RETRY_AFTER_FALLBACK_SECONDS = 1;

/** A buffered or live member event. */
type RoomEvent =
	| { method: 'room_member_joined'; params: RoomMemberJoinedParams }
	| { method: 'room_member_left'; params: RoomMemberLeftParams }
	| { method: 'room_member_state'; params: RoomMemberStateParams }
	| { method: 'room_message'; params: RoomMessageParams };

const not_joined_error = (room_id: RoomId): JsonrpcErrorObject =>
	jsonrpc_error_messages.conflict(`not seated in room ${room_id}`, {
		reason: ERROR_ROOM_NOT_JOINED
	});

const join_superseded_error = (room_id: RoomId): JsonrpcErrorObject =>
	jsonrpc_error_messages.conflict(`the join of room ${room_id} was left before it was seated`, {
		reason: ERROR_ROOM_JOIN_SUPERSEDED
	});

const error_data_field = (error: JsonrpcErrorObject, key: string): unknown =>
	error.data !== null && typeof error.data === 'object'
		? (error.data as Record<string, unknown>)[key]
		: undefined;

const error_reason = (error: JsonrpcErrorObject): unknown => error_data_field(error, 'reason');

/** A `rate_limited` refusal's wait in milliseconds, else `null`. */
const rate_limited_wait_ms = (error: JsonrpcErrorObject): number | null => {
	if (error.code !== JSONRPC_ERROR_CODES.rate_limited) return null;
	const retry_after = error_data_field(error, 'retry_after');
	const seconds =
		typeof retry_after === 'number' && Number.isFinite(retry_after) && retry_after > 0
			? retry_after
			: REJOIN_RETRY_AFTER_FALLBACK_SECONDS;
	return seconds * 1000;
};

/** What a `RoomState` needs of its `RoomClient`. */
interface RoomHost {
	readonly rpc: RoomRpc;
	readonly acting: Uuid | undefined;
	readonly log: Logger | null;
	set_timeout: (callback: () => void, ms: number) => unknown;
	clear_timeout: (handle: unknown) => void;
	is_disposed: () => boolean;
	/** The open connection the rooms live on, after a sync, or `null` while the socket is down. */
	live_connection: () => object | null;
	/** Hand the client the room's inbound side. */
	attach: (room_id: RoomId, port: RoomPort) => void;
}

/** A room's inbound side, which only its `RoomClient` calls. */
interface RoomPort {
	event: (event: RoomEvent) => void;
	seat_lost: (params: RoomSeatLostParams) => void;
	watch_ended: (params: RoomWatchEndedParams) => void;
	/** The connection the seat and watch lived on is gone. */
	connection_lost: () => void;
	kick: () => void;
	dispose: () => Promise<void>;
}

/**
 * One room as the client sees it: the members (through a seat, a watch, or
 * both), the caller's seat, and what the page wants of it. Built by
 * `RoomClient.room`; every verb here records a want and lets the room's runner
 * converge on it (see the module doc).
 */
export class RoomState {
	readonly room_id: RoomId;

	/** The room's members in seating order, the caller's own seat included; empty until a seat or watch answers. */
	members: ReadonlyArray<RoomMember> = $state.raw([]);
	/** The caller's seat, or `null`. */
	seat: RoomSeat | null = $state.raw(null);
	/** Whether a watch is live — the server answered it and hasn't ended it. */
	watching: boolean = $state.raw(false);
	/** Why the server last ended the seat; cleared by the next `join`. */
	ended: RoomSeatEnded | null = $state.raw(null);
	/** Why the server last ended the watch; cleared by the next `watch`. */
	watch_ended: RoomEvictReason | null = $state.raw(null);
	/** The last refusal of a verb in this room, `null` once one succeeds. */
	error: JsonrpcErrorObject | null = $state.raw(null);
	/** The member state the caller wants, sent with the join and with every change while seated. */
	local_state: string | null = $state.raw(null);
	/** Whether a seat is wanted. */
	want_seat: boolean = $state.raw(false);
	/** Whether a watch is wanted. */
	want_watch: boolean = $state.raw(false);

	/** The seat this room rejoins on the next connection, after a disconnect took it. */
	rejoin_of: MemberId | null = $state.raw(null);

	/**
	 * Where the seat stands. A getter, not a `$derived`: a room outlives the
	 * effect that first asked for it, and a `$derived` would freeze with it.
	 */
	get seat_status(): RoomSeatStatus {
		return !this.want_seat
			? 'idle'
			: this.seat
				? 'joined'
				: this.rejoin_of !== null
					? 'rejoining'
					: 'joining';
	}

	readonly #host: RoomHost;
	readonly #listeners: Set<RoomListener> = new Set();

	/** The last applied `seq`, `null` while nothing is live. */
	#seq: number | null = null;
	/** Events that arrived before the first answer. */
	#buffer: Array<RoomEvent> = [];
	/** Join and watch requests in flight, whose answers will make the room live. */
	#awaiting = 0;
	/** Messages that reached a live watch while the join was in flight, for the seat it takes. */
	#held_messages: Array<RoomEvent> = [];
	/** The wait before a rate-limited rejoin's retry, while one is pending. */
	#retry_timer: unknown = null;
	/** Rate-limited retries since the connection last changed, which starts every rejoin. */
	#retry_attempts = 0;

	#leave_owed = false;
	#unwatch_owed = false;
	/** The member state the server holds for the seat. */
	#state_sent: string | null = null;

	#running = false;
	#dirty = false;
	#idle_waiters: Array<() => void> = [];
	#join_waiters: Array<(result: RoomRpcResult<RoomSeat>) => void> = [];

	/** Built by `RoomClient.room`. */
	constructor(host: RoomHost, room_id: RoomId) {
		this.#host = host;
		this.room_id = room_id;
		host.attach(room_id, {
			event: (event) => this.#event(event),
			seat_lost: (params) => this.#seat_lost(params),
			watch_ended: (params) => this.#watch_ended(params),
			connection_lost: () => this.#connection_lost(),
			kick: () => this.#kick(),
			dispose: () => this.#dispose()
		});
	}

	/**
	 * Subscribe to the room's events.
	 *
	 * @returns the remover
	 */
	add_listener(listener: RoomListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Want a seat. Resolves once it is taken (at once when it already is), or
	 * with the refusal; a `leave` before it is taken resolves it as
	 * `room_join_superseded`. While the socket is down it waits for the next
	 * connection.
	 *
	 * @returns the seat, or why there is none
	 */
	join(options?: RoomJoinOptions): Promise<RoomRpcResult<RoomSeat>> {
		return untrack(() => this.#join(options));
	}

	#join(options: RoomJoinOptions | undefined): Promise<RoomRpcResult<RoomSeat>> {
		if (this.#host.is_disposed()) {
			return Promise.resolve({ ok: false, error: join_superseded_error(this.room_id) });
		}
		if (options?.state !== undefined) this.local_state = options.state;
		if (this.seat && this.want_seat) {
			this.#kick(); // a changed state
			return Promise.resolve({ ok: true, value: this.seat });
		}
		this.want_seat = true;
		this.ended = null;
		this.error = null;
		const answer = new Promise<RoomRpcResult<RoomSeat>>((resolve) => {
			this.#join_waiters.push(resolve);
		});
		this.#kick();
		return answer;
	}

	/**
	 * Stop wanting the seat: it ends here at once (`unseated` with `left`), and
	 * the server hears a `room_leave` once the socket allows. A rejoin waiting
	 * on a reconnect is dropped.
	 *
	 * @returns resolves once the room's requests have settled
	 */
	leave(): Promise<void> {
		return untrack(() => this.#leave());
	}

	#leave(): Promise<void> {
		this.want_seat = false;
		this.rejoin_of = null;
		this.#clear_retry();
		this.#resolve_join_waiters({ ok: false, error: join_superseded_error(this.room_id) });
		const seat = this.seat;
		if (seat) {
			this.#leave_owed = true;
			this.#end_seat(seat, 'left');
		}
		this.#kick();
		return this.#settled();
	}

	/**
	 * Want a watch: the members without a seat. A watch the server ends
	 * (`room_watch_ended`) is not taken again.
	 *
	 * @returns resolves once the room's requests have settled
	 */
	watch(): Promise<void> {
		return untrack(() => this.#watch());
	}

	#watch(): Promise<void> {
		if (this.#host.is_disposed()) return Promise.resolve();
		this.want_watch = true;
		this.watch_ended = null;
		this.#kick();
		return this.#settled();
	}

	/**
	 * Stop wanting the watch.
	 *
	 * @returns resolves once the room's requests have settled
	 */
	unwatch(): Promise<void> {
		return untrack(() => this.#unwatch());
	}

	#unwatch(): Promise<void> {
		this.want_watch = false;
		if (this.watching) {
			this.watching = false;
			this.#unwatch_owed = true;
			if (!this.seat) this.#reset_stream();
		}
		this.#kick();
		return this.#settled();
	}

	/**
	 * Set the caller's member state: sent now when seated, else with the next
	 * join. Only the latest state is sent; a burst sends at most one per
	 * answer.
	 *
	 * @returns resolves once the room's requests have settled
	 */
	set_state(state: string): Promise<void> {
		return untrack(() => {
			this.local_state = state;
			this.#kick();
			return this.#settled();
		});
	}

	/**
	 * Relay `payload` to one member (`to`), or to every other member (`null`).
	 * Sent at once, never ordered against other sends: a caller that needs an
	 * order waits for each answer before the next send.
	 *
	 * @returns `null`, or the refusal — `room_not_joined` without a seat
	 */
	send(to: MemberId | null, payload: string): Promise<RoomRpcResult<null>> {
		return untrack(() => {
			// a seat on a connection that has since closed is gone
			if (this.#host.live_connection() === null || !this.seat) {
				return Promise.resolve({ ok: false, error: not_joined_error(this.room_id) });
			}
			return this.#host.rpc.room_send({
				room_id: this.room_id,
				to,
				payload,
				acting: this.#host.acting
			});
		});
	}

	// -- Inbound ------------------------------------------------------------------

	#event(event: RoomEvent): void {
		if (this.#seq === null) {
			if (this.#awaiting > 0) this.#buffer.push(event);
			return;
		}
		if (event.params.seq <= this.#seq) return;
		this.#seq = event.params.seq;
		if (event.method === 'room_message' && this.want_seat && !this.seat && this.#awaiting > 0) {
			// live through a watch, and the join that takes the seat it's for is in flight
			this.#held_messages.push(event);
			return;
		}
		this.#apply(event);
	}

	#seat_lost(params: RoomSeatLostParams): void {
		const seat = this.seat;
		if (!seat || seat.member_id !== params.member_id) return;
		this.want_seat = false;
		this.rejoin_of = null;
		this.#clear_retry();
		this.ended = { reason: params.reason, moved_to: params.moved_to };
		this.#end_seat(seat, params.reason);
	}

	#watch_ended(params: RoomWatchEndedParams): void {
		if (!this.watching) return;
		this.watching = false;
		this.want_watch = false;
		this.watch_ended = params.reason;
		if (!this.seat) this.#reset_stream();
	}

	/**
	 * The connection the seat and watch lived on is gone: the server released
	 * both. A wanted seat is rejoined, naming the lost one.
	 */
	#connection_lost(): void {
		const seat = this.seat;
		this.#leave_owed = false;
		this.#unwatch_owed = false;
		this.#state_sent = null;
		this.watching = false;
		// a new connection is a fresh budget: its rejoin goes out at once
		this.#clear_retry();
		this.#retry_attempts = 0;
		if (seat) {
			if (this.want_seat) this.rejoin_of = seat.member_id;
			this.#end_seat(seat, 'disconnected');
		} else {
			this.#reset_stream();
		}
	}

	#dispose(): Promise<void> {
		this.want_watch = false;
		this.want_seat = false;
		this.rejoin_of = null;
		this.#clear_retry();
		this.#resolve_join_waiters({ ok: false, error: join_superseded_error(this.room_id) });
		const seat = this.seat;
		if (seat) {
			this.#leave_owed = true;
			this.#end_seat(seat, 'closed');
		}
		if (this.watching) {
			this.watching = false;
			this.#unwatch_owed = true;
			this.#reset_stream();
		}
		this.#kick();
		return this.#settled();
	}

	#apply(event: RoomEvent): void {
		switch (event.method) {
			case 'room_member_joined': {
				const { member } = event.params;
				this.members = [...this.members.filter((m) => m.member_id !== member.member_id), member];
				this.#emit('member_joined', member);
				break;
			}
			case 'room_member_left': {
				const { member_id, reason } = event.params;
				this.members = this.members.filter((m) => m.member_id !== member_id);
				this.#emit('member_left', member_id, reason);
				break;
			}
			case 'room_member_state': {
				const member = this.#set_member_state(event.params.member_id, event.params.state);
				if (member) this.#emit('member_state', member);
				break;
			}
			case 'room_message': {
				if (!this.seat) return;
				this.#emit('message', event.params);
				break;
			}
		}
	}

	#set_member_state(member_id: MemberId, state: string | null): RoomMember | null {
		let updated: RoomMember | null = null;
		this.members = this.members.map((m) => {
			if (m.member_id !== member_id) return m;
			updated = { ...m, state };
			return updated;
		});
		return updated;
	}

	/** Apply a join's or watch's answer, then replay what arrived before it. */
	#apply_snapshot(seq: number, members: ReadonlyArray<RoomMember>): void {
		if (this.#seq === null || seq > this.#seq) {
			this.#seq = seq;
			this.members = members;
		}
	}

	#replay_buffer(): void {
		const buffered = this.#buffer;
		this.#buffer = [];
		for (const event of buffered) this.#event(event);
	}

	#end_seat(seat: RoomSeat, reason: RoomUnseatedReason): void {
		this.seat = null;
		this.#state_sent = null;
		if (!this.watching) this.#reset_stream();
		this.#emit('unseated', seat, reason);
	}

	/**
	 * Call each listener's `name` handler, catching and logging a throw, so one
	 * listener can't stop the others, or the join, replay, or teardown that
	 * emitted.
	 */
	#emit<K extends keyof RoomListener>(
		name: K,
		...args: Parameters<NonNullable<RoomListener[K]>>
	): void {
		for (const listener of this.#listeners) {
			const handler = listener[name] as ((...a: typeof args) => void) | undefined;
			if (!handler) continue;
			try {
				handler.apply(listener, args);
			} catch (error) {
				this.#host.log?.error('[room_client] listener failed:', this.room_id, name, error);
			}
		}
	}

	#clear_retry(): void {
		if (this.#retry_timer === null) return;
		this.#host.clear_timeout(this.#retry_timer);
		this.#retry_timer = null;
	}

	/** Nothing is live: forget the members and the stream position. */
	#reset_stream(): void {
		this.#seq = null;
		this.#buffer = [];
		this.members = [];
	}

	#resolve_join_waiters(result: RoomRpcResult<RoomSeat>): void {
		const waiters = this.#join_waiters;
		this.#join_waiters = [];
		for (const resolve of waiters) resolve(result);
	}

	// -- The runner ---------------------------------------------------------------

	#settled(): Promise<void> {
		if (!this.#running) return Promise.resolve();
		return new Promise((resolve) => this.#idle_waiters.push(resolve));
	}

	#kick(): void {
		if (this.#running) {
			this.#dirty = true;
			return;
		}
		void this.#run();
	}

	async #run(): Promise<void> {
		this.#running = true;
		try {
			for (;;) {
				this.#dirty = false;
				const connection = this.#host.live_connection();
				if (connection === null) break;
				const sent = await this.#step(connection);
				if (!sent && !this.#dirty) break;
			}
		} catch (error) {
			this.#host.log?.error('[room_client] runner failed:', this.room_id, error);
		} finally {
			this.#running = false;
			const waiters = this.#idle_waiters;
			this.#idle_waiters = [];
			for (const resolve of waiters) resolve();
		}
	}

	/** Send the one request that most closes the gap, if any. @returns whether one was sent */
	async #step(connection: object): Promise<boolean> {
		const host = this.#host;
		const acting = host.acting;
		const room_id = this.room_id;
		const lost = (): boolean => host.live_connection() !== connection;

		if (this.#leave_owed) {
			this.#leave_owed = false;
			const result = await host.rpc.room_leave({ room_id, acting });
			if (!result.ok && !lost()) host.log?.warn('[room_client] leave refused:', result.error);
			return true;
		}

		if (this.#unwatch_owed) {
			this.#unwatch_owed = false;
			const result = await host.rpc.room_unwatch({ room_id, acting });
			if (!result.ok && !lost()) host.log?.warn('[room_client] unwatch refused:', result.error);
			return true;
		}

		if (this.want_seat && !this.seat && this.#retry_timer === null) {
			const state = this.local_state ?? undefined;
			const rejoin_of = this.rejoin_of ?? undefined;
			this.#awaiting++;
			let result: RoomRpcResult<RoomJoinOutput>;
			try {
				result = await host.rpc.room_join({ room_id, state, rejoin_of, acting });
			} finally {
				this.#awaiting--;
			}
			const held = this.#held_messages;
			this.#held_messages = [];
			if (lost()) {
				// seated on a connection that has since closed: the next one rejoins it
				if (result.ok && this.want_seat) this.rejoin_of = result.value.member_id;
				if (this.#seq === null) this.#buffer = [];
				return true;
			}
			if (!result.ok) {
				if (this.#seq === null && this.#awaiting === 0) this.#buffer = [];
				if (!this.want_seat) return true; // left meanwhile, already resolved
				const wait_ms = this.rejoin_of !== null ? rate_limited_wait_ms(result.error) : null;
				if (wait_ms !== null && this.#retry_attempts < ROOM_REJOIN_RATE_LIMITED_RETRIES_MAX) {
					// still rejoining, naming the same seat, once the limiter allows
					this.#retry_attempts++;
					this.error = result.error;
					this.#retry_timer = host.set_timeout(() => {
						this.#retry_timer = null;
						this.#kick();
					}, wait_ms);
					return true;
				}
				this.want_seat = false;
				this.rejoin_of = null;
				this.error = result.error;
				if (error_reason(result.error) === ERROR_ROOM_SEAT_MOVED) {
					this.ended = { reason: 'moved', moved_to: null };
				}
				this.#resolve_join_waiters({ ok: false, error: result.error });
				return true;
			}
			const { value } = result;
			if (!this.want_seat) {
				// left while the join was in flight
				this.#leave_owed = true;
				if (this.#seq === null && this.#awaiting === 0) this.#buffer = [];
				return true;
			}
			const seat: RoomSeat = {
				room_id,
				member_id: value.member_id,
				topology: value.topology,
				extra: value.extra
			};
			this.rejoin_of = null;
			this.error = null;
			this.#state_sent = state ?? null;
			this.#apply_snapshot(value.seq, value.members);
			this.seat = seat;
			this.#emit('seated', seat);
			this.#replay_buffer();
			for (const event of held) this.#apply(event);
			this.#resolve_join_waiters({ ok: true, value: seat });
			return true;
		}

		if (this.want_watch && !this.watching) {
			this.#awaiting++;
			let result: RoomRpcResult<RoomOccupancy>;
			try {
				result = await host.rpc.room_watch({ room_id, acting });
			} finally {
				this.#awaiting--;
			}
			if (lost()) {
				if (this.#seq === null) this.#buffer = [];
				return true;
			}
			if (!result.ok) {
				if (this.#seq === null && this.#awaiting === 0) this.#buffer = [];
				this.want_watch = false;
				this.error = result.error;
				return true;
			}
			if (!this.want_watch) {
				this.#unwatch_owed = true;
				if (this.#seq === null && this.#awaiting === 0) this.#buffer = [];
				return true;
			}
			this.error = null;
			this.#apply_snapshot(result.value.seq, result.value.members);
			this.watching = true;
			this.#replay_buffer();
			return true;
		}

		const seat = this.seat;
		const state = this.local_state;
		if (seat && state !== null && state !== this.#state_sent) {
			const result = await host.rpc.room_state_set({ room_id, state, acting });
			if (lost()) return true;
			// recorded as sent either way, so a refused state isn't sent again in a loop
			this.#state_sent = state;
			if (!result.ok) {
				this.error = result.error;
				return true;
			}
			this.error = null;
			// the server tells the other members, not the seat that set it
			if (this.seat === seat) {
				const member = this.#set_member_state(seat.member_id, state);
				if (member) this.#emit('member_state', member);
			}
			return true;
		}

		return false;
	}
}

/**
 * The rooms one page joins and watches over one socket, for one actor. See the
 * module doc for the wiring: the client follows the connection on its own, and
 * `receive` takes the RPC client's room notifications.
 */
export class RoomClient {
	readonly rpc: RoomRpc;
	readonly acting: Uuid | undefined;
	readonly log: Logger | null;

	/** Every room this client has touched, by id. */
	readonly rooms: SvelteMap<RoomId, RoomState> = new SvelteMap();

	/** Whether `dispose` was called; the verbs then do nothing. */
	disposed: boolean = $state.raw(false);

	/** The connection the rooms' seats and watches live on. */
	#connection: object | null = null;
	readonly #ports: Map<RoomId, RoomPort> = new Map();
	readonly #host: RoomHost;
	/** Ends the effect that follows `rpc.connection`. */
	readonly #stop_following: () => void;

	constructor(rpc: RoomRpc, options?: RoomClientOptions) {
		this.rpc = rpc;
		this.acting = options?.acting;
		this.log = options?.log ?? null;
		this.#host = {
			rpc,
			acting: this.acting,
			log: this.log,
			set_timeout: options?.set_timeout ?? ((callback, ms) => setTimeout(callback, ms)),
			clear_timeout:
				options?.clear_timeout ??
				((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
			is_disposed: () => this.disposed,
			live_connection: () => {
				this.sync_connection();
				return this.#connection;
			},
			attach: (room_id, port) => {
				this.#ports.set(room_id, port);
			}
		};
		// follow the connection, so a close and a reopen in one batch are still seen;
		// on the server the compiler makes this a no-op
		this.#stop_following = $effect.root(() => {
			$effect(() => this.sync_connection());
		});
	}

	/**
	 * The room by id, created on first use. A `$derived` or a template may ask
	 * for one it hasn't made yet, but Svelte doesn't track state made in the
	 * reaction reading it: a `$derived` that makes the room and reads its state
	 * in one expression (`client.room(id).seat_status`) never updates. Ask in
	 * one `$derived` and read in another, or make the room beforehand.
	 *
	 * @returns the room's state
	 */
	room(room_id: RoomId): RoomState {
		const room = this.rooms.get(room_id);
		if (room) return room;
		// untracked, so a reaction may make a room without writing state it tracks
		return untrack(() => {
			const created = new RoomState(this.#host, room_id);
			this.rooms.set(room_id, created);
			return created;
		});
	}

	/**
	 * Read `RoomRpc.connection`, and when it changed since the last read, drop
	 * every seat and watch the old connection held (seats lost this way are
	 * rejoined), then converge every room over the new one. The client's own
	 * effect calls it whenever the connection changes, and it runs on its own
	 * before each request and notification; only `rpc.connection` is read
	 * tracked.
	 *
	 * @mutates this - every room, when the connection changed
	 */
	sync_connection(): void {
		const connection = this.rpc.connection;
		untrack(() => this.#sync(connection));
	}

	#sync(connection: object | null): void {
		if (connection === this.#connection) return;
		const previous = this.#connection;
		this.#connection = connection;
		if (previous !== null) {
			for (const port of this.#ports.values()) port.connection_lost();
		}
		if (connection !== null && !this.disposed) {
			for (const port of this.#ports.values()) port.kick();
		}
	}

	/**
	 * Take a pushed notification. A room notification is parsed with its
	 * params schema and routed to its room; one for a room this client doesn't
	 * hold is dropped.
	 *
	 * @param method - the notification's method
	 * @param params - its params, unparsed
	 * @returns whether `method` is a room notification
	 */
	receive(method: string, params: unknown): boolean {
		if (!is_room_notification_method(method)) return false;
		if (this.disposed) return true;
		this.sync_connection();
		switch (method) {
			case 'room_member_joined': {
				const p = this.#parse(method, RoomMemberJoinedParams, params);
				if (p) this.#ports.get(p.room_id)?.event({ method, params: p });
				break;
			}
			case 'room_member_left': {
				const p = this.#parse(method, RoomMemberLeftParams, params);
				if (p) this.#ports.get(p.room_id)?.event({ method, params: p });
				break;
			}
			case 'room_member_state': {
				const p = this.#parse(method, RoomMemberStateParams, params);
				if (p) this.#ports.get(p.room_id)?.event({ method, params: p });
				break;
			}
			case 'room_message': {
				const p = this.#parse(method, RoomMessageParams, params);
				if (p) this.#ports.get(p.room_id)?.event({ method, params: p });
				break;
			}
			case 'room_seat_lost': {
				const p = this.#parse(method, RoomSeatLostParams, params);
				if (p) this.#ports.get(p.room_id)?.seat_lost(p);
				break;
			}
			case 'room_watch_ended': {
				const p = this.#parse(method, RoomWatchEndedParams, params);
				if (p) this.#ports.get(p.room_id)?.watch_ended(p);
				break;
			}
		}
		return true;
	}

	/**
	 * Leave every seat and drop every watch, stop following the connection,
	 * then refuse further use. The leaves still go out: each request syncs the
	 * connection on its own.
	 *
	 * @returns resolves once the leaves have been answered (or the socket is down)
	 * @mutates this - sets `disposed`
	 */
	dispose(): Promise<void> {
		return untrack(async () => {
			if (this.disposed) return;
			this.disposed = true;
			this.#stop_following();
			await Promise.all([...this.#ports.values()].map((port) => port.dispose()));
		});
	}

	#parse<S extends Schema>(method: string, schema: S, params: unknown): Infer<S> | null {
		const parsed = parse(schema, params);
		if (!parsed.ok) {
			this.log?.warn('[room_client] malformed notification:', method);
			return null;
		}
		return parsed.value;
	}
}
