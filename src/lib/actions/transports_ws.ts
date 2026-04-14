/**
 * WebSocket transport — sends JSON-RPC messages via WebSocket with request tracking.
 *
 * @module
 */

import {
	ThrownJsonrpcError,
	jsonrpc_error_messages,
	UNKNOWN_ERROR_MESSAGE,
} from '../http/jsonrpc_errors.js';
import {
	is_jsonrpc_notification,
	is_jsonrpc_request,
	is_jsonrpc_response,
	is_jsonrpc_error_response,
	to_jsonrpc_message_id,
	create_jsonrpc_error_response,
} from '../http/jsonrpc_helpers.js';
import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse,
} from '../http/jsonrpc.js';
import {RequestTracker} from './request_tracker.svelte.js';
import type {Transport} from './transports.js';

// TODO logging - maybe add a getter to Cell that falls back to the app logger?

/**
 * Minimal interface for a WebSocket connection, decoupled from the concrete Socket Cell.
 */
export interface WebsocketConnection {
	send: (data: object) => boolean;
	readonly connected: boolean;
	add_message_handler: (handler: (event: MessageEvent) => void) => () => void;
	add_error_handler: (handler: (event: Event) => void) => () => void;
}

export class FrontendWebsocketTransport implements Transport {
	readonly transport_name = 'frontend_websocket_rpc' as const;

	#connection: WebsocketConnection;
	#receive: (data: unknown) => Promise<unknown>;
	#request_tracker: RequestTracker;
	#remove_message_handler: (() => void) | null;
	#remove_error_handler: (() => void) | null;

	constructor(
		connection: WebsocketConnection,
		receive: (data: unknown) => Promise<unknown>,
		request_timeout_ms?: number,
	) {
		this.#connection = connection;
		this.#receive = receive;
		this.#request_tracker = new RequestTracker(request_timeout_ms);

		// TODO maybe we want to do this setup elsewhere, not hardcoded like this
		this.#remove_message_handler = connection.add_message_handler(async (event) => {
			try {
				const data = JSON.parse(event.data);

				// TODO the `data.id !== null` check should be refactored, maybe we want the "Error Message Response" concept for non-null ids
				// Check if this is a response to one of our requests
				if (is_jsonrpc_response(data) || (is_jsonrpc_error_response(data) && data.id !== null)) {
					// This is a response to a request we sent
					this.#request_tracker.handle_message(data);
				} else if (is_jsonrpc_request(data) || is_jsonrpc_notification(data)) {
					// This is a new request/notification from the server
					await this.#receive(data);
				} else {
					console.warn('[ws_transport] received unknown message type:', data);
				}
			} catch (error) {
				console.error('[ws_transport] error parsing WebSocket message:', error);
				// TODO maybe send the whole thing back wrapped in an error?
				// can't reference anything else for a response
			}
		});

		this.#remove_error_handler = connection.add_error_handler((event) => {
			console.error('[ws_transport] WebSocket error:', event);
		});
	}

	async send(message: JsonrpcRequest): Promise<JsonrpcResponseOrError>;
	async send(message: JsonrpcNotification): Promise<JsonrpcErrorResponse | null>;
	async send(
		message: JsonrpcMessageFromClientToServer,
	): Promise<JsonrpcMessageFromServerToClient | null> {
		if (!this.is_ready()) {
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.service_unavailable('WebSocket not connected'),
			);
		}

		try {
			// If this is a JSON-RPC request with an id (not a notification), set up request tracking.
			if (is_jsonrpc_request(message)) {
				// TODO track the whole request?
				const deferred = this.#request_tracker.track_request(message.id);
				this.#connection.send(message);

				// Return the promise that will resolve when the response is received
				const result = await deferred.promise;
				return result;
			} else if (is_jsonrpc_notification(message)) {
				// For notifications, just send without tracking
				this.#connection.send(message);
				return null;
			}
			// Invalid message type - return error with id if available
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.invalid_request(),
			);
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) {
				return create_jsonrpc_error_response(to_jsonrpc_message_id(message), {
					code: error.code,
					message: error.message,
					data: error.data,
				});
			}
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.internal_error((error as Error).message || UNKNOWN_ERROR_MESSAGE),
			);
		}
	}

	is_ready(): boolean {
		return this.#connection.connected;
	}

	dispose(): void {
		if (this.#remove_message_handler) {
			this.#remove_message_handler();
			this.#remove_message_handler = null;
		}
		if (this.#remove_error_handler) {
			this.#remove_error_handler();
			this.#remove_error_handler = null;
		}
	}
}
