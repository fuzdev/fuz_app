/**
 * HTTP transport — sends JSON-RPC messages via HTTP POST (or GET for reads).
 *
 * @module
 */

import { DEV } from 'esm-env';

import {
	ThrownJsonrpcError,
	jsonrpc_error_messages,
	http_status_to_jsonrpc_error_code,
	jsonrpc_error_code_to_http_status,
	UNKNOWN_ERROR_MESSAGE
} from '../http/jsonrpc_errors.ts';
import {
	create_jsonrpc_error_response,
	to_jsonrpc_message_id,
	is_jsonrpc_error_response,
	is_jsonrpc_response
} from '../http/jsonrpc_helpers.ts';
import {
	JsonrpcErrorResponse,
	type JsonrpcMessageFromClientToServer,
	type JsonrpcMessageFromServerToClient,
	type JsonrpcNotification,
	type JsonrpcRequest,
	type JsonrpcRequestId,
	type JsonrpcResponseOrError
} from '../http/jsonrpc.ts';
import type { Transport, TransportSendOptions } from './transports.ts';

/**
 * Thin `fetch` adapter for the JSON-RPC endpoint. POST by default; GET when
 * the optional `has_side_effects(method)` callback returns `false` for the
 * method (matches `create_rpc_endpoint`'s GET convention). Always reports ready.
 *
 * On non-OK HTTP responses, a body that is a JSON-RPC error response for this
 * request (same `id`, or `null` when the server couldn't read one) is returned
 * as-is, so the server's `code`, `message`, and `data` reach the caller — the
 * status → code map is lossy (`queue_overflow` and `rate_limited` share 429).
 * Any other body (HTML from a proxy, empty, malformed) gets a synthesized
 * envelope whose code comes from `http_status_to_jsonrpc_error_code`.
 * A 2xx whose body isn't a JSON-RPC response (an HTML fallback page, say)
 * becomes an `internal_error` naming the status and content type.
 */
export class FrontendHttpTransport implements Transport {
	readonly transport_name = 'frontend_http_rpc' as const;

	#url: string;
	#headers: Record<string, string>;
	#has_side_effects: ((method: string) => boolean) | undefined;

	constructor(
		url: string,
		headers?: Record<string, string>,
		has_side_effects?: (method: string) => boolean
	) {
		this.#url = url;
		this.#headers = headers ?? { 'content-type': 'application/json', accept: 'application/json' };
		this.#has_side_effects = has_side_effects;
	}

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
		options?: TransportSendOptions
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
					signal
				});
			} else {
				response = await fetch(this.#url, {
					method: 'POST',
					headers: this.#headers,
					body: JSON.stringify(message),
					signal
				});
			}

			if (!response.ok) {
				const id = to_jsonrpc_message_id(message);
				const body = to_error_response_for(await read_json_body(response), id);
				if (body) {
					// The code → status map is a function (the status → code direction is
					// lossy), so drift is checked in that direction.
					if (DEV) {
						const expected_status = jsonrpc_error_code_to_http_status(body.error.code);
						if (expected_status !== response.status) {
							console.warn(
								`[http_transport] JSON-RPC error code ${body.error.code} maps to HTTP ${
									expected_status
								} but the response status is ${response.status}`,
								body
							);
						}
					}
					return body;
				}
				return create_jsonrpc_error_response(id, {
					code: http_status_to_jsonrpc_error_code(response.status),
					message: `HTTP error: ${response.status} ${response.statusText}`.trimEnd()
				});
			}

			const body = await read_json_body(response);
			if (is_jsonrpc_error_response(body)) {
				// JSON-RPC errors should carry a non-2xx status (see `jsonrpc_error_code_to_http_status`).
				if (DEV) {
					console.warn(
						`[http_transport] JSON-RPC error response with HTTP ${response.status}`,
						body
					);
				}
				return body;
			}
			if (is_jsonrpc_response(body)) return body;
			// a 2xx that isn't JSON-RPC — e.g. an HTML page from a static
			// fallback or proxy answering the RPC path
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.internal_error(
					`response is not JSON-RPC: HTTP ${response.status} ${
						response.headers.get('content-type') ?? 'without a content type'
					}`
				)
			);
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) {
				return create_jsonrpc_error_response(to_jsonrpc_message_id(message), {
					code: error.code,
					message: error.message,
					data: error.data
				});
			}
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.internal_error('error sending request', {
					error: (error as Error).message || UNKNOWN_ERROR_MESSAGE
				})
			);
		}
	}

	is_ready(): boolean {
		return true;
	}
}

/** Read a response body as JSON, or `undefined` when it's empty or not JSON. */
const read_json_body = async (response: Response): Promise<unknown> => {
	try {
		return JSON.parse(await response.text());
	} catch {
		return undefined;
	}
};

/**
 * `body` as a well-formed JSON-RPC error response answering the request with
 * `id` — echoing it, or `null` when the server couldn't read one — else `null`.
 * Ids compare as strings: the GET convention sends the id as a query param,
 * so a numeric id comes back as its string form.
 */
const to_error_response_for = (
	body: unknown,
	id: JsonrpcRequestId | null
): JsonrpcErrorResponse | null => {
	const parsed = JsonrpcErrorResponse.safeParse(body);
	if (!parsed.success) return null;
	const response = parsed.data;
	if (response.id !== null && String(response.id) !== String(id)) return null;
	return response;
};
