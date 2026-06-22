/**
 * Server→client peer requests (ActionPeer) — the request/response direction a
 * backend initiates to a connected WebSocket client and awaits a typed reply.
 *
 * `PendingPeerRequests` is the correlation registry: it owns the in-flight map
 * (nested `connection_id → request id` — the nesting **is** the per-connection
 * isolation guarantee), id allocation (`s{n}`-namespaced so a client's own
 * request ids can't collide), the per-request deadline, and the per-connection
 * in-flight cap. It deliberately does **not** touch the socket — the caller
 * (`BackendWebsocketTransport.request_connection`) does the send and threads the
 * reply back via `resolve`. This mirrors the Rust `fuz_realtime::peer` split
 * (the `PendingPeerRequests` registry vs the transport that composes it), and
 * keeps the registry pure data so it unit-tests without a live socket.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import type {
	JsonrpcErrorObject,
	JsonrpcErrorResponse,
	JsonrpcRequestId,
	JsonrpcRequestParams,
	JsonrpcResponse,
	JsonrpcResult,
} from '../http/jsonrpc.ts';
import {is_jsonrpc_error_response} from '../http/jsonrpc_helpers.ts';

/**
 * Default deadline (ms) for a server→client peer request before it resolves
 * `timeout`. Twin of the Rust spine's `DEFAULT_PEER_TIMEOUT`.
 */
export const DEFAULT_PEER_REQUEST_TIMEOUT = 10_000;

/**
 * Per-connection cap on concurrent in-flight server→client requests. A caller
 * past it gets `too_many_in_flight` instead of growing the pending map
 * unbounded. Twin of the Rust spine's `DEFAULT_MAX_IN_FLIGHT_PER_CONN`.
 */
export const MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION = 256;

/**
 * Why a server→client peer request did not yield a client success reply.
 *
 * - `timeout` — the client did not answer within the deadline.
 * - `connection_gone` — the socket closed (or was never registered) before a reply.
 * - `too_many_in_flight` — the per-connection in-flight cap was hit.
 * - `client_error` — the client answered with a JSON-RPC error; `error` is
 *   forwarded verbatim so the initiating handler can surface the client's own
 *   code / message / data.
 */
export type PeerRequestError =
	| {kind: 'timeout'}
	| {kind: 'connection_gone'}
	| {kind: 'too_many_in_flight'}
	| {kind: 'client_error'; error: JsonrpcErrorObject};

/** Outcome of a server→client peer request: the client's success `result`, or a `PeerRequestError`. */
export type PeerRequestOutcome =
	| {ok: true; value: JsonrpcResult}
	| {ok: false; error: PeerRequestError};

/** Per-call options for a server→client peer request. */
export interface PeerRequestOptions {
	/**
	 * Deadline (ms) before the request resolves `timeout`. Defaults to the
	 * registry's `default_timeout_ms` (`DEFAULT_PEER_REQUEST_TIMEOUT`). Untrusted
	 * remote-supplied values should be clamped **shorten-only** (never lengthen
	 * the server's hold on a pooled connection) — see `actions/peer_ping.ts`.
	 */
	timeout_ms?: number;
}

/**
 * Initiate a JSON-RPC request to the connected client and await its reply — the
 * server→client direction of ActionPeer. Threaded onto
 * `ActionContext.request_client` for WebSocket handlers (absent on HTTP RPC,
 * where there is no return socket). Returns a `PeerRequestOutcome`; never throws.
 */
export type RequestClient = (
	method: string,
	params: JsonrpcRequestParams | undefined,
	options?: PeerRequestOptions,
) => Promise<PeerRequestOutcome>;

/** A pending server→client request awaiting the client's reply. */
interface PendingPeerRequest {
	/** Resolves the `register` outcome promise with the settled outcome. */
	resolve: (outcome: PeerRequestOutcome) => void;
	/** Deadline timer — cleared on any settle (reply / drain / send failure). */
	timer: ReturnType<typeof setTimeout>;
}

/** Options for `PendingPeerRequests`. */
export interface PendingPeerRequestsOptions {
	/** Per-connection in-flight cap. Defaults to `MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION`. */
	max_in_flight_per_connection?: number;
	/** Default per-request deadline (ms). Defaults to `DEFAULT_PEER_REQUEST_TIMEOUT`. */
	default_timeout_ms?: number;
}

/**
 * Correlation registry for in-flight server→client requests, nested by
 * connection then by the server-issued request id.
 *
 * The per-connection nesting makes the in-flight count and the close-time drain
 * O(1) and is the isolation boundary — a reply on connection B can never settle
 * a request issued on connection A (it lands in a different inner map). An inner
 * map is removed as soon as it empties, so an idle connection holds no entry.
 * The registry never sends on the socket; the caller does the send between
 * `register` and the first `await`, and routes inbound replies back via
 * `resolve`.
 */
export class PendingPeerRequests {
	#pending: Map<Uuid, Map<JsonrpcRequestId, PendingPeerRequest>> = new Map();

	// Monotonic counter for server-issued ids. Serialized as `s{n}` so a client's
	// own (self-chosen) request ids on a bidirectional socket can never collide.
	#next_id = 0;

	readonly #max_in_flight: number;
	readonly #default_timeout_ms: number;

	constructor(options?: PendingPeerRequestsOptions) {
		this.#max_in_flight =
			options?.max_in_flight_per_connection ?? MAX_IN_FLIGHT_PEER_REQUESTS_PER_CONNECTION;
		this.#default_timeout_ms = options?.default_timeout_ms ?? DEFAULT_PEER_REQUEST_TIMEOUT;
	}

	/**
	 * Register a pending request for `connection_id` with a deadline, returning
	 * its server-issued `s{n}` id and the outcome promise (settled by a reply,
	 * the deadline, or `drain`). Returns `null` when the connection is at its
	 * in-flight cap — the caller maps that to `too_many_in_flight`. The promise
	 * executor runs synchronously, so the entry is registered before this returns.
	 *
	 * @returns the allocated id + outcome promise, or `null` at the cap
	 * @mutates this - inserts an entry into `#pending`
	 */
	register(
		connection_id: Uuid,
		timeout_ms?: number,
	): {id: JsonrpcRequestId; outcome: Promise<PeerRequestOutcome>} | null {
		const existing = this.#pending.get(connection_id);
		if ((existing?.size ?? 0) >= this.#max_in_flight) return null;
		const conn_pending = existing ?? new Map<JsonrpcRequestId, PendingPeerRequest>();
		if (!existing) this.#pending.set(connection_id, conn_pending);

		const id: JsonrpcRequestId = `s${++this.#next_id}`;
		const ms = timeout_ms ?? this.#default_timeout_ms;
		const outcome = new Promise<PeerRequestOutcome>((resolve) => {
			const timer = setTimeout(
				() => this.settle(connection_id, id, {ok: false, error: {kind: 'timeout'}}),
				ms,
			);
			conn_pending.set(id, {resolve, timer});
		});
		return {id, outcome};
	}

	/**
	 * Settle the pending request matching an inbound reply. A success response
	 * resolves `{ok: true, value: result}`; an error response resolves
	 * `{ok: false, error: {kind: 'client_error', error}}` (forwarded verbatim).
	 *
	 * Returns `false` when no entry matches — an unsolicited, cross-connection,
	 * or already-settled reply — so the caller drops it.
	 *
	 * @returns whether a pending request was settled
	 * @mutates this - clears the matched entry from `#pending`
	 */
	resolve(connection_id: Uuid, response: JsonrpcResponse | JsonrpcErrorResponse): boolean {
		const {id} = response;
		if (id == null) return false;
		if (!this.#pending.get(connection_id)?.has(id)) return false;
		const outcome: PeerRequestOutcome = is_jsonrpc_error_response(response)
			? {ok: false, error: {kind: 'client_error', error: response.error}}
			: {ok: true, value: response.result};
		this.settle(connection_id, id, outcome);
		return true;
	}

	/**
	 * Force-settle one pending request with an explicit outcome (the send-failure
	 * path uses this for `connection_gone`). Clears the timer, drops the entry,
	 * resolves the promise. Idempotent — a no-op if the entry is already gone.
	 *
	 * @mutates this - clears the entry from `#pending`
	 */
	settle(connection_id: Uuid, id: JsonrpcRequestId, outcome: PeerRequestOutcome): void {
		const conn_pending = this.#pending.get(connection_id);
		const entry = conn_pending?.get(id);
		if (!entry || !conn_pending) return;
		clearTimeout(entry.timer);
		conn_pending.delete(id);
		if (conn_pending.size === 0) this.#pending.delete(connection_id);
		entry.resolve(outcome);
	}

	/**
	 * Settle every pending request on a closing connection as `connection_gone`.
	 * O(1) — drops the connection's inner map in one hop.
	 *
	 * @mutates this - removes the connection's entry from `#pending`
	 */
	drain(connection_id: Uuid): void {
		const conn_pending = this.#pending.get(connection_id);
		if (!conn_pending) return;
		for (const entry of conn_pending.values()) {
			clearTimeout(entry.timer);
			entry.resolve({ok: false, error: {kind: 'connection_gone'}});
		}
		this.#pending.delete(connection_id);
	}

	/**
	 * In-flight request count — for `connection_id` when given, else across all
	 * connections. Telemetry / tests.
	 */
	size(connection_id?: Uuid): number {
		if (connection_id !== undefined) return this.#pending.get(connection_id)?.size ?? 0;
		let total = 0;
		for (const conn_pending of this.#pending.values()) total += conn_pending.size;
		return total;
	}
}

// Module-scope sampling counter for unmatched-response auditing.
let unmatched_peer_responses = 0;

/**
 * Sampled, bounded audit for an inbound response that matched no pending request
 * on its connection — an unsolicited `{id, result}`, a cross-connection id echo,
 * or a late/duplicate reply for an already-settled id. Auditing **every**
 * rejected frame would let a junk flood turn the log into the DoS target, so
 * this warns on the first few then samples 1-in-256. Twin of the Rust
 * `fuz_realtime::peer::audit_unmatched_response`.
 *
 * @param log - the WS dispatcher's logger
 * @param connection_id - the socket the unmatched reply arrived on
 * @param id - the reply's echoed id (`null` when absent)
 */
export const audit_unmatched_peer_response = (
	log: Logger,
	connection_id: Uuid,
	id: JsonrpcRequestId | null,
): void => {
	const n = unmatched_peer_responses++;
	if (n < 8 || n % 256 === 0) {
		log.warn(
			'ws: dropped unmatched peer response (unsolicited, cross-connection, or already settled)',
			{connection_id, id, total: n + 1},
		);
	}
};
