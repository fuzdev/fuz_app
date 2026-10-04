/**
 * Backend WebSocket transport — manages server-side WebSocket connections
 * with session tracking, revocation support, a per-account connection cap,
 * and two-phase registration.
 *
 * ## Two-phase registration
 *
 * An upgrade resolves its credential before the socket exists, and every
 * revocation closes the connections *registered* under the revoked
 * credential. A one-step registration therefore has a window: a revocation
 * landing between the credential check and the insert closes nothing, and the
 * upgrade is admitted on a dead credential — for the socket's lifetime, since
 * per-message dispatch never re-reads the session or token.
 *
 * Registration is split to close it:
 *
 * 1. `BackendWebsocketTransport.register_pending` inserts the entry
 *    **un-admitted**. It is closeable from that instant — `close_sockets_for_*`
 *    match pending entries deliberately — and is otherwise inert: it evicts
 *    nothing, the cap does not count it, no broadcast / `send_to_account` /
 *    `request_connection` reaches it, and the count accessors and
 *    `is_registered` do not see it (`get_pending_connection_count` does).
 * 2. The caller re-checks the credential against the database
 *    (`revalidate_resolved_auth` in `auth/resolved_auth.ts`).
 * 3. `BackendWebsocketTransport.admit` flips the entry to admitted — or
 *    refuses when a revocation closed it in the meantime, evicting nothing.
 *    The cap's eviction happens here, so a connection that is never admitted
 *    never closes a live one, and any number of pending registrations on one
 *    account leave its admitted connections alone.
 *
 * A revocation whose close ran **after** step 1 finds the entry, pending or
 * admitted, and closes it; one that **committed before** step 2 is seen by the
 * re-read, which refuses. Nothing is delivered to a pending entry rather than
 * queued for it, so a refusal never has to promise that a queue a revoked
 * credential would have read is dropped unread, and a broadcast's returned
 * count names only connections that can receive it. The cost is a slightly
 * wider blind spot at connect: a server-initiated message sent between the
 * handshake and admission — one credential re-check later — is not delivered,
 * just as one sent before the handshake is not.
 *
 * `add_connection` stays as the one-step form (register and admit together)
 * for a connection with no revocable credential behind it — tests and
 * harnesses that register a socket directly. An upgrade that authenticated a session or token
 * uses the two-phase form. The twin of the Rust `fuz_realtime`
 * `ConnectionRegistry`.
 *
 * @module
 */

import type { WSContext } from 'hono/ws';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcRequestParams,
	JsonrpcResponse,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse
} from '../http/jsonrpc.ts';
import { jsonrpc_error_messages } from '../http/jsonrpc_errors.ts';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_request,
	to_jsonrpc_message_id,
	is_jsonrpc_request
} from '../http/jsonrpc_helpers.ts';
import {
	WS_CLOSE_CONNECTION_LIMIT,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON,
	type Transport,
	type TransportSendOptions
} from './transports.ts';
import {
	PendingPeerRequests,
	type PeerRequestOptions,
	type PeerRequestOutcome
} from './peer_request.ts';

// TODO support a SSE backend transport

/**
 * Auth identity attached to a single WebSocket connection.
 *
 * One record per connection. `token_hash` is set for cookie-session
 * connections, `api_token_id` for bearer (`api_token`) connections, and
 * both are null for daemon-token connections (reachable only via
 * `BackendWebsocketTransport.close_sockets_for_account`).
 */
export interface ConnectionIdentity {
	/** Blake3 session token hash, or null for non-session credentials. */
	token_hash: string | null;
	/** Authenticated account id. Always set. */
	account_id: Uuid;
	/** `api_token.id` for bearer-authenticated connections, else null. */
	api_token_id: string | null;
}

/**
 * Structural capability for transports that can broadcast with a
 * per-connection ACL predicate. Named separately from `Transport` so the
 * broadcast API can feature-detect without importing a concrete class.
 *
 * `ConnectionIdentity` is the auth-gated identity shape used today. When a
 * second implementation (e.g. SSE backend transport) lands with a
 * different identity, consider parameterizing on `TIdentity`.
 */
export interface FilterableBroadcastTransport extends Transport {
	broadcast_filtered: (
		message: JsonrpcMessageFromServerToClient,
		predicate: (identity: ConnectionIdentity) => boolean
	) => number;
}

/** Type guard for `FilterableBroadcastTransport`. */
export const is_filterable_broadcast_transport = (
	transport: Transport
): transport is FilterableBroadcastTransport =>
	'broadcast_filtered' in transport &&
	typeof (transport as FilterableBroadcastTransport).broadcast_filtered === 'function';

/**
 * Default per-account WebSocket connection cap, applied by
 * `BackendWebsocketTransport` unless overridden via
 * `BackendWebsocketTransportOptions.max_connections_per_account`.
 *
 * Matches the account-wide ceiling the audit SSE cap implies (the default
 * session cap, `DEFAULT_MAX_SESSIONS`, times `AUDIT_LOG_SSE_MAX_PER_SCOPE`
 * streams per session) — generous enough that a user's tabs and tools never
 * meet it; only an abusive or leaking client does. The twin of the Rust
 * spine's `DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`.
 */
export const DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT = 50;

/** Options for `BackendWebsocketTransport`. */
export interface BackendWebsocketTransportOptions {
	/**
	 * Max concurrent connections per `account_id`, across every credential
	 * type (session, API token, daemon token — none exempt). The policy is
	 * **evict-oldest**: a connection past the cap is always admitted, and the
	 * account's oldest connections are closed with `WS_CLOSE_CONNECTION_LIMIT`
	 * to make room. Refusing the new one instead would let half-open sockets
	 * lock a user out with their own dead connections, and would let a stolen
	 * credential fill the slots ahead of the real user — revocation is the fix
	 * for a stolen credential, and evict-oldest never stands in its way.
	 *
	 * The cap is per transport: endpoints sharing one transport share one
	 * count per account. `null` disables it.
	 *
	 * @default DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
	 */
	max_connections_per_account?: number | null;
	/**
	 * Logger for cap evictions and failed sends or closes. A cap eviction logs
	 * at info — the account, how many connections were closed, and the cap —
	 * so an operator can see a client that keeps meeting it. Unset falls back
	 * to a `[ws]` logger; `null` silences it. `register_action_ws` passes its
	 * own logger to the transport it creates.
	 */
	log?: Logger | null;
}

/** One registered connection — its socket, auth identity, and admission state. */
interface ConnectionEntry {
	ws: WSContext;
	identity: ConnectionIdentity;
	/**
	 * `false` between `register_pending` and `admit`. An un-admitted entry
	 * exists only so a revocation can find and close it: it receives nothing, is
	 * not counted, and never weighs on the per-account cap.
	 */
	admitted: boolean;
	/**
	 * The socket-scoped controller the caller registered, aborted when the
	 * transport closes the connection (revocation or cap eviction) so in-flight
	 * handlers see `signal.aborted` at once rather than when the close handshake
	 * lands.
	 */
	abort_controller: AbortController | null;
}

export class BackendWebsocketTransport implements FilterableBroadcastTransport {
	readonly transport_name = 'backend_websocket_rpc' as const;

	// Per-account connection cap; `null` = uncapped.
	readonly #max_connections_per_account: number | null;

	readonly #log: Logger | null;

	// One entry per registered connection, pending or admitted, in
	// registration order (Map iteration is insertion order — the cap's
	// "oldest"). Adding a new identity scope (e.g. `device_id`) means adding a
	// field to `ConnectionIdentity`, not a parallel map.
	#connections: Map<Uuid, ConnectionEntry> = new Map();

	// Server→client request correlation (ActionPeer). The transport owns the
	// sockets + the send; the registry owns the pending map, id allocation,
	// deadlines, and the per-connection in-flight cap (see `peer_request.ts`).
	#pending: PendingPeerRequests = new PendingPeerRequests();

	/**
	 * @throws Error when `max_connections_per_account` is neither `null` nor a
	 *   positive integer
	 */
	constructor(options?: BackendWebsocketTransportOptions) {
		const max =
			options?.max_connections_per_account === undefined
				? DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
				: options.max_connections_per_account;
		if (max !== null && (!Number.isInteger(max) || max < 1)) {
			throw new Error(
				`BackendWebsocketTransport: max_connections_per_account must be a positive integer or null, got ${max}`
			);
		}
		this.#max_connections_per_account = max;
		this.#log = options?.log === undefined ? new Logger('[ws]') : options.log;
	}

	/**
	 * Register a connection **un-admitted** — phase one of the two-phase
	 * registration an upgrade runs (module doc).
	 *
	 * The entry is closeable at once: a `close_sockets_for_*` matching
	 * `token_hash` / `account_id` / `api_token_id` removes it, aborts
	 * `abort_controller`, and closes `ws` with `WS_CLOSE_SESSION_REVOKED`; the
	 * later `admit` then refuses. Until admitted it evicts nothing, is not
	 * counted toward the per-account cap, and receives no message.
	 *
	 * The caller owns the entry until it is admitted: every refusal path calls
	 * `remove_connection` with the returned id.
	 *
	 * @param ws - the socket to close on revocation
	 * @param token_hash - blake3 session token hash, or `null` for non-session credentials
	 * @param account_id - the authenticated account
	 * @param api_token_id - `api_token.id` for bearer connections, else `null`
	 * @param abort_controller - the socket-scoped controller to abort when the
	 *   transport closes this connection (revocation or cap eviction)
	 * @returns the freshly assigned `connection_id` (branded `Uuid`)
	 * @mutates this - inserts an un-admitted entry into `#connections`
	 */
	register_pending(
		ws: WSContext,
		token_hash: string | null,
		account_id: Uuid,
		api_token_id: string | null = null,
		abort_controller: AbortController | null = null
	): Uuid {
		return this.#insert(ws, token_hash, account_id, api_token_id, abort_controller, false);
	}

	/**
	 * Admit a pending connection — phase two (module doc).
	 *
	 * If the entry is gone — a revocation closed it while it was pending, or it
	 * was removed — nothing is evicted and the connection is refused. Otherwise
	 * the per-account cap is enforced exactly as in `add_connection`, counting
	 * only **admitted** connections, and the entry becomes admitted: it now
	 * receives messages, is counted, and can itself be superseded. Admitting an
	 * already-admitted connection is a no-op that answers `true`.
	 *
	 * @param connection_id - the id `register_pending` returned
	 * @returns `false` when the connection is no longer registered — the caller
	 *   closes the socket as revoked
	 * @mutates this - marks the entry admitted; past the cap, first removes the
	 *   account's oldest admitted connections and closes their `WSContext`
	 */
	admit(connection_id: Uuid): boolean {
		const entry = this.#connections.get(connection_id);
		if (!entry) return false;
		if (entry.admitted) return true;
		// the entry itself is un-admitted, so the eviction neither counts nor
		// removes it
		if (this.#max_connections_per_account !== null) {
			this.#evict_oldest_for_account(entry.identity.account_id, this.#max_connections_per_account);
		}
		entry.admitted = true;
		return true;
	}

	/**
	 * Register a connection, admitted at once — the one-step form of
	 * `register_pending` + `admit`.
	 *
	 * **Not for an upgrade that authenticated a revocable credential**: a
	 * revocation landing between that upgrade's credential check and this call
	 * closes nothing, and the connection would be admitted on a dead credential
	 * (module doc, "Two-phase registration"). This is for a connection with
	 * nothing to revoke behind it.
	 *
	 * Session connections pass a token hash for targeted revocation.
	 * Bearer token connections (`api_token`) pass the `api_token.id` so the
	 * socket can be closed when that specific token is revoked without
	 * tearing down the account's other sockets. Daemon-token connections
	 * pass `null` for both — they're only reachable via
	 * `close_sockets_for_account`.
	 *
	 * Enforces the per-account cap (`max_connections_per_account`): when
	 * `account_id` already holds the maximum, its oldest admitted connections are
	 * removed and sent a `WS_CLOSE_CONNECTION_LIMIT` close before the new one is
	 * inserted. A removed connection gets no further broadcast or peer request,
	 * stops counting toward the cap at once, and has its `abort_controller`
	 * aborted; its socket is closed when the close handshake completes. The new
	 * connection is always admitted.
	 *
	 * @returns the freshly assigned `connection_id` (branded `Uuid`)
	 * @mutates this - inserts an admitted entry into `#connections`; past the
	 *   cap, first removes the account's oldest admitted connections and closes
	 *   their `WSContext`
	 */
	add_connection(
		ws: WSContext,
		token_hash: string | null,
		account_id: Uuid,
		api_token_id: string | null = null,
		abort_controller: AbortController | null = null
	): Uuid {
		if (this.#max_connections_per_account !== null) {
			this.#evict_oldest_for_account(account_id, this.#max_connections_per_account);
		}
		return this.#insert(ws, token_hash, account_id, api_token_id, abort_controller, true);
	}

	#insert(
		ws: WSContext,
		token_hash: string | null,
		account_id: Uuid,
		api_token_id: string | null,
		abort_controller: AbortController | null,
		admitted: boolean
	): Uuid {
		const connection_id = create_uuid();
		this.#connections.set(connection_id, {
			ws,
			identity: { token_hash, account_id, api_token_id },
			admitted,
			abort_controller
		});
		return connection_id;
	}

	/**
	 * Remove a connection and its auth tracking data, pending or admitted, by
	 * the id `register_pending` / `add_connection` returned. Idempotent — safe
	 * to call after revocation or a cap eviction has already cleaned up, and a
	 * no-op for an unknown id.
	 *
	 * Keyed by id rather than by `WSContext` because a runtime adapter may hand
	 * each socket event its own context object (`hono/bun` does), so the one a
	 * close event carries can't identify the connection.
	 *
	 * Removal only: the socket is not closed and the registered
	 * `abort_controller` is not aborted — the caller that ends a socket does
	 * both.
	 *
	 * @mutates this - deletes the connection's entry from `#connections` and
	 *   settles its pending peer requests as `connection_gone`
	 */
	remove_connection(connection_id: Uuid): void {
		this.#cleanup_connection(connection_id);
	}

	/**
	 * Close every connection whose identity matches the predicate — pending or
	 * admitted. Never filter on admission here: reaching a registration in
	 * flight is the point of the pending phase, and `admit` then refuses it.
	 *
	 * A socket whose `close` throws does not stop the loop: every match is
	 * removed and closed, and the first error is thrown afterward. The failing
	 * socket's connection is already removed and its handlers aborted, so
	 * nothing more is dispatched or delivered on it.
	 *
	 * @returns the number of sockets closed
	 * @throws the first error a socket's `close` threw, after every match was attempted
	 */
	#close_where(predicate: (identity: ConnectionIdentity) => boolean): number {
		let count = 0;
		let failed = false;
		let first_error: unknown;
		// deleting the current entry during Map iteration is safe
		for (const [connection_id, entry] of this.#connections) {
			if (predicate(entry.identity)) {
				try {
					this.#revoke_connection(connection_id, entry);
					count++;
				} catch (error) {
					if (!failed) {
						failed = true;
						first_error = error;
					}
				}
			}
		}
		if (failed) throw first_error;
		return count;
	}

	/**
	 * Close all sockets associated with a specific session token hash,
	 * including a registration still pending admission.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections, aborts their registered
	 *   controllers, and closes their underlying `WSContext` with
	 *   `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_session(token_hash: string): number {
		return this.#close_where((id) => id.token_hash === token_hash);
	}

	/**
	 * Close all sockets associated with a specific account, including a
	 * registration still pending admission.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections, aborts their registered
	 *   controllers, and closes their underlying `WSContext` with
	 *   `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_account(account_id: Uuid): number {
		return this.#close_where((id) => id.account_id === account_id);
	}

	/**
	 * Close all sockets associated with a specific API token, including a
	 * registration still pending admission.
	 *
	 * Used on `token_revoke` audit events so revoking one token doesn't
	 * tear down the account's session-authenticated sockets or other
	 * tokens' sockets.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections, aborts their registered
	 *   controllers, and closes their underlying `WSContext` with
	 *   `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_token(api_token_id: string): number {
		return this.#close_where((id) => id.api_token_id === api_token_id);
	}

	#cleanup_connection(connection_id: Uuid): void {
		this.#connections.delete(connection_id);
		// Wake any handler still awaiting a reply on this socket — the peer is
		// gone, so the request can never complete.
		this.#pending.drain(connection_id);
	}

	#revoke_connection(connection_id: Uuid, entry: ConnectionEntry): void {
		this.#cleanup_connection(connection_id);
		// abort before the close so a handler observing `ctx.signal` bails out
		// without waiting for the close handshake
		entry.abort_controller?.abort();
		entry.ws.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON);
	}

	/**
	 * Make room for one more admitted connection on `account_id`: when the
	 * account already holds `max`, close its oldest so that `max - 1` remain.
	 * Pending registrations are neither counted nor closed — a connection that
	 * may yet be refused must not cost a live one its slot.
	 */
	#evict_oldest_for_account(account_id: Uuid, max: number): void {
		// Map iteration is insertion order, so `owned` is oldest-first
		const owned: Array<[Uuid, ConnectionEntry]> = [];
		for (const [connection_id, entry] of this.#connections) {
			if (entry.admitted && entry.identity.account_id === account_id) {
				owned.push([connection_id, entry]);
			}
		}
		const excess = owned.length + 1 - max;
		if (excess <= 0) return;
		for (let i = 0; i < excess; i++) {
			const [connection_id, entry] = owned[i]!;
			this.#supersede_connection(connection_id, entry);
		}
		// same line as the Rust spine's registry, so one grep finds either
		this.#log?.info('ws: connection cap closed oldest', { account_id, closed: excess, max });
	}

	#supersede_connection(connection_id: Uuid, entry: ConnectionEntry): void {
		this.#cleanup_connection(connection_id);
		try {
			entry.abort_controller?.abort();
			entry.ws.close(WS_CLOSE_CONNECTION_LIMIT, 'connection limit');
		} catch (error) {
			// the evicted socket is another connection's — a failure closing it
			// must not fail the connection being admitted
			this.#log?.error('error closing superseded client:', error);
		}
	}

	// `send` is the broadcast/notification surface: notifications fan out to
	// every socket. A *request* has no single target here — server→client
	// request/response is `request_connection`, which targets one socket and
	// correlates the reply. `send(request)` is therefore a misuse and returns
	// an error rather than guessing a recipient.
	async send(
		message: JsonrpcRequest,
		options?: TransportSendOptions
	): Promise<JsonrpcResponseOrError>;
	async send(
		message: JsonrpcNotification,
		options?: TransportSendOptions
	): Promise<JsonrpcErrorResponse | null>;
	async send(
		message: JsonrpcMessageFromClientToServer,
		_options?: TransportSendOptions
	): Promise<JsonrpcMessageFromServerToClient | null> {
		if (is_jsonrpc_request(message)) {
			return create_jsonrpc_error_response(
				message.id,
				jsonrpc_error_messages.internal_error(
					'backend WebSocket transport cannot broadcast a request expecting a response; ' +
						'use request_connection(connection_id, ...) to target a single socket'
				)
			);
		}

		try {
			await this.#broadcast(message);
			return null;
		} catch (error) {
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.internal_error(
					to_error_message(error, 'failed to broadcast notification')
				)
			);
		}
	}

	#broadcast(message: JsonrpcMessageFromServerToClient): Promise<void> {
		const serialized = JSON.stringify(message);
		for (const entry of this.#connections.values()) {
			// a registration pending admission is not a connection yet
			if (!entry.admitted) continue;
			try {
				entry.ws.send(serialized);
			} catch (error) {
				this.#log?.error('error broadcasting to client:', error);
			}
		}
		// TODO hack - remove if not ever needed, I assume this will need to be async so let's hold that assumption
		return Promise.resolve();
	}

	/**
	 * Broadcast to admitted connections whose identity satisfies a predicate. A
	 * registration pending admission is skipped before the predicate runs.
	 *
	 * Used by the broadcast API when a consumer supplies a subscription ACL hook
	 * (e.g. zap's `zap_run_created` only reaches the account that owns the run).
	 * When no ACL is needed, callers should prefer `send(message)` / `#broadcast`
	 * to skip the per-connection predicate overhead.
	 *
	 * @returns the number of sockets the message was sent to
	 */
	broadcast_filtered(
		message: JsonrpcMessageFromServerToClient,
		predicate: (identity: ConnectionIdentity) => boolean
	): number {
		const serialized = JSON.stringify(message);
		let count = 0;
		for (const entry of this.#connections.values()) {
			if (!entry.admitted || !predicate(entry.identity)) continue;
			try {
				entry.ws.send(serialized);
				count++;
			} catch (error) {
				this.#log?.error('error broadcasting filtered to client:', error);
			}
		}
		return count;
	}

	/**
	 * Send a message to every admitted socket bound to a specific account.
	 *
	 * Targeted per-account fan-out for any flow where the delivery target
	 * is a single known account. Prefer this over `broadcast_filtered` when
	 * the filter is exactly "this account_id"; reach for `broadcast_filtered`
	 * when the ACL is an arbitrary predicate over `ConnectionIdentity`.
	 *
	 * Mirrors `close_sockets_for_account` on the send side: every connection
	 * for the account (session, bearer, and daemon-token) receives the
	 * message.
	 *
	 * @returns the number of sockets the message was sent to
	 */
	send_to_account(account_id: Uuid, message: JsonrpcMessageFromServerToClient): number {
		return this.broadcast_filtered(message, (id) => id.account_id === account_id);
	}

	/**
	 * Initiate a JSON-RPC request to a single connected client and await its
	 * reply — the server→client request/response direction (ActionPeer).
	 *
	 * Sends `{jsonrpc, method, params, id}` to exactly the `connection_id`
	 * socket (never a broadcast) and registers a pending entry scoped to that
	 * connection. Resolves when the client's matching reply arrives (routed in
	 * via `resolve_peer_response`), the deadline elapses (`timeout`), the
	 * per-connection cap is hit (`too_many_in_flight`), or the socket closes
	 * (`connection_gone`). A connection still pending admission answers
	 * `connection_gone` like an unknown one. Never throws — every failure is a
	 * `PeerRequestError`.
	 *
	 * Delegates correlation to `#pending` (id allocation, deadline, cap, drain);
	 * this method owns only the socket lookup + the send. Server-issued ids are
	 * `s`-prefixed so a malicious client echoing a non-`s` id (or an id it chose
	 * for its own request) matches nothing.
	 *
	 * @returns the client's success `result`, or a `PeerRequestError`
	 * @mutates this - registers then clears an entry in `#pending`
	 */
	request_connection(
		connection_id: Uuid,
		method: string,
		params: JsonrpcRequestParams | undefined,
		options?: PeerRequestOptions
	): Promise<PeerRequestOutcome> {
		const entry = this.#connections.get(connection_id);
		if (!entry?.admitted) {
			return Promise.resolve({ ok: false, error: { kind: 'connection_gone' } });
		}
		const { ws } = entry;

		const registered = this.#pending.register(connection_id, options?.timeout_ms);
		if (!registered) return Promise.resolve({ ok: false, error: { kind: 'too_many_in_flight' } });
		const { id, outcome } = registered;

		try {
			ws.send(JSON.stringify(create_jsonrpc_request(method, params, id)));
		} catch {
			// Send failed — the socket is gone; settle now so the caller isn't
			// left awaiting until the deadline.
			this.#pending.settle(connection_id, id, { ok: false, error: { kind: 'connection_gone' } });
		}
		return outcome;
	}

	/**
	 * Route an inbound client reply to the matching pending server→client
	 * request on `connection_id` (delegates to `#pending.resolve`).
	 *
	 * Returns `false` when no entry matches — an unsolicited, cross-connection,
	 * or already-settled reply — so the caller drops it. Per-connection scoping
	 * means a reply arriving on the wrong socket resolves nothing.
	 *
	 * @returns whether a pending request was resolved
	 * @mutates this - clears the matched entry from `#pending`
	 */
	resolve_peer_response(
		connection_id: Uuid,
		response: JsonrpcResponse | JsonrpcErrorResponse
	): boolean {
		return this.#pending.resolve(connection_id, response);
	}

	/**
	 * Whether a connection is still registered — and admitted: a registration
	 * pending admission answers `false`, like every other reader of the
	 * transport.
	 *
	 * `register_action_ws` checks it before dispatching each inbound message, so
	 * a socket the server has closed — revoked, superseded by the cap, or
	 * refused at admission — dispatches nothing more while its close handshake
	 * is still in flight. The twin of the Rust `ConnectionRegistry::is_registered`.
	 */
	is_registered(connection_id: Uuid): boolean {
		return this.#connections.get(connection_id)?.admitted === true;
	}

	is_ready(): boolean {
		return this.get_connection_count() > 0;
	}

	/**
	 * Number of currently **admitted** WebSocket connections.
	 *
	 * Read-only counter intended for telemetry, logging, and tests. A
	 * registration still pending admission is not a connection yet and is
	 * counted by `get_pending_connection_count` instead. Includes connections
	 * that have been closed by the peer but not yet removed by the WS adapter's
	 * `onClose` callback.
	 */
	get_connection_count(): number {
		let count = 0;
		for (const entry of this.#connections.values()) {
			if (entry.admitted) count++;
		}
		return count;
	}

	/**
	 * Number of registrations awaiting admission — between `register_pending`
	 * and `admit` (or their refusal). Each lives for one credential re-check, so
	 * a count that stays high means upgrades are stalling there. For telemetry
	 * and tests.
	 */
	get_pending_connection_count(): number {
		let count = 0;
		for (const entry of this.#connections.values()) {
			if (!entry.admitted) count++;
		}
		return count;
	}
}
