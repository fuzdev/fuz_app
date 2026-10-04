/**
 * Backend WebSocket transport — manages server-side WebSocket connections
 * with session tracking, revocation support, and a per-account connection
 * cap.
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

export class BackendWebsocketTransport implements FilterableBroadcastTransport {
	readonly transport_name = 'backend_websocket_rpc' as const;

	// Per-account connection cap; `null` = uncapped.
	readonly #max_connections_per_account: number | null;

	readonly #log: Logger | null;

	// Map connection IDs to WebSocket contexts
	#connections: Map<Uuid, WSContext> = new Map();

	// Auth identity per connection. Adding a new identity scope (e.g.
	// `device_id`) means adding a field here, not a new parallel map.
	#connection_identities: Map<Uuid, ConnectionIdentity> = new Map();

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
	 * Add a new WebSocket connection with auth info.
	 * Session connections pass a token hash for targeted revocation.
	 * Bearer token connections (`api_token`) pass the `api_token.id` so the
	 * socket can be closed when that specific token is revoked without
	 * tearing down the account's other sockets. Daemon-token connections
	 * pass `null` for both — they're only reachable via
	 * `close_sockets_for_account`.
	 *
	 * Enforces the per-account cap (`max_connections_per_account`): when
	 * `account_id` already holds the maximum, its oldest connections are removed
	 * and sent a `WS_CLOSE_CONNECTION_LIMIT` close before the new one is
	 * inserted. A removed connection gets no further broadcast or peer request
	 * and stops counting toward the cap at once; its socket is closed when the
	 * close handshake completes. The new connection is always admitted. Call
	 * this only after every upgrade gate has passed, so a refused request can
	 * never close someone else's socket.
	 *
	 * @returns the freshly assigned `connection_id` (branded `Uuid`)
	 * @mutates this - inserts into `#connections` and `#connection_identities`;
	 *   past the cap, first removes the account's oldest connections from them
	 *   and closes their `WSContext`
	 */
	add_connection(
		ws: WSContext,
		token_hash: string | null,
		account_id: Uuid,
		api_token_id: string | null = null
	): Uuid {
		if (this.#max_connections_per_account !== null) {
			this.#evict_oldest_for_account(account_id, this.#max_connections_per_account);
		}
		const connection_id = create_uuid();
		this.#connections.set(connection_id, ws);
		this.#connection_identities.set(connection_id, { token_hash, account_id, api_token_id });
		return connection_id;
	}

	/**
	 * Remove a WebSocket connection and its auth tracking data, by the id
	 * `add_connection` returned. Idempotent — safe to call after revocation or
	 * a cap eviction has already cleaned up, and a no-op for an unknown id.
	 *
	 * Keyed by id rather than by `WSContext` because a runtime adapter may hand
	 * each socket event its own context object (`hono/bun` does), so the one a
	 * close event carries can't identify the connection.
	 *
	 * @mutates this - deletes the connection's entries from `#connections` and
	 *   `#connection_identities`, and settles its pending peer requests as
	 *   `connection_gone`
	 */
	remove_connection(connection_id: Uuid): void {
		this.#cleanup_connection(connection_id);
	}

	/**
	 * Close every connection whose identity matches the predicate.
	 *
	 * @returns the number of sockets closed
	 */
	#close_where(predicate: (identity: ConnectionIdentity) => boolean): number {
		let count = 0;
		for (const [connection_id, identity] of this.#connection_identities) {
			if (predicate(identity)) {
				const ws = this.#connections.get(connection_id);
				if (ws) {
					this.#revoke_connection(connection_id, ws);
					count++;
				}
			}
		}
		return count;
	}

	/**
	 * Close all sockets associated with a specific session token hash.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections from internal maps and
	 *   closes their underlying `WSContext` with `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_session(token_hash: string): number {
		return this.#close_where((id) => id.token_hash === token_hash);
	}

	/**
	 * Close all sockets associated with a specific account.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections from internal maps and
	 *   closes their underlying `WSContext` with `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_account(account_id: Uuid): number {
		return this.#close_where((id) => id.account_id === account_id);
	}

	/**
	 * Close all sockets associated with a specific API token.
	 *
	 * Used on `token_revoke` audit events so revoking one token doesn't
	 * tear down the account's session-authenticated sockets or other
	 * tokens' sockets.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections from internal maps and
	 *   closes their underlying `WSContext` with `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_token(api_token_id: string): number {
		return this.#close_where((id) => id.api_token_id === api_token_id);
	}

	#cleanup_connection(connection_id: Uuid): void {
		this.#connections.delete(connection_id);
		this.#connection_identities.delete(connection_id);
		// Wake any handler still awaiting a reply on this socket — the peer is
		// gone, so the request can never complete.
		this.#pending.drain(connection_id);
	}

	#revoke_connection(connection_id: Uuid, ws: WSContext): void {
		this.#cleanup_connection(connection_id);
		ws.close(WS_CLOSE_SESSION_REVOKED, 'Session revoked');
	}

	/**
	 * Make room for one more connection on `account_id`: when the account
	 * already holds `max`, close its oldest so that `max - 1` remain.
	 */
	#evict_oldest_for_account(account_id: Uuid, max: number): void {
		// Map iteration is insertion order, so `owned` is oldest-first
		const owned: Array<Uuid> = [];
		for (const [connection_id, identity] of this.#connection_identities) {
			if (identity.account_id === account_id) owned.push(connection_id);
		}
		const excess = owned.length + 1 - max;
		if (excess <= 0) return;
		for (let i = 0; i < excess; i++) {
			const connection_id = owned[i]!;
			const ws = this.#connections.get(connection_id);
			if (ws) this.#supersede_connection(connection_id, ws);
		}
		// same line as the Rust spine's registry, so one grep finds either
		this.#log?.info('ws: connection cap closed oldest', { account_id, closed: excess, max });
	}

	#supersede_connection(connection_id: Uuid, ws: WSContext): void {
		this.#cleanup_connection(connection_id);
		try {
			ws.close(WS_CLOSE_CONNECTION_LIMIT, 'connection limit');
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
		for (const ws of this.#connections.values()) {
			try {
				ws.send(serialized);
			} catch (error) {
				this.#log?.error('error broadcasting to client:', error);
			}
		}
		// TODO hack - remove if not ever needed, I assume this will need to be async so let's hold that assumption
		return Promise.resolve();
	}

	/**
	 * Broadcast to connections whose identity satisfies a predicate.
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
		for (const [connection_id, identity] of this.#connection_identities) {
			if (!predicate(identity)) continue;
			const ws = this.#connections.get(connection_id);
			if (!ws) continue;
			try {
				ws.send(serialized);
				count++;
			} catch (error) {
				this.#log?.error('error broadcasting filtered to client:', error);
			}
		}
		return count;
	}

	/**
	 * Send a message to every socket bound to a specific account.
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
	 * (`connection_gone`). Never throws — every failure is a `PeerRequestError`.
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
		const ws = this.#connections.get(connection_id);
		if (!ws) return Promise.resolve({ ok: false, error: { kind: 'connection_gone' } });

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

	is_ready(): boolean {
		return this.#connections.size > 0;
	}

	/**
	 * Number of currently tracked WebSocket connections.
	 *
	 * Read-only counter intended for telemetry, logging, and tests.
	 * Counts every entry in the connection map — including connections
	 * that have been closed by the peer but not yet removed by the WS
	 * adapter's `onClose` callback.
	 */
	get_connection_count(): number {
		return this.#connections.size;
	}
}
