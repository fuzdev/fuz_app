/**
 * The room verbs over `RoomRegistry` (`actions/room_registry.ts`): join,
 * leave, send, state, watch, and unwatch, as actions a consumer mounts on a
 * WebSocket endpoint — the TS twin of the Rust spine's `fuz_actions::room`.
 *
 * `create_room_actions` returns the handlers over the specs of
 * `actions/room_action_specs.ts`. Each is WebSocket-only — mount them on a
 * `ws_endpoints` entry, never on an RPC endpoint (a room belongs to a socket;
 * the Rust spine answers them `method_not_found` over HTTP, and a handler
 * reached without a connection answers the same) — actor-required, and
 * without side effects: the registry is memory, not the database, so no
 * transaction opens for a relayed message. The registry does the work and the
 * fan-out; this module parses, bounds, authorizes, and limits.
 *
 * Seats are keyed by connection and actor: under the dispatcher's `acting`
 * selector, a leave, send, or state set acts on the acting actor's own seat,
 * never another actor's on the same socket.
 *
 * ## The consumer's seams
 *
 * - **`RoomAuthorize`** decides each join and watch: `{allow: false}` answers
 *   `room_not_found`, the same as a room that doesn't exist, so a caller
 *   learns nothing of rooms it can't enter; `{allow: true, scope,
 *   max_members}` carries the `RoomScope` the seat or watch is admitted under,
 *   for eviction, and an optional member cap below the registry's. It gets the
 *   caller's ids and the database, not the request's role grants: authority is
 *   read through the database inside the reserve window (`RoomAuthorize`'s doc).
 * - **Eviction** is the consumer calling `RoomRegistry.evict` after its own
 *   authority change commits — from the handler's `emit_after_commit` — never
 *   before.
 * - **Rate limits.** `room_join` and `room_watch` carry the per-account class
 *   (`rate_limit: 'account'`, charged by the dispatcher): each runs the
 *   consumer's database authorizer, and one account may hold many sockets.
 *   **`RoomRateLimiter`** is per connection, outside the account budget: it
 *   bounds the count of joins, sends, and state sets, and the bytes of payloads
 *   and states as each frame carries them (JSON-escaped, `json_escaped_len`),
 *   because every room-wide byte lands in each member's outbound queue
 *   (`DEFAULT_WS_OUTBOUND_QUEUE_BYTES`) and a member reading slower than its
 *   room sends is closed for the overflow. A join stays on it too, since its
 *   state and the seats it moves fan out to every member; a watch fans out
 *   nothing, so it costs only its account charge.
 * - **`join_extra`**, a hook whose value the join answers as `extra` (`null`
 *   without one) — for what a consumer mints per seat.
 *
 * ## A join, step by step
 *
 * The dispatcher's account charge and input parse; refuse a state over the
 * registry's bound; charge the connection's limiter; `reserve_seat` (the join
 * is now reachable by evictions); the authorizer; then the request's own
 * signal — a client `cancel` of the join, or its socket closing, answers
 * `request_cancelled` — and `admit_seat`. A join whose socket closes
 * mid-authorizer keeps running here, unlike the Rust one, whose request future
 * is dropped; its admit refuses (`connection_closed`, answered
 * `request_cancelled`), so it seats nothing either way. A watch runs the same
 * steps through the watch halves, without the connection's limiter.
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';

import type { Uuid } from '../primitive_schemas.ts';
import type { RequestActorContext } from '../auth/request_context.ts';
import type { Db } from '../db/db.ts';
import { jsonrpc_errors, type ThrownJsonrpcError } from '../http/jsonrpc_errors.ts';
import { rpc_action, type RpcAction } from './action_types.ts';
import {
	ERROR_ROOM_FULL,
	ERROR_ROOM_JOIN_SUPERSEDED,
	ERROR_ROOM_MEMBER_NOT_FOUND,
	ERROR_ROOM_NOT_FOUND,
	ERROR_ROOM_NOT_JOINED,
	ERROR_ROOM_PAYLOAD_TOO_LARGE,
	ERROR_ROOM_SEAT_MOVED,
	ERROR_ROOM_STATE_TOO_LARGE,
	ERROR_ROOM_WATCH_LIMIT,
	JSON_ESCAPE_MAX_EXPANSION,
	json_escaped_len,
	room_join_action_spec,
	room_leave_action_spec,
	room_send_action_spec,
	room_state_set_action_spec,
	room_unwatch_action_spec,
	room_watch_action_spec,
	type MemberId,
	type RoomId
} from './room_action_specs.ts';
import type { RoomError, RoomRegistry, RoomRegistryLimits, RoomScope } from './room_registry.ts';
import { utf8_length } from './transports.ts';

// -- The authorizer ---------------------------------------------------------------

/** Which access an authorizer decides: a seat (`join`), or occupancy only (`watch`). */
export type RoomAccess = 'join' | 'watch';

/**
 * What `RoomAuthorize` decides on: who asks, for which room and access.
 *
 * It carries the caller's identity, never its authority. Each field is fixed
 * for the request's life, so none can go stale between the dispatcher's
 * resolve and the authorizer's read:
 *
 * - `actor_id` — the acting actor (after the `acting` selector), the key a
 *   policy reads its grants and memberships by;
 * - `account_id` — the actor's account, which an actor never changes, for a
 *   policy keyed by account;
 * - `room_id`, `access` — the request itself.
 *
 * Whether the actor or account is still live (not soft-deleted since the
 * dispatcher resolved it) is the authorizer's to read with its grants, as any
 * live-grant read does.
 */
export interface RoomAuthorizeInput {
	readonly actor_id: Uuid;
	readonly account_id: Uuid;
	readonly room_id: RoomId;
	readonly access: RoomAccess;
}

/**
 * An authorizer's answer: `{allow: false}` is answered `room_not_found`, as a
 * missing room is; `{allow: true}` admits under `scope` (eviction's handle on
 * it), and `max_members`, a non-negative integer, lowers the registry's cap
 * for this join — a watch ignores it, and any other value is a bug the join
 * throws on (`RoomRegistry.admit_seat`).
 */
export type RoomVerdict =
	| { readonly allow: false }
	| {
			readonly allow: true;
			readonly scope?: RoomScope | null;
			readonly max_members?: number | null;
	  };

/**
 * The consumer's decision on each join and watch.
 *
 * Runs between the registry's reserve and admit, so an eviction landing while
 * it reads still reaches the request (`RoomRegistry`'s two-phase join). It
 * reads through `db`, the request's pool-level client (the specs have no side
 * effects, so there is no transaction), under READ COMMITTED, and must only
 * read. A room it doesn't know is `{allow: false}`.
 *
 * **Authority is read through `db`, inside the reserve window, never from the
 * request.** The dispatcher loads the actor's role grants before the handler
 * runs, so before the reserve: a consumer's eviction (its write committed, then
 * `RoomRegistry.evict`) landing between that load and the reserve finds no
 * join in flight to reach, and a verdict on those grants would seat the
 * evicted actor. A read after the reserve sees the committed write, or the
 * eviction reaches the join — the race closes either way. So the input carries
 * the caller's ids (`RoomAuthorizeInput`), not its grants.
 *
 * A throw is a hard failure (a query that failed), answered as it is — a
 * `ThrownJsonrpcError` with its code, anything else `internal_error`.
 */
export interface RoomAuthorize {
	readonly authorize: (input: RoomAuthorizeInput, db: Db) => RoomVerdict | Promise<RoomVerdict>;
}

/** What `RoomJoinExtra` gets for an admitted seat. */
export interface RoomJoinExtraInput {
	/**
	 * The request's context as the dispatcher resolved it, before the reserve:
	 * its `role_grants` may predate an eviction, so derive nothing from them
	 * that needs current authority (the seat itself was admitted on the
	 * authorizer's live read).
	 */
	readonly auth: RequestActorContext;
	readonly room_id: RoomId;
	readonly member_id: MemberId;
}

/**
 * A consumer's addition to every admitted join's answer, as `extra` — a JSON
 * value; `undefined` answers `extra: null`.
 */
export type RoomJoinExtra = (input: RoomJoinExtraInput) => unknown;

// -- The per-connection limiter -----------------------------------------------------

/**
 * A `RoomRateLimiter`'s budgets. Each is a bucket holding at most its maximum,
 * refilled at that maximum per `window_ms`: a burst may spend it all at once,
 * and the sustained rate is the maximum per window.
 */
export interface RoomRateLimitOptions {
	/** Joins, sends, and state sets — each costs one. */
	readonly max_requests: number;
	/**
	 * Payload and state bytes as their frames carry them (`json_escaped_len`).
	 * At least a max-size payload's and state's worst case
	 * (`JSON_ESCAPE_MAX_EXPANSION` times the registry's bound), or
	 * `create_room_actions` refuses the pair.
	 */
	readonly max_bytes: number;
	/** The refill window, in ms. */
	readonly window_ms: number;
}

/**
 * The default budgets — the Rust `DEFAULT_ROOM_RATE_LIMIT`.
 *
 * Room for a join into a full-mesh room (an offer and its candidates to every
 * member) several times over. A full burst stays under half of a reader's
 * default outbound queue (`DEFAULT_WS_OUTBOUND_QUEUE_BYTES`, 4 MiB), by
 * construction: a charge is exactly the bytes the payload or state adds to its
 * frame, and each charged request puts at most four frames in any other
 * reader's queue (for a join, which moves at most one seat: the moved seat
 * leaving, its `room_seat_lost`, the join's `room_member_joined`, and the
 * uncharged leave that later ends the new seat), so one member's burst queues
 * at most `max_bytes` plus four frames' fixed overhead per request.
 */
export const DEFAULT_ROOM_RATE_LIMIT: RoomRateLimitOptions = Object.freeze({
	max_requests: 300,
	max_bytes: 1024 * 1024,
	window_ms: 10_000
});

/**
 * The fewest connections the limiter tracks before it sweeps the full
 * buckets; it sweeps again at twice what a sweep leaves.
 */
const LIMITER_SWEEP_FLOOR = 64;

/** A charge the budgets can't cover: whole seconds, at least one, until they would. */
export interface RoomRateLimited {
	readonly retry_after: number;
}

/**
 * A connection's two buckets, as credit scaled by the window's length in ms:
 * a request costs `window_ms` credit and a byte `window_ms` credit, and each
 * elapsed ms adds the maximum.
 */
interface RoomBuckets {
	requests: number;
	bytes: number;
	at: number;
}

/** Ms until a bucket holding `have` covers `need`, refilling at `max` per ms; a need past the bucket's whole size waits a window. */
const deficit_ms = (have: number, need: number, max: number, window: number): number => {
	if (have >= need) return 0;
	if (max === 0 || need > max * window) return window;
	return (need - have) / max;
};

/**
 * The room verbs' limiter, one budget pair per connection
 * (`RoomRateLimitOptions`) — the twin of the Rust `RoomRateLimiter`.
 *
 * A connection's buckets are forgotten once full again — a full bucket is what
 * a fresh one is — so the map holds only connections that spent recently,
 * swept as it grows.
 */
export class RoomRateLimiter {
	readonly options: RoomRateLimitOptions;

	readonly #now: () => number;
	#buckets: Map<Uuid, RoomBuckets> = new Map();
	#sweep_at = 0;

	/**
	 * @param options - the budgets
	 * @param now - the monotonic clock in ms; default `performance.now`, a test
	 *   passes its own to drive the refill
	 * @throws Error when a budget is not a non-negative safe integer, or the
	 *   window is not positive
	 */
	constructor(
		options: RoomRateLimitOptions = DEFAULT_ROOM_RATE_LIMIT,
		now: () => number = () => performance.now()
	) {
		const { max_requests, max_bytes, window_ms } = options;
		for (const [name, value] of [
			['max_requests', max_requests],
			['max_bytes', max_bytes]
		] as const) {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new Error(`RoomRateLimiter: ${name} must be a non-negative integer, got ${value}`);
			}
		}
		if (!(window_ms > 0) || !Number.isFinite(window_ms)) {
			throw new Error(`RoomRateLimiter: window_ms must be positive, got ${window_ms}`);
		}
		this.options = Object.freeze({ max_requests, max_bytes, window_ms });
		this.#now = now;
	}

	/**
	 * Spend one request and `bytes` from `connection_id`'s budgets, both or
	 * neither.
	 *
	 * @returns ok, or the wait when either budget can't cover it — nothing is
	 *   spent then
	 * @mutates this - spends the connection's buckets
	 */
	charge(connection_id: Uuid, bytes: number): Result<object, RoomRateLimited> {
		const now = this.#now();
		const { max_requests, max_bytes, window_ms: window } = this.options;
		const need_requests = window;
		const need_bytes = bytes * window;
		let buckets = this.#buckets.get(connection_id);
		if (!buckets) {
			buckets = this.#full(now);
			this.#buckets.set(connection_id, buckets);
		}
		this.#refill(buckets, now);
		if (buckets.requests >= need_requests && buckets.bytes >= need_bytes) {
			buckets.requests -= need_requests;
			buckets.bytes -= need_bytes;
			this.#sweep(now);
			return { ok: true };
		}
		const wait = Math.max(
			deficit_ms(buckets.requests, need_requests, max_requests, window),
			deficit_ms(buckets.bytes, need_bytes, max_bytes, window)
		);
		return { ok: false, retry_after: Math.max(Math.ceil(wait / 1000), 1) };
	}

	/** Connections tracked — those whose buckets aren't full again. For tests. */
	tracked(): number {
		return this.#buckets.size;
	}

	#full(now: number): RoomBuckets {
		const { max_requests, max_bytes, window_ms } = this.options;
		return { requests: max_requests * window_ms, bytes: max_bytes * window_ms, at: now };
	}

	/** Credit what elapsed since the buckets were last read, up to full. */
	#refill(buckets: RoomBuckets, now: number): void {
		const full = this.#full(now);
		const elapsed = Math.max(now - buckets.at, 0);
		buckets.requests = Math.min(
			buckets.requests + elapsed * this.options.max_requests,
			full.requests
		);
		buckets.bytes = Math.min(buckets.bytes + elapsed * this.options.max_bytes, full.bytes);
		buckets.at = now;
	}

	/** Forget the connections whose buckets are full again, once the map has grown past the last sweep's mark. */
	#sweep(now: number): void {
		if (this.#buckets.size <= Math.max(this.#sweep_at, LIMITER_SWEEP_FLOOR)) return;
		const full = this.#full(now);
		for (const [connection_id, buckets] of this.#buckets) {
			this.#refill(buckets, now);
			if (buckets.requests >= full.requests && buckets.bytes >= full.bytes) {
				this.#buckets.delete(connection_id);
			}
		}
		this.#sweep_at = this.#buckets.size * 2;
	}
}

/**
 * Why a limiter can't serve a registry: it would refuse a request the
 * registry's bounds admit, forever. The twin of the Rust `RoomSpecSetError`.
 */
export type RoomLimitsError =
	/** The limiter's `max_requests` is zero. */
	| { readonly kind: 'no_request_budget' }
	/**
	 * The limiter's `max_bytes` is below what one max-size payload or state can
	 * charge (its UTF-8 bound times `JSON_ESCAPE_MAX_EXPANSION`).
	 */
	| {
			readonly kind: 'byte_budget_below_bound';
			readonly bound: 'payload' | 'state';
			readonly charge: number;
			readonly max_bytes: number;
	  };

/**
 * Check that a limiter can cover every request a registry admits.
 *
 * @returns `null` when it can, else why not
 */
export const check_room_limits = (
	registry: RoomRegistryLimits,
	limiter: RoomRateLimitOptions
): RoomLimitsError | null => {
	if (limiter.max_requests === 0) return { kind: 'no_request_budget' };
	for (const [bound, bytes] of [
		['payload', registry.max_payload_bytes],
		['state', registry.max_state_bytes]
	] as const) {
		const charge = bytes * JSON_ESCAPE_MAX_EXPANSION;
		if (charge > limiter.max_bytes) {
			return { kind: 'byte_budget_below_bound', bound, charge, max_bytes: limiter.max_bytes };
		}
	}
	return null;
};

const format_room_limits_error = (error: RoomLimitsError): string =>
	error.kind === 'no_request_budget'
		? "the room limiter's max_requests is 0, so it refuses every join, send, and state set"
		: `the room limiter's max_bytes (${error.max_bytes}) is below the worst-case charge of a ` +
			`max-size ${error.bound} (${error.charge} bytes), which it would refuse forever`;

// -- The actions --------------------------------------------------------------------

/** The capabilities the room verbs run on. */
export interface RoomActionsDeps {
	/** The registry, over the connection registry of the WebSocket endpoint the verbs are mounted on. */
	readonly registry: RoomRegistry;
	readonly authorize: RoomAuthorize;
	/**
	 * The per-connection limiter; `null` leaves the verbs unlimited — a test
	 * server's choice, not a deployment's.
	 */
	readonly limiter: RoomRateLimiter | null;
}

/** Options for `create_room_actions`. */
export interface RoomActionsOptions {
	/** The join's `extra`; omitted answers `extra: null`. */
	readonly join_extra?: RoomJoinExtra;
}

/** `room_not_found` — the answer to a denial, a missing room, and an eviction in flight alike. */
const room_not_found = (): ThrownJsonrpcError =>
	jsonrpc_errors.not_found('room', { reason: ERROR_ROOM_NOT_FOUND });

const request_cancelled = (): ThrownJsonrpcError =>
	jsonrpc_errors.request_cancelled('request cancelled');

/**
 * The answer for a registry refusal — the codes and reasons of the Rust
 * `room_error`.
 *
 * @param error - the registry's refusal
 * @returns the error to throw
 */
export const to_room_jsonrpc_error = (error: RoomError): ThrownJsonrpcError => {
	switch (error) {
		case 'evicted':
			return room_not_found();
		// the socket is closing; nothing will read this
		case 'connection_closed':
			return request_cancelled();
		case 'join_superseded':
			return jsonrpc_errors.conflict('the join was superseded by a leave', {
				reason: ERROR_ROOM_JOIN_SUPERSEDED
			});
		case 'seat_moved':
			return jsonrpc_errors.conflict('the seat has moved', { reason: ERROR_ROOM_SEAT_MOVED });
		case 'full':
			return jsonrpc_errors.conflict('room is full', { reason: ERROR_ROOM_FULL });
		case 'not_joined':
			return jsonrpc_errors.conflict('not joined to the room', { reason: ERROR_ROOM_NOT_JOINED });
		case 'member_not_found':
			return jsonrpc_errors.not_found('room member', { reason: ERROR_ROOM_MEMBER_NOT_FOUND });
		case 'payload_too_large':
			return jsonrpc_errors.invalid_params('payload is too large', {
				reason: ERROR_ROOM_PAYLOAD_TOO_LARGE
			});
		case 'state_too_large':
			return jsonrpc_errors.invalid_params('state is too large', {
				reason: ERROR_ROOM_STATE_TOO_LARGE
			});
		case 'watch_limit':
			return jsonrpc_errors.conflict('too many watches', { reason: ERROR_ROOM_WATCH_LIMIT });
	}
};

/**
 * Build the room verbs (module doc), ready for a WebSocket endpoint's action
 * list — beside `room_notification_actions` (`actions/room_action_specs.ts`)
 * for the surface to list what the registry pushes.
 *
 * @param deps - the registry, the authorizer, and the limiter
 * @param options - the join's `extra`
 * @returns the actions, in `all_room_action_specs` order
 * @throws Error when the limiter can never cover a request the registry's
 *   bounds admit (`check_room_limits`): no request budget, or a byte budget
 *   below a max-size payload's or state's worst-case escaped charge
 */
export const create_room_actions = (
	deps: RoomActionsDeps,
	options: RoomActionsOptions = {}
): Array<RpcAction> => {
	const { registry, authorize, limiter } = deps;
	const { join_extra } = options;
	if (limiter) {
		const error = check_room_limits(registry.options, limiter.options);
		if (error) throw new Error(`create_room_actions: ${format_room_limits_error(error)}`);
	}

	/** The caller's socket; the verbs are WS-only, so its absence is a mount on the wrong endpoint. */
	const require_connection = (connection_id: Uuid | undefined, method: string): Uuid => {
		if (connection_id === undefined) throw jsonrpc_errors.method_not_found(method);
		return connection_id;
	};

	/** Charge the connection's limiter one request and `bytes`, as escaped. */
	const charge = (connection_id: Uuid, bytes: number): void => {
		if (!limiter) return;
		const charged = limiter.charge(connection_id, bytes);
		if (!charged.ok) {
			throw jsonrpc_errors.rate_limited('rate limited', { retry_after: charged.retry_after });
		}
	};

	return [
		rpc_action(room_join_action_spec, async (input, ctx) => {
			const connection_id = require_connection(ctx.connection_id, room_join_action_spec.method);
			const { room_id } = input;
			const state = input.state ?? null;
			if (state !== null && utf8_length(state) > registry.options.max_state_bytes) {
				throw to_room_jsonrpc_error('state_too_large');
			}
			charge(connection_id, state === null ? 0 : json_escaped_len(state));
			const reserved = registry.reserve_seat({
				connection_id,
				actor_id: ctx.auth.actor.id,
				room_id,
				rejoin_of: input.rejoin_of ?? null
			});
			if (!reserved.ok) throw to_room_jsonrpc_error(reserved.error);
			const pending = reserved.value;
			try {
				const verdict = await authorize.authorize(
					{
						actor_id: ctx.auth.actor.id,
						account_id: ctx.auth.account.id,
						room_id,
						access: 'join'
					},
					ctx.db
				);
				if (!verdict.allow) throw room_not_found();
				// a client `cancel` of the join, or its socket closing, while the
				// authorizer read
				if (ctx.signal.aborted) throw request_cancelled();
				const joined = registry.admit_seat(pending, {
					scope: verdict.scope ?? null,
					max_members: verdict.max_members ?? null,
					state
				});
				if (!joined.ok) throw to_room_jsonrpc_error(joined.error);
				// `extra` is always on the wire, `null` for a hook answering nothing, as in Rust
				const extra = join_extra
					? (join_extra({ auth: ctx.auth, room_id, member_id: joined.value.member_id }) ?? null)
					: null;
				return { ...joined.value, extra };
			} finally {
				// a no-op once admitted; otherwise the join leaves nothing in flight
				pending.withdraw();
			}
		}),
		rpc_action(room_leave_action_spec, (input, ctx) => {
			const connection_id = require_connection(ctx.connection_id, room_leave_action_spec.method);
			return { left: registry.leave(connection_id, ctx.auth.actor.id, input.room_id) };
		}),
		rpc_action(room_send_action_spec, (input, ctx) => {
			const connection_id = require_connection(ctx.connection_id, room_send_action_spec.method);
			if (utf8_length(input.payload) > registry.options.max_payload_bytes) {
				throw to_room_jsonrpc_error('payload_too_large');
			}
			charge(connection_id, json_escaped_len(input.payload));
			const sent = registry.send(
				connection_id,
				ctx.auth.actor.id,
				input.room_id,
				input.to,
				input.payload
			);
			if (!sent.ok) throw to_room_jsonrpc_error(sent.error);
			return null;
		}),
		rpc_action(room_state_set_action_spec, (input, ctx) => {
			const connection_id = require_connection(
				ctx.connection_id,
				room_state_set_action_spec.method
			);
			if (utf8_length(input.state) > registry.options.max_state_bytes) {
				throw to_room_jsonrpc_error('state_too_large');
			}
			charge(connection_id, json_escaped_len(input.state));
			const set = registry.set_state(connection_id, ctx.auth.actor.id, input.room_id, input.state);
			if (!set.ok) throw to_room_jsonrpc_error(set.error);
			return { seq: set.value };
		}),
		rpc_action(room_watch_action_spec, async (input, ctx) => {
			const connection_id = require_connection(ctx.connection_id, room_watch_action_spec.method);
			const { room_id } = input;
			const reserved = registry.reserve_watch(connection_id, ctx.auth.actor.id, room_id);
			if (!reserved.ok) throw to_room_jsonrpc_error(reserved.error);
			const pending = reserved.value;
			try {
				const verdict = await authorize.authorize(
					{
						actor_id: ctx.auth.actor.id,
						account_id: ctx.auth.account.id,
						room_id,
						access: 'watch'
					},
					ctx.db
				);
				if (!verdict.allow) throw room_not_found();
				if (ctx.signal.aborted) throw request_cancelled();
				const watched = registry.admit_watch(pending, verdict.scope ?? null);
				if (!watched.ok) throw to_room_jsonrpc_error(watched.error);
				return watched.value;
			} finally {
				pending.withdraw();
			}
		}),
		rpc_action(room_unwatch_action_spec, (input, ctx) => {
			const connection_id = require_connection(ctx.connection_id, room_unwatch_action_spec.method);
			return { unwatched: registry.unwatch(connection_id, input.room_id) };
		})
	];
};
