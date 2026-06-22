/**
 * Backend WebSocket transport — manages server-side WebSocket connections
 * with session tracking and revocation support.
 *
 * @module
 */

import type {WSContext} from 'hono/ws';
import {to_error_message} from '@fuzdev/fuz_util/error.ts';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.ts';

import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcRequestParams,
	JsonrpcResponse,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse,
} from '../http/jsonrpc.ts';
import {jsonrpc_error_messages} from '../http/jsonrpc_errors.ts';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_request,
	to_jsonrpc_message_id,
	is_jsonrpc_request,
} from '../http/jsonrpc_helpers.ts';
import {WS_CLOSE_SESSION_REVOKED, type Transport, type TransportSendOptions} from './transports.ts';
import {
	PendingPeerRequests,
	type PeerRequestOptions,
	type PeerRequestOutcome,
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
		predicate: (identity: ConnectionIdentity) => boolean,
	) => number;
}

/** Type guard for `FilterableBroadcastTransport`. */
export const is_filterable_broadcast_transport = (
	transport: Transport,
): transport is FilterableBroadcastTransport =>
	'broadcast_filtered' in transport &&
	typeof (transport as FilterableBroadcastTransport).broadcast_filtered === 'function';

export class BackendWebsocketTransport implements FilterableBroadcastTransport {
	readonly transport_name = 'backend_websocket_rpc' as const;

	// Map connection IDs to WebSocket contexts
	#connections: Map<Uuid, WSContext> = new Map();

	// Reverse map to find connection ID by socket
	#connection_ids: WeakMap<WSContext, Uuid> = new WeakMap();

	// Auth identity per connection. Adding a new identity scope (e.g.
	// `device_id`) means adding a field here, not a new parallel map.
	#connection_identities: Map<Uuid, ConnectionIdentity> = new Map();

	// Server→client request correlation (ActionPeer). The transport owns the
	// sockets + the send; the registry owns the pending map, id allocation,
	// deadlines, and the per-connection in-flight cap (see `peer_request.ts`).
	#pending: PendingPeerRequests = new PendingPeerRequests();

	/**
	 * Add a new WebSocket connection with auth info.
	 * Session connections pass a token hash for targeted revocation.
	 * Bearer token connections (`api_token`) pass the `api_token.id` so the
	 * socket can be closed when that specific token is revoked without
	 * tearing down the account's other sockets. Daemon-token connections
	 * pass `null` for both — they're only reachable via
	 * `close_sockets_for_account`.
	 *
	 * @returns the freshly assigned `connection_id` (branded `Uuid`)
	 * @mutates this - inserts into `#connections`, `#connection_ids`, and
	 *   `#connection_identities`
	 */
	add_connection(
		ws: WSContext,
		token_hash: string | null,
		account_id: Uuid,
		api_token_id: string | null = null,
	): Uuid {
		const connection_id = create_uuid();
		this.#connections.set(connection_id, ws);
		this.#connection_ids.set(ws, connection_id);
		this.#connection_identities.set(connection_id, {token_hash, account_id, api_token_id});
		return connection_id;
	}

	/**
	 * Remove a WebSocket connection and its auth tracking data.
	 * Idempotent — safe to call after revocation has already cleaned up.
	 *
	 * @mutates this - deletes the connection's entries from `#connections`,
	 *   `#connection_ids`, and `#connection_identities`
	 */
	remove_connection(ws: WSContext): void {
		const connection_id = this.#connection_ids.get(ws);
		if (connection_id) {
			this.#cleanup_connection(connection_id, ws);
		}
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

	#cleanup_connection(connection_id: Uuid, ws: WSContext): void {
		this.#connections.delete(connection_id);
		this.#connection_ids.delete(ws);
		this.#connection_identities.delete(connection_id);
		// Wake any handler still awaiting a reply on this socket — the peer is
		// gone, so the request can never complete.
		this.#pending.drain(connection_id);
	}

	#revoke_connection(connection_id: Uuid, ws: WSContext): void {
		this.#cleanup_connection(connection_id, ws);
		ws.close(WS_CLOSE_SESSION_REVOKED, 'Session revoked');
	}

	// `send` is the broadcast/notification surface: notifications fan out to
	// every socket. A *request* has no single target here — server→client
	// request/response is `request_connection`, which targets one socket and
	// correlates the reply. `send(request)` is therefore a misuse and returns
	// an error rather than guessing a recipient.
	async send(
		message: JsonrpcRequest,
		options?: TransportSendOptions,
	): Promise<JsonrpcResponseOrError>;
	async send(
		message: JsonrpcNotification,
		options?: TransportSendOptions,
	): Promise<JsonrpcErrorResponse | null>;
	async send(
		message: JsonrpcMessageFromClientToServer,
		_options?: TransportSendOptions,
	): Promise<JsonrpcMessageFromServerToClient | null> {
		if (is_jsonrpc_request(message)) {
			return create_jsonrpc_error_response(
				message.id,
				jsonrpc_error_messages.internal_error(
					'backend WebSocket transport cannot broadcast a request expecting a response; ' +
						'use request_connection(connection_id, ...) to target a single socket',
				),
			);
		}

		try {
			await this.#broadcast(message);
			return null;
		} catch (error) {
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.internal_error(
					to_error_message(error, 'failed to broadcast notification'),
				),
			);
		}
	}

	#broadcast(message: JsonrpcMessageFromServerToClient): Promise<void> {
		const serialized = JSON.stringify(message);
		for (const ws of this.#connections.values()) {
			try {
				ws.send(serialized);
			} catch (error) {
				console.error('[backend websocket transport] Error broadcasting to client:', error);
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
		predicate: (identity: ConnectionIdentity) => boolean,
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
				console.error(
					'[backend websocket transport] Error broadcasting filtered to client:',
					error,
				);
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
		options?: PeerRequestOptions,
	): Promise<PeerRequestOutcome> {
		const ws = this.#connections.get(connection_id);
		if (!ws) return Promise.resolve({ok: false, error: {kind: 'connection_gone'}});

		const registered = this.#pending.register(connection_id, options?.timeout_ms);
		if (!registered) return Promise.resolve({ok: false, error: {kind: 'too_many_in_flight'}});
		const {id, outcome} = registered;

		try {
			ws.send(JSON.stringify(create_jsonrpc_request(method, params, id)));
		} catch {
			// Send failed — the socket is gone; settle now so the caller isn't
			// left awaiting until the deadline.
			this.#pending.settle(connection_id, id, {ok: false, error: {kind: 'connection_gone'}});
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
		response: JsonrpcResponse | JsonrpcErrorResponse,
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
