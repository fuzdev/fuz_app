/**
 * HTTP transport — sends JSON-RPC messages via HTTP POST (or GET for reads).
 *
 * @module
 */

import {DEV} from 'esm-env';

import {
	ThrownJsonrpcError,
	jsonrpc_error_messages,
	http_status_to_jsonrpc_error_code,
	UNKNOWN_ERROR_MESSAGE,
} from '../http/jsonrpc_errors.js';
import {
	create_jsonrpc_error_response,
	to_jsonrpc_message_id,
	is_jsonrpc_error_response,
} from '../http/jsonrpc_helpers.js';
import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse,
} from '../http/jsonrpc.js';
import type {Transport, TransportSendOptions} from './transports.js';

export class FrontendHttpTransport implements Transport {
	readonly transport_name = 'frontend_http_rpc' as const;

	#url: string;
	#headers: Record<string, string>;
	#has_side_effects: ((method: string) => boolean) | undefined;

	constructor(
		url: string,
		headers?: Record<string, string>,
		has_side_effects?: (method: string) => boolean,
	) {
		this.#url = url;
		this.#headers = headers ?? {'content-type': 'application/json', accept: 'application/json'};
		this.#has_side_effects = has_side_effects;
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
		const signal = options?.signal;
		try {
			let response: Response;
			if (this.#has_side_effects && !this.#has_side_effects(message.method) && 'id' in message) {
				// GET for read-only actions (matching fuz_app's create_rpc_endpoint GET convention)
				const search_params = new URLSearchParams();
				search_params.set('method', message.method);
				search_params.set('id', String(message.id));
				if (message.params !== undefined) {
					search_params.set('params', JSON.stringify(message.params));
				}
				const separator = this.#url.includes('?') ? '&' : '?';
				response = await fetch(`${this.#url}${separator}${search_params.toString()}`, {
					method: 'GET',
					headers: this.#headers,
					signal,
				});
			} else {
				response = await fetch(this.#url, {
					method: 'POST',
					headers: this.#headers,
					body: JSON.stringify(message),
					signal,
				});
			}

			const result = await response.json();

			// For JSON-RPC, we always expect a 200 OK response.
			// The actual error will be in the JSON-RPC error field.
			if (!response.ok) {
				return create_jsonrpc_error_response(to_jsonrpc_message_id(message), {
					code: http_status_to_jsonrpc_error_code(response.status),
					message: `HTTP error: ${response.status} ${response.statusText}`,
				});
			}

			// In development, check if we got a JSON-RPC error with HTTP 200
			// and verify the error code matches the expected HTTP status.
			if (DEV && is_jsonrpc_error_response(result)) {
				const expected_code = http_status_to_jsonrpc_error_code(response.status);
				const actual_code = result.error.code;
				if (actual_code !== expected_code) {
					console.warn(
						`[http_transport] JSON-RPC error code mismatch: got ${actual_code} but ${response.status} should map to ${expected_code}`,
						result,
					);
				}
			}

			return result;
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
				jsonrpc_error_messages.internal_error('error sending request', {
					error: (error as Error).message || UNKNOWN_ERROR_MESSAGE,
				}),
			);
		}
	}

	is_ready(): boolean {
		return true;
	}
}
