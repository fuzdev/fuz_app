/**
 * JSON-RPC message builders, type guards, and converters.
 *
 * Used by the SAES runtime (ActionEvent, ActionDispatcher, transports) and
 * the RPC endpoint dispatcher. Complements `http/jsonrpc.ts` (schemas) and
 * `http/jsonrpc_errors.ts` (error infrastructure).
 *
 * @module
 */

import { DEV } from 'esm-env';

import {
	JsonrpcRequest,
	type JsonrpcErrorObject,
	type JsonrpcErrorResponse,
	type JsonrpcMethod,
	type JsonrpcNotification,
	type JsonrpcNotificationParams,
	type JsonrpcRequestId,
	type JsonrpcRequestParams,
	type JsonrpcResponse,
	type JsonrpcResult,
	type JsonrpcErrorCode,
	JSONRPC_VERSION
} from './jsonrpc.ts';
import {
	JSONRPC_ERROR_CODES,
	dev_only,
	jsonrpc_error_messages,
	to_thrown_jsonrpc_error
} from './jsonrpc_errors.ts';

// --- Message builders ---

/** Creates a JSON-RPC request message. */
export const create_jsonrpc_request = (
	method: JsonrpcMethod,
	params: JsonrpcRequestParams | undefined,
	id: JsonrpcRequestId
): JsonrpcRequest => {
	const message: JsonrpcRequest = {
		jsonrpc: JSONRPC_VERSION,
		id,
		method
	};
	if (params !== undefined) {
		message.params = params;
	}
	return message;
};

/** Creates a JSON-RPC success response message. */
export const create_jsonrpc_response = (
	id: JsonrpcRequestId,
	result: JsonrpcResult
): JsonrpcResponse => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	result
});

/** Creates a JSON-RPC notification message (no id, no response expected). */
export const create_jsonrpc_notification = (
	method: JsonrpcMethod,
	params: JsonrpcNotificationParams | undefined
): JsonrpcNotification => {
	const message: JsonrpcNotification = {
		jsonrpc: JSONRPC_VERSION,
		method
	};
	if (params !== undefined) {
		message.params = params;
	}
	return message;
};

/** Creates a JSON-RPC error response message. */
export const create_jsonrpc_error_response = (
	id: JsonrpcErrorResponse['id'],
	error: JsonrpcErrorResponse['error']
): JsonrpcErrorResponse => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	error
});

/**
 * Creates a JSON-RPC error response from any error.
 * Handles a thrown JSON-RPC error — a `ThrownJsonrpcError` from any copy of
 * fuz_app, recognized by its brand (`to_thrown_jsonrpc_error`) — by
 * preserving its code/message/data, and maps any other `Error`, a foreign
 * class carrying a JSON-RPC `code` included, to internal_error, with its
 * message and stack in DEV.
 */
export const create_jsonrpc_error_response_from_thrown = (
	id: JsonrpcRequestId | null,
	error: unknown
): JsonrpcErrorResponse => {
	let code: JsonrpcErrorCode = JSONRPC_ERROR_CODES.internal_error;
	let message = 'internal server error';
	let data: unknown = undefined;

	const thrown = to_thrown_jsonrpc_error(error);
	if (thrown) {
		code = thrown.code;
		message = thrown.message;
		data = thrown.data;
	} else if (error instanceof Error) {
		if (DEV) {
			message = error.message;
			data = { stack: error.stack };
		}
	}

	return {
		jsonrpc: JSONRPC_VERSION,
		id,
		error: {
			code,
			message,
			data
		}
	};
};

// --- Type guards ---

/** Checks if a value is a valid JSON-RPC request id (string or finite number). */
export const is_jsonrpc_request_id = (id: unknown): id is JsonrpcRequestId => {
	const type = typeof id;
	return type === 'string' || (type === 'number' && !Number.isNaN(id) && Number.isFinite(id));
};

/** Checks if a value is a JSON-RPC object (has `jsonrpc: '2.0'`). */
export const is_jsonrpc_object = (
	message: unknown
): message is { jsonrpc: typeof JSONRPC_VERSION } =>
	typeof message === 'object' &&
	message !== null &&
	!Array.isArray(message) &&
	(message as any).jsonrpc === JSONRPC_VERSION;

/** Checks if a value is a JSON-RPC request (has method + id). */
export const is_jsonrpc_request = (message: unknown): message is JsonrpcRequest =>
	is_jsonrpc_object(message) && 'method' in message && 'id' in message;

/** Checks if a value is a JSON-RPC notification (has method, no id). */
export const is_jsonrpc_notification = (message: unknown): message is JsonrpcNotification =>
	is_jsonrpc_object(message) && 'method' in message && !('id' in message);

/** Checks if a value is a JSON-RPC success response (has result + id). */
export const is_jsonrpc_response = (message: unknown): message is JsonrpcResponse =>
	is_jsonrpc_object(message) && 'result' in message && 'id' in message;

/** Checks if a value is a JSON-RPC error response (has error + id). */
export const is_jsonrpc_error_response = (message: unknown): message is JsonrpcErrorResponse =>
	is_jsonrpc_object(message) && 'error' in message && 'id' in message;

// --- Converters ---

/**
 * Extracts a JSON-RPC request id from a message or raw value.
 * Returns `null` if no valid id can be extracted.
 */
export const to_jsonrpc_message_id = (message_or_id: unknown): JsonrpcRequestId | null => {
	if (message_or_id == null) return null;

	const maybe_id =
		typeof message_or_id === 'object' ? (message_or_id as { id?: unknown }).id : message_or_id;

	return is_jsonrpc_request_id(maybe_id) ? maybe_id : null;
};

/**
 * Normalizes input to JSON-RPC params format.
 * Returns `undefined` for null/undefined, wraps primitives in `{value}`.
 */
export const to_jsonrpc_params = (input: unknown): Record<string, any> | undefined => {
	if (input === undefined || input === null) {
		return undefined;
	}
	if (typeof input === 'object' && !Array.isArray(input)) {
		return input as Record<string, any>;
	}
	return { value: input };
};

// --- Classification ---

/**
 * A parsed JSON value classified as a JSON-RPC message by
 * `classify_jsonrpc_message` — transport-agnostic, each transport applying
 * its own semantics to the arms:
 *
 * - `request` — a valid request envelope, ready for dispatch.
 * - `notification` — a string `method` and no `id` key. `params` is handed
 *   back unvalidated (a notification has no id to answer an error on).
 *   The WebSocket path routes `cancel` and drops every other one; HTTP
 *   answers `invalid_request` with `id: null`.
 * - `response` — no string `method`, a string or number `id`, and exactly
 *   one of `result` / `error`: a reply to a server-initiated request. The
 *   WebSocket path routes it to the pending peer request; HTTP issues no
 *   server-initiated requests, so it answers `invalid_request` with `id: null`.
 * - `invalid` — the error to answer and the id to answer it on.
 *
 * Twin of the Rust spine's `fuz_http::Classified`.
 */
export type ClassifiedJsonrpcMessage =
	| { kind: 'request'; request: JsonrpcRequest }
	| { kind: 'notification'; method: JsonrpcMethod; params: unknown }
	| { kind: 'response'; response: JsonrpcResponse | JsonrpcErrorResponse }
	| { kind: 'invalid'; id: JsonrpcRequestId | null; error: JsonrpcErrorObject };

/**
 * Classify a parsed JSON value as a JSON-RPC message, in the Rust twin's
 * order: version, then the `method` axis (none, or a non-string one: a
 * response or invalid), then `id` (none: a notification), then the request
 * envelope (`JsonrpcRequest` — string or number `id`, `params` absent or an
 * object).
 *
 * The `method` axis is string-typed like the twin, whose
 * `obj.get("method").and_then(Value::as_str)` reads a present non-string
 * `method` as absent — so `{id, method: 123, result}` is a response on both
 * sides. The `result` / `error` exclusive-or refuses a frame carrying both.
 *
 * Every `invalid` is `invalid_request`. Its `id` is the frame's own when the
 * frame is an object carrying a string or number one, else `null` — a
 * non-object frame (an array included) has none. A refused request envelope
 * carries the schema's issues in DEV, as `data.issues`; nothing else carries
 * data.
 *
 * @param json - the parsed frame or body, of any shape
 * @returns the classification
 */
export const classify_jsonrpc_message = (json: unknown): ClassifiedJsonrpcMessage => {
	// an array falls through to the version check, with no `id` to echo
	if (typeof json !== 'object' || json === null) {
		return { kind: 'invalid', id: null, error: jsonrpc_error_messages.invalid_request() };
	}
	const frame = json as Record<string, unknown>;
	const id = to_jsonrpc_message_id(frame);
	if (frame.jsonrpc !== JSONRPC_VERSION) {
		return { kind: 'invalid', id, error: jsonrpc_error_messages.invalid_request() };
	}
	const { method } = frame;
	if (typeof method !== 'string') {
		if (id !== null && 'result' in frame !== 'error' in frame) {
			return { kind: 'response', response: frame as JsonrpcResponse | JsonrpcErrorResponse };
		}
		// a non-string `method` beside an `id` is a malformed request — the
		// envelope schema below refuses it with its issues
		if (!('method' in frame && 'id' in frame)) {
			return { kind: 'invalid', id, error: jsonrpc_error_messages.invalid_request() };
		}
	} else if (!('id' in frame)) {
		return { kind: 'notification', method, params: frame.params };
	}
	const parsed = JsonrpcRequest.safeParse(frame);
	if (!parsed.success) {
		return {
			kind: 'invalid',
			id,
			error: jsonrpc_error_messages.invalid_request(dev_only({ issues: parsed.error.issues }))
		};
	}
	return { kind: 'request', request: parsed.data };
};
