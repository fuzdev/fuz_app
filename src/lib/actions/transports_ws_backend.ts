/**
 * Backend WebSocket transport — manages server-side WebSocket connections
 * with session tracking and revocation support.
 *
 * @module
 */

import type {WSContext} from 'hono/ws';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.js';

import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse,
} from '../http/jsonrpc.js';
import {jsonrpc_error_messages} from '../http/jsonrpc_errors.js';
import {
	create_jsonrpc_error_response,
	to_jsonrpc_message_id,
	is_jsonrpc_request,
} from '../http/jsonrpc_helpers.js';
import {WS_CLOSE_SESSION_REVOKED, type Transport, type TransportSendOptions} from './transports.js';

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
	}

	#revoke_connection(connection_id: Uuid, ws: WSContext): void {
		this.#cleanup_connection(connection_id, ws);
		ws.close(WS_CLOSE_SESSION_REVOKED, 'Session revoked');
	}

	// TODO needs implementation, only broadcasts notifications for now
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
		// TODO currently just broadcasts all messages to all clients, the transport abstraction is still a WIP
		if (is_jsonrpc_request(message)) {
			return create_jsonrpc_error_response(
				message.id,
				// TODO maybe use a not yet implemented error message?
				jsonrpc_error_messages.internal_error(
					'TODO not yet implemented - backend WebSocket transport cannot send requests expecting responses yet',
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
					error instanceof Error ? error.message : 'failed to broadcast notification',
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
	 * (e.g. tx's `tx_run_created` only reaches the account that owns the run).
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
