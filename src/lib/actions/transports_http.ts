/**
 * HTTP transport — sends JSON-RPC messages via HTTP POST, or GET for a read
 * whose params can ride the URL.
 *
 * @module
 */

import { DEV } from 'esm-env';

import {
	to_thrown_jsonrpc_error,
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
import type { ActionSpecUnion } from './action_spec.ts';
import { schema_has_sensitive_field } from '../schema_meta.ts';

/** Headers every request carries unless the caller's replace them. */
const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'application/json',
	accept: 'application/json'
};

/**
 * The longest path and query a read is sent as a `GET` with — 4096
 * characters. Past it the call goes as a `POST`: a `cell_list` naming its
 * full id cap runs over it, and proxies refuse a request line past their own
 * limit (nginx's default 8 KiB buffer) with a `414` the RPC client could not
 * read.
 */
export const DEFAULT_MAX_GET_URL_LENGTH = 4096;

/** Options for `FrontendHttpTransport`. */
export interface FrontendHttpTransportOptions {
	/** The JSON-RPC endpoint, absolute or relative to the page. */
	url: string;
	/**
	 * Extra headers, merged over the JSON `content-type` and `accept` defaults
	 * case-insensitively — a `POST` without `application/json` is refused
	 * (415). A `GET` carries no `content-type`.
	 */
	headers?: Record<string, string>;
	/**
	 * The spec of a method, which decides how its calls are sent: a request for
	 * a read (`side_effects: false`) is a `GET`, unless its input carries a
	 * `'secret'` or `'personal'` value at any depth (`schema_has_sensitive_field`)
	 * — a `GET` puts the params in the URL, which proxies and server logs
	 * record, so that input stays in a `POST` body. Every other call is a
	 * `POST`, including one for a method the lookup doesn't know.
	 * `create_frontend_rpc_client` passes its registry's lookup; a hand-built
	 * transport passes the same one its dispatcher environment uses.
	 */
	lookup_action_spec: (method: string) => ActionSpecUnion | undefined;
	/**
	 * The longest path and query a read is sent as a `GET` with; a longer one
	 * is a `POST`.
	 *
	 * @default DEFAULT_MAX_GET_URL_LENGTH
	 */
	max_get_url_length?: number;
}

/**
 * Thin `fetch` adapter for the JSON-RPC endpoint. `POST` by default; a
 * request for a read — its spec (`lookup_action_spec`) has `side_effects:
 * false` — is a `GET` with `method`, `id`, and `params` in the query string
 * (matching `create_rpc_endpoint`'s GET convention), unless its input carries
 * a sensitive value (`schema_has_sensitive_field`, checked once per spec) or
 * its path and query run past `max_get_url_length`. A notification, and a
 * call for a method without a spec, is always a `POST`. Always reports ready.
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
	#get_headers: Record<string, string>;
	#lookup_action_spec: (method: string) => ActionSpecUnion | undefined;
	/** Whether each looked-up spec's input carries a sensitive value. */
	#sensitive_input_by_spec: WeakMap<ActionSpecUnion, boolean> = new WeakMap();
	#max_get_url_length: number;

	constructor(options: FrontendHttpTransportOptions) {
		this.#url = options.url;
		this.#headers = { ...DEFAULT_HEADERS };
		if (options.headers) {
			for (const [name, value] of Object.entries(options.headers)) {
				this.#headers[name.toLowerCase()] = value;
			}
		}
		// a GET has no body to describe
		const { 'content-type': _, ...get_headers } = this.#headers;
		this.#get_headers = get_headers;
		this.#lookup_action_spec = options.lookup_action_spec;
		this.#max_get_url_length = options.max_get_url_length ?? DEFAULT_MAX_GET_URL_LENGTH;
	}

	/**
	 * The `GET` URL of `message` when it goes as one: a request for a read
	 * whose input carries no sensitive value and whose path and query fit.
	 */
	#to_get_url(message: JsonrpcMessageFromClientToServer): string | null {
		if (!('id' in message)) return null;
		const spec = this.#lookup_action_spec(message.method);
		// an unknown method is a POST, whatever it does
		if (!spec || spec.side_effects) return null;
		if (this.#has_sensitive_input(spec)) return null;
		const search_params = new URLSearchParams();
		search_params.set('method', message.method);
		search_params.set('id', String(message.id));
		if (message.params !== undefined) {
			search_params.set('params', JSON.stringify(message.params));
		}
		const separator = this.#url.includes('?') ? '&' : '?';
		const url = `${this.#url}${separator}${search_params.toString()}`;
		// the path and query, whatever origin the URL names
		const target = new URL(url, 'http://localhost');
		if (target.pathname.length + target.search.length > this.#max_get_url_length) return null;
		return url;
	}

	#has_sensitive_input(spec: ActionSpecUnion): boolean {
		let sensitive = this.#sensitive_input_by_spec.get(spec);
		if (sensitive === undefined) {
			sensitive = schema_has_sensitive_field(spec.input);
			this.#sensitive_input_by_spec.set(spec, sensitive);
		}
		return sensitive;
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
			const get_url = this.#to_get_url(message);
			const response = get_url
				? await fetch(get_url, { method: 'GET', headers: this.#get_headers, signal })
				: await fetch(this.#url, {
						method: 'POST',
						headers: this.#headers,
						body: JSON.stringify(message),
						signal
					});

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
			const thrown = to_thrown_jsonrpc_error(error);
			if (thrown) return create_jsonrpc_error_response(to_jsonrpc_message_id(message), thrown);
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
