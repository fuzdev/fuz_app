/**
 * JSON-RPC error infrastructure for fuz_app routes.
 *
 * Provides error types, named constructors, and HTTP status mapping
 * for the throw/catch error pattern used by `apply_route_specs`.
 * Extracted from zzz's `jsonrpc_errors.ts` — only core error codes
 * (5 standard + 8 general application). Domain-specific codes stay
 * in consumers. `JSONRPC_ERROR_CODES` is extensible — consumers
 * add their own codes by casting `as JsonrpcErrorCode`.
 *
 * Complementary to `error_schemas.ts`: that module is declarative
 * (Zod schemas for surface introspection), this one is runtime
 * (throw + catch + map).
 *
 * @module
 */

/** Branded number type for JSON-RPC error codes. */
export type JsonrpcErrorCode = number & {readonly __brand: 'JsonrpcErrorCode'};

/** JSON-RPC error response object — code, message, and optional data. */
export interface JsonrpcErrorJson {
	code: JsonrpcErrorCode;
	message: string;
	data?: unknown;
}

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
	// Standard JSON-RPC errors — https://www.jsonrpc.org/specification
	/** -32700 */
	parse_error: -32700 as JsonrpcErrorCode,
	/** -32600 */
	invalid_request: -32600 as JsonrpcErrorCode,
	/** -32601 */
	method_not_found: -32601 as JsonrpcErrorCode,
	/** -32602 */
	invalid_params: -32602 as JsonrpcErrorCode,
	/** -32603 */
	internal_error: -32603 as JsonrpcErrorCode,

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
 * Named constructors for `JsonrpcErrorJson` objects.
 *
 * Each function creates a JSON-RPC error response object with the correct
 * code and a sensible default message. Used by the catch layer in
 * `apply_route_specs` to build response bodies.
 */
export const jsonrpc_error_messages = {
	parse_error: (data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.parse_error,
		message: 'parse error',
		data,
	}),

	invalid_request: (data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.invalid_request,
		message: 'invalid request',
		data,
	}),

	method_not_found: (method?: string, data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.method_not_found,
		message: method ? `method not found: ${method}` : 'method not found',
		data,
	}),

	invalid_params: (message?: string, data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.invalid_params,
		message: message ?? 'invalid params',
		data,
	}),

	internal_error: (
		message: string = 'internal server error',
		data?: unknown,
	): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.internal_error,
		message,
		data,
	}),

	unauthenticated: (message: string = 'unauthenticated', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.unauthenticated,
		message,
		data,
	}),

	forbidden: (message: string = 'forbidden', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.forbidden,
		message,
		data,
	}),

	not_found: (resource?: string, data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.not_found,
		message: resource ? `${resource} not found` : 'not found',
		data,
	}),

	conflict: (message: string = 'conflict', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.conflict,
		message,
		data,
	}),

	validation_error: (message: string = 'validation error', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.validation_error,
		message,
		data,
	}),

	rate_limited: (message: string = 'rate limited', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.rate_limited,
		message,
		data,
	}),

	service_unavailable: (
		message: string = 'service unavailable',
		data?: unknown,
	): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.service_unavailable,
		message,
		data,
	}),

	timeout: (message: string = 'timeout', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.timeout,
		message,
		data,
	}),
} as const satisfies Record<JsonrpcErrorName, (...args: Array<any>) => JsonrpcErrorJson>;

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
	<TFn extends (...args: Array<any>) => JsonrpcErrorJson>(
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

const JSONRPC_ERROR_CODE_HTTP_STATUS = new Map<number, number>([
	[-32700, 400], // parse_error
	[-32600, 400], // invalid_request
	[-32601, 404], // method_not_found
	[-32602, 400], // invalid_params
	[-32603, 500], // internal_error
	[-32001, 401], // unauthenticated
	[-32002, 403], // forbidden
	[-32003, 404], // not_found
	[-32004, 409], // conflict
	[-32005, 422], // validation_error
	[-32006, 429], // rate_limited
	[-32007, 503], // service_unavailable
	[-32008, 504], // timeout
]);

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
	JSONRPC_ERROR_CODE_HTTP_STATUS.get(code as number) ?? 500;
