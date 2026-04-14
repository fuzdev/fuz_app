/**
 * JSON-RPC error infrastructure for fuz_app routes.
 *
 * Provides error types, named constructors, and HTTP status mapping
 * for the throw/catch error pattern used by `apply_route_specs`.
 * Core error codes (5 standard + 8 general application). Domain-specific
 * codes stay in consumers — add by casting `as JsonrpcErrorCode`.
 *
 * `JsonrpcErrorCode` and `JsonrpcErrorObject` types are Zod-inferred
 * from `jsonrpc.ts` — this module re-uses those as the single source
 * of truth.
 *
 * Complementary to `error_schemas.ts`: that module is declarative
 * (Zod schemas for surface introspection), this one is runtime
 * (throw + catch + map).
 *
 * @module
 */

import {
	JSONRPC_PARSE_ERROR,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INTERNAL_ERROR,
	type JsonrpcErrorCode,
	type JsonrpcErrorObject,
} from './jsonrpc.js';

/** Names of standard and general application JSON-RPC error codes. */
export type JsonrpcErrorName =
	| 'parse_error'
	| 'invalid_request'
	| 'method_not_found'
	| 'invalid_params'
	| 'internal_error'
	| 'unauthenticated'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'validation_error'
	| 'rate_limited'
	| 'service_unavailable'
	| 'timeout';

/**
 * Standard JSON-RPC error codes (5) plus general application codes (8).
 *
 * Extensible — consumers add domain-specific codes to their own objects
 * by casting `as JsonrpcErrorCode`. Application codes use the -32000 to
 * -32099 range reserved by the JSON-RPC spec.
 */
export const JSONRPC_ERROR_CODES = {
	// Standard JSON-RPC errors — values from jsonrpc.ts
	parse_error: JSONRPC_PARSE_ERROR as JsonrpcErrorCode,
	invalid_request: JSONRPC_INVALID_REQUEST as JsonrpcErrorCode,
	method_not_found: JSONRPC_METHOD_NOT_FOUND as JsonrpcErrorCode,
	invalid_params: JSONRPC_INVALID_PARAMS as JsonrpcErrorCode,
	internal_error: JSONRPC_INTERNAL_ERROR as JsonrpcErrorCode,

	// General application errors (-32000 to -32099)
	/**
	 * Same as HTTP 401 "unauthorized", but correctly named.
	 *
	 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status#client_error_responses
	 */
	unauthenticated: -32001 as JsonrpcErrorCode,
	/**
	 * Named to match HTTP 403 — avoids confusion with 401 which
	 * is incorrectly named "unauthorized" in HTTP.
	 */
	forbidden: -32002 as JsonrpcErrorCode,
	not_found: -32003 as JsonrpcErrorCode,
	conflict: -32004 as JsonrpcErrorCode,
	/**
	 * Application-level validation failures (business logic).
	 * Use `invalid_params` (-32602) for schema/parsing failures.
	 */
	validation_error: -32005 as JsonrpcErrorCode,
	rate_limited: -32006 as JsonrpcErrorCode,
	service_unavailable: -32007 as JsonrpcErrorCode,
	timeout: -32008 as JsonrpcErrorCode,
} as const satisfies Record<JsonrpcErrorName, JsonrpcErrorCode>;

/**
 * Named constructors for `JsonrpcErrorObject` values.
 *
 * Each function creates a JSON-RPC error object with the correct
 * code and a sensible default message. Used by the catch layer in
 * `apply_route_specs` to build response bodies.
 */
export const jsonrpc_error_messages = {
	parse_error: (data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.parse_error,
		message: 'parse error',
		data,
	}),

	invalid_request: (data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.invalid_request,
		message: 'invalid request',
		data,
	}),

	method_not_found: (method?: string, data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.method_not_found,
		message: method ? `method not found: ${method}` : 'method not found',
		data,
	}),

	invalid_params: (message?: string, data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.invalid_params,
		message: message ?? 'invalid params',
		data,
	}),

	internal_error: (
		message: string = 'internal server error',
		data?: unknown,
	): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.internal_error,
		message,
		data,
	}),

	unauthenticated: (message: string = 'unauthenticated', data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.unauthenticated,
		message,
		data,
	}),

	forbidden: (message: string = 'forbidden', data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.forbidden,
		message,
		data,
	}),

	not_found: (resource?: string, data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.not_found,
		message: resource ? `${resource} not found` : 'not found',
		data,
	}),

	conflict: (message: string = 'conflict', data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.conflict,
		message,
		data,
	}),

	validation_error: (message: string = 'validation error', data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.validation_error,
		message,
		data,
	}),

	rate_limited: (message: string = 'rate limited', data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.rate_limited,
		message,
		data,
	}),

	service_unavailable: (
		message: string = 'service unavailable',
		data?: unknown,
	): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.service_unavailable,
		message,
		data,
	}),

	timeout: (message: string = 'timeout', data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.timeout,
		message,
		data,
	}),
} as const satisfies Record<JsonrpcErrorName, (...args: Array<any>) => JsonrpcErrorObject>;

/**
 * Error class carrying a JSON-RPC error code — thrown by handlers,
 * caught by `apply_route_specs` and mapped to HTTP status + JSON-RPC error response.
 *
 * Named for what it is: an error with a JSON-RPC error code that gets thrown.
 */
export class ThrownJsonrpcError extends Error {
	code: JsonrpcErrorCode;
	data?: unknown;

	constructor(code: JsonrpcErrorCode, message: string, data?: unknown, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.data = data;
	}
}

const create_error_thrower =
	<TFn extends (...args: Array<any>) => JsonrpcErrorObject>(
		error_fn: TFn,
	): ((...args: Parameters<TFn>) => ThrownJsonrpcError) =>
	(...args: Parameters<TFn>) => {
		const m = error_fn(...args);
		return new ThrownJsonrpcError(m.code, m.message, m.data);
	};

/**
 * Named constructors for `ThrownJsonrpcError`.
 *
 * Usage: `throw jsonrpc_errors.not_found('user')` or `throw jsonrpc_errors.forbidden()`.
 */
export const jsonrpc_errors = {
	parse_error: create_error_thrower(jsonrpc_error_messages.parse_error),
	invalid_request: create_error_thrower(jsonrpc_error_messages.invalid_request),
	method_not_found: create_error_thrower(jsonrpc_error_messages.method_not_found),
	invalid_params: create_error_thrower(jsonrpc_error_messages.invalid_params),
	internal_error: create_error_thrower(jsonrpc_error_messages.internal_error),
	unauthenticated: create_error_thrower(jsonrpc_error_messages.unauthenticated),
	forbidden: create_error_thrower(jsonrpc_error_messages.forbidden),
	not_found: create_error_thrower(jsonrpc_error_messages.not_found),
	conflict: create_error_thrower(jsonrpc_error_messages.conflict),
	validation_error: create_error_thrower(jsonrpc_error_messages.validation_error),
	rate_limited: create_error_thrower(jsonrpc_error_messages.rate_limited),
	service_unavailable: create_error_thrower(jsonrpc_error_messages.service_unavailable),
	timeout: create_error_thrower(jsonrpc_error_messages.timeout),
} as const satisfies Record<JsonrpcErrorName, (...args: Array<any>) => ThrownJsonrpcError>;

// --- HTTP status mapping ---

/**
 * Maps JSON-RPC error codes to HTTP status codes.
 *
 * Extensible — consumers with domain-specific error codes can spread
 * this into their own mapping object.
 */
export const JSONRPC_ERROR_CODE_TO_HTTP_STATUS: Record<number, number> = {
	[-32700]: 400, // parse_error
	[-32600]: 400, // invalid_request
	[-32601]: 404, // method_not_found
	[-32602]: 400, // invalid_params
	[-32603]: 500, // internal_error
	[-32001]: 401, // unauthenticated
	[-32002]: 403, // forbidden
	[-32003]: 404, // not_found
	[-32004]: 409, // conflict
	[-32005]: 422, // validation_error
	[-32006]: 429, // rate_limited
	[-32007]: 503, // service_unavailable
	[-32008]: 504, // timeout
};

/**
 * Maps HTTP status codes to JSON-RPC error codes (reverse mapping).
 *
 * When multiple error codes map to the same HTTP status (e.g. parse_error
 * and invalid_request both map to 400), the last one wins. Use for
 * best-effort HTTP → JSON-RPC translation.
 */
export const HTTP_STATUS_TO_JSONRPC_ERROR_CODE: Record<number, JsonrpcErrorCode> =
	Object.fromEntries(
		Object.entries(JSONRPC_ERROR_CODE_TO_HTTP_STATUS).map(([code, status]) => [
			status,
			Number(code) as JsonrpcErrorCode,
		]),
	) as Record<number, JsonrpcErrorCode>;

/**
 * Map a JSON-RPC error code to an HTTP status code.
 *
 * Returns 500 for unrecognized codes (consumer-defined codes
 * without a mapping default to internal server error).
 *
 * @param code - the JSON-RPC error code
 * @returns the corresponding HTTP status code
 */
export const jsonrpc_error_code_to_http_status = (code: JsonrpcErrorCode): number =>
	JSONRPC_ERROR_CODE_TO_HTTP_STATUS[code as number] ?? 500;

/**
 * Map an HTTP status code to a JSON-RPC error code.
 *
 * Returns `internal_error` (-32603) for unrecognized status codes.
 *
 * @param status - the HTTP status code
 * @returns the corresponding JSON-RPC error code
 */
export const http_status_to_jsonrpc_error_code = (status: number): JsonrpcErrorCode =>
	HTTP_STATUS_TO_JSONRPC_ERROR_CODE[status] ?? JSONRPC_ERROR_CODES.internal_error;
