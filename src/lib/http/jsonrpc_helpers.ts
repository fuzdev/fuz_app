/**
 * JSON-RPC message builders, type guards, and converters.
 *
 * Used by the SAES runtime (ActionEvent, ActionPeer, transports) and
 * the RPC endpoint dispatcher. Complements `jsonrpc.ts` (schemas) and
 * `jsonrpc_errors.ts` (error infrastructure).
 *
 * @module
 */

import {DEV} from 'esm-env';

import {
	type JsonrpcErrorResponse,
	type JsonrpcMethod,
	type JsonrpcNotification,
	type JsonrpcNotificationParams,
	type JsonrpcRequest,
	type JsonrpcRequestId,
	type JsonrpcRequestParams,
	type JsonrpcResponse,
	type JsonrpcResult,
	type JsonrpcMessage,
	type JsonrpcErrorCode,
	JSONRPC_VERSION,
} from './jsonrpc.js';
import {ThrownJsonrpcError, JSONRPC_ERROR_CODES} from './jsonrpc_errors.js';

// --- Message builders ---

/** Creates a JSON-RPC request message. */
export const create_jsonrpc_request = (
	method: JsonrpcMethod,
	params: JsonrpcRequestParams | undefined,
	id: JsonrpcRequestId,
): JsonrpcRequest => {
	const message: JsonrpcRequest = {
		jsonrpc: JSONRPC_VERSION,
		id,
		method,
	};
	if (params !== undefined) {
		message.params = params;
	}
	return message;
};

/** Creates a JSON-RPC success response message. */
export const create_jsonrpc_response = (
	id: JsonrpcRequestId,
	result: JsonrpcResult,
): JsonrpcResponse => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	result,
});

/** Creates a JSON-RPC notification message (no id, no response expected). */
export const create_jsonrpc_notification = (
	method: JsonrpcMethod,
	params: JsonrpcNotificationParams | undefined,
): JsonrpcNotification => {
	const message: JsonrpcNotification = {
		jsonrpc: JSONRPC_VERSION,
		method,
	};
	if (params !== undefined) {
		message.params = params;
	}
	return message;
};

/** Creates a JSON-RPC error response message. */
export const create_jsonrpc_error_response = (
	id: JsonrpcErrorResponse['id'],
	error: JsonrpcErrorResponse['error'],
): JsonrpcErrorResponse => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	error,
});

/**
 * Creates a JSON-RPC error response from any error.
 * Handles `ThrownJsonrpcError` (preserves code/message/data) and
 * regular `Error` objects (maps to internal_error, includes stack in DEV).
 */
export const create_jsonrpc_error_response_from_thrown = (
	id: JsonrpcRequestId | null,
	error: unknown,
): JsonrpcErrorResponse => {
	let code: JsonrpcErrorCode = JSONRPC_ERROR_CODES.internal_error;
	let message = 'internal server error';
	let data: unknown = undefined;

	if (error instanceof ThrownJsonrpcError) {
		code = error.code;
		message = error.message;
		data = error.data;
	} else if (error instanceof Error) {
		if (DEV) {
			message = error.message;
			data = {stack: error.stack};
		}
	}

	return {
		jsonrpc: JSONRPC_VERSION,
		id,
		error: {
			code,
			message,
			data,
		},
	};
};

// --- Type guards ---

/** Checks if a value is a valid JSON-RPC request id (string or finite number). */
export const is_jsonrpc_request_id = (id: unknown): id is JsonrpcRequestId => {
	const type = typeof id;
	return type === 'string' || (type === 'number' && !Number.isNaN(id) && Number.isFinite(id));
};

/** Checks if a value is a JSON-RPC object (has `jsonrpc: '2.0'`). */
export const is_jsonrpc_object = (message: unknown): message is {jsonrpc: typeof JSONRPC_VERSION} =>
	typeof message === 'object' &&
	message !== null &&
	!Array.isArray(message) &&
	(message as any).jsonrpc === JSONRPC_VERSION;

/** Checks if a value is any valid JSON-RPC message or batch array. */
export const is_jsonrpc_message = (
	message: unknown,
): message is JsonrpcMessage | Array<JsonrpcMessage> =>
	Array.isArray(message)
		? message.length > 0 && message.every((m) => is_jsonrpc_object(m))
		: is_jsonrpc_object(message);

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
		typeof message_or_id === 'object' ? (message_or_id as {id?: unknown}).id : message_or_id;

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
	return {value: input};
};

/**
 * Normalizes output to JSON-RPC result format.
 * Returns empty object for null/undefined, wraps primitives in `{value}`.
 */
export const to_jsonrpc_result = (output: unknown): Record<string, any> => {
	if (output === null || output === undefined) {
		return {};
	}
	if (typeof output === 'object' && !Array.isArray(output)) {
		return output as Record<string, any>;
	}
	return {value: output};
};
