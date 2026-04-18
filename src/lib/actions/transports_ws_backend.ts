/**
 * Backend WebSocket transport — manages server-side WebSocket connections
 * with session tracking and revocation support.
 *
 * @module
 */

import type {WSContext} from 'hono/ws';

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
import {create_uuid, type Uuid} from '../uuid.js';
import {WS_CLOSE_SESSION_REVOKED, type Transport} from './transports.js';

// TODO support a SSE backend transport

/**
 * Auth identity attached to a single WebSocket connection.
 *
 * One record per connection. `token_hash` is set for cookie-session
 * connections, `api_token_id` for bearer (`api_token`) connections, and
 * both are null for daemon-token connections (reachable only via
 * {@link BackendWebsocketTransport.close_sockets_for_account}).
 */
export interface ConnectionIdentity {
	/** Blake3 session token hash, or null for non-session credentials. */
	token_hash: string | null;
	/** Authenticated account id. Always set. */
	account_id: Uuid;
	/** `api_token.id` for bearer-authenticated connections, else null. */
	api_token_id: string | null;
}

export class BackendWebsocketTransport implements Transport {
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
	 * Bearer token connections (api_token) pass the `api_token.id` so the
	 * socket can be closed when that specific token is revoked without
	 * tearing down the account's other sockets. Daemon-token connections
	 * pass `null` for both — they're only reachable via
	 * {@link close_sockets_for_account}.
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
	 */
	close_sockets_for_session(token_hash: string): number {
		return this.#close_where((id) => id.token_hash === token_hash);
	}

	/**
	 * Close all sockets associated with a specific account.
	 *
	 * @returns the number of sockets closed
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
	 */
	close_sockets_for_token(api_token_id: string): number {
		return this.#close_where((id) => id.api_token_id === api_token_id);
	}

	/**
	 * Remove all tracking state for a connection.
	 */
	#cleanup_connection(connection_id: Uuid, ws: WSContext): void {
		this.#connections.delete(connection_id);
		this.#connection_ids.delete(ws);
		this.#connection_identities.delete(connection_id);
	}

	/**
	 * Clean up a connection and close its socket with a revocation code.
	 */
	#revoke_connection(connection_id: Uuid, ws: WSContext): void {
		this.#cleanup_connection(connection_id, ws);
		ws.close(WS_CLOSE_SESSION_REVOKED, 'Session revoked');
	}

	// TODO needs implementation, only broadcasts notifications for now
	async send(message: JsonrpcRequest): Promise<JsonrpcResponseOrError>;
	async send(message: JsonrpcNotification): Promise<JsonrpcErrorResponse | null>;
	async send(
		message: JsonrpcMessageFromClientToServer,
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

	/**
	 * Broadcast a message to all connected clients.
	 */
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

	is_ready(): boolean {
		return this.#connections.size > 0;
	}
}
