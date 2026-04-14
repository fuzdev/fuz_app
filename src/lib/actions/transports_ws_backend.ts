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

export class BackendWebsocketTransport implements Transport {
	readonly transport_name = 'backend_websocket_rpc' as const;

	// Map connection IDs to WebSocket contexts
	#connections: Map<Uuid, WSContext> = new Map();

	// Reverse map to find connection ID by socket
	#connection_ids: WeakMap<WSContext, Uuid> = new WeakMap();

	// Session auth tracking — parallel maps keyed by connection ID
	#connection_token_hashes: Map<Uuid, string> = new Map();
	#connection_account_ids: Map<Uuid, Uuid> = new Map();

	/**
	 * Add a new WebSocket connection with auth info.
	 * Session connections pass a token hash for targeted revocation.
	 * Bearer token connections (api_token, daemon_token) pass null —
	 * they're still reachable via {@link close_sockets_for_account}.
	 */
	add_connection(ws: WSContext, token_hash: string | null, account_id: Uuid): Uuid {
		const connection_id = create_uuid();
		this.#connections.set(connection_id, ws);
		this.#connection_ids.set(ws, connection_id);
		if (token_hash !== null) {
			this.#connection_token_hashes.set(connection_id, token_hash);
		}
		this.#connection_account_ids.set(connection_id, account_id);
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
	 * Close all sockets associated with a specific session token hash.
	 *
	 * @returns the number of sockets closed
	 */
	close_sockets_for_session(token_hash: string): number {
		let count = 0;
		for (const [connection_id, hash] of this.#connection_token_hashes) {
			if (hash === token_hash) {
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
	 * Close all sockets associated with a specific account.
	 *
	 * @returns the number of sockets closed
	 */
	close_sockets_for_account(account_id: Uuid): number {
		let count = 0;
		for (const [connection_id, id] of this.#connection_account_ids) {
			if (id === account_id) {
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
	 * Remove all tracking state for a connection.
	 */
	#cleanup_connection(connection_id: Uuid, ws: WSContext): void {
		this.#connections.delete(connection_id);
		this.#connection_ids.delete(ws);
		this.#connection_token_hashes.delete(connection_id);
		this.#connection_account_ids.delete(connection_id);
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
