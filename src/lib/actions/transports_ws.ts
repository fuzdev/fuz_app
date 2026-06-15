/**
 * Frontend WebSocket transport — thin adapter over `WebsocketRpcConnection`.
 *
 * Delegates request/response correlation, the durable queue, the heartbeat,
 * and `AbortSignal`-driven cancel to the underlying connection (the
 * canonical implementation is `FrontendWebsocketClient`). The transport's
 * own job is the `Transport` contract: route inbound server-pushed
 * messages into `peer.receive` and translate the connection's
 * `Promise<R>`/`ThrownJsonrpcError` shape into `JsonrpcResponseOrError`
 * envelopes. No parallel pending-request map.
 *
 * @module
 */

import {to_error_message} from '@fuzdev/fuz_util/error.js';

import {ThrownJsonrpcError, jsonrpc_error_messages} from '../http/jsonrpc_errors.js';
import {
	is_jsonrpc_notification,
	is_jsonrpc_request,
	to_jsonrpc_message_id,
	to_jsonrpc_result,
	create_jsonrpc_response,
	create_jsonrpc_error_response,
} from '../http/jsonrpc_helpers.js';
import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcRequestId,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse,
} from '../http/jsonrpc.js';
import type {Transport, TransportSendOptions} from './transports.js';

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

/**
 * RPC-capable WebSocket connection — a `WebsocketConnection` that also
 * handles request/response correlation with timeout, queue,
 * `AbortSignal` cancel, and explicit-id support. Required by
 * `FrontendWebsocketTransport` so it can delegate the pending-map
 * bookkeeping to one canonical implementation
 * (`FrontendWebsocketClient`) instead of running a parallel one.
 *
 * Consumer wrappers around `FrontendWebsocketClient` (e.g. zzz's
 * `Socket`) implement this by adding a one-line delegate to the
 * underlying client's `request`.
 */
export interface WebsocketRpcConnection extends WebsocketConnection {
	request: (
		method: string,
		params: unknown,
		options?: {signal?: AbortSignal; queue?: boolean; id?: JsonrpcRequestId},
	) => Promise<unknown>;
}

/**
 * Thin adapter over `WebsocketRpcConnection` (canonical implementation:
 * `FrontendWebsocketClient`). Routes inbound server-pushed requests and
 * notifications into the supplied `receive` callback; responses are owned
 * by the connection's own `request()` pending map and are ignored here.
 */
export class FrontendWebsocketTransport implements Transport {
	readonly transport_name = 'frontend_websocket_rpc' as const;

	#connection: WebsocketRpcConnection;
	#receive: (data: unknown) => Promise<unknown>;
	#remove_message_handler: (() => void) | null;
	#remove_error_handler: (() => void) | null;

	constructor(connection: WebsocketRpcConnection, receive: (data: unknown) => Promise<unknown>) {
		this.#connection = connection;
		this.#receive = receive;

		// Inbound dispatch — only server-pushed requests/notifications need
		// routing here. Responses to requests we sent are correlated by the
		// connection's own `request()` pending map.
		this.#remove_message_handler = connection.add_message_handler(async (event) => {
			try {
				const data = JSON.parse(event.data);

				if (is_jsonrpc_request(data) || is_jsonrpc_notification(data)) {
					await this.#receive(data);
				}
				// Responses are owned by `connection.request()` — ignore here.
			} catch (error) {
				console.error('[ws_transport] error parsing WebSocket message:', error);
			}
		});

		this.#remove_error_handler = connection.add_error_handler((event) => {
			console.error('[ws_transport] WebSocket error:', event);
		});
	}

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
		options?: TransportSendOptions,
	): Promise<JsonrpcMessageFromServerToClient | null> {
		// Notifications fail-fast when disconnected regardless of `queue` —
		// `connection.send()` is fire-and-forget with no queue semantic, so
		// silently dropping would masquerade as success at the rpc_client
		// layer (caller would see `{ok: true}` for a lost message).
		//
		// Requests have no such gate here: `connection.request()` throws
		// `ThrownJsonrpcError` with the right code (`service_unavailable`
		// when not connected, `queue_overflow` when the durable queue is
		// full, `request_cancelled` on abort, server's wire code for peer
		// error frames), and the catch block below preserves that code
		// verbatim in the error envelope. Queuing is routed via `queue`.
		const queue = options?.queue ?? false;
		if (is_jsonrpc_notification(message) && !this.is_ready()) {
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.service_unavailable('WebSocket not connected'),
			);
		}

		if (is_jsonrpc_request(message)) {
			try {
				const result = await this.#connection.request(message.method, message.params, {
					id: message.id,
					signal: options?.signal,
					queue,
				});
				return create_jsonrpc_response(message.id, to_jsonrpc_result(result));
			} catch (error) {
				if (error instanceof ThrownJsonrpcError) {
					return create_jsonrpc_error_response(message.id, {
						code: error.code,
						message: error.message,
						data: error.data,
					});
				}
				return create_jsonrpc_error_response(
					message.id,
					jsonrpc_error_messages.internal_error(to_error_message(error)),
				);
			}
		}

		if (is_jsonrpc_notification(message)) {
			this.#connection.send(message);
			return null;
		}

		return create_jsonrpc_error_response(
			to_jsonrpc_message_id(message),
			jsonrpc_error_messages.invalid_request(),
		);
	}

	is_ready(): boolean {
		return this.#connection.connected;
	}

	/**
	 * Detach the inbound message and error handlers registered on the
	 * connection. Idempotent — subsequent calls no-op. Does not close the
	 * underlying connection (that lifecycle is owned by the caller).
	 *
	 * @mutates this - clears the two stored unsubscribe references after invoking them
	 */
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
