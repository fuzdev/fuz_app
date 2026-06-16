/**
 * JSON-RPC error infrastructure for fuz_app routes.
 *
 * Provides error types, named constructors, and HTTP status mapping
 * for the throw/catch error pattern used by `apply_route_specs`.
 * Core error codes (5 standard + 10 general application). Domain-specific
 * codes stay in consumers — add by casting `as JsonrpcErrorCode`.
 *
 * `JsonrpcErrorCode` and `JsonrpcErrorObject` types are Zod-inferred
 * from `http/jsonrpc.ts` — this module re-uses those as the single source
 * of truth.
 *
 * Complementary to `http/error_schemas.ts`: that module is declarative
 * (Zod schemas for surface introspection), this one is runtime
 * (throw + catch + map).
 *
 * @module
 */

import {DEV} from 'esm-env';
import type {ContentfulStatusCode} from 'hono/utils/http-status';

import {
	JSONRPC_PARSE_ERROR,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INTERNAL_ERROR,
	type JsonrpcErrorCode,
	type JsonrpcErrorObject,
} from './jsonrpc.ts';

/** Default message for unknown errors. */
export const UNKNOWN_ERROR_MESSAGE = 'unknown error';

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
	| 'timeout'
	| 'queue_overflow'
	| 'request_cancelled';

/**
 * Standard JSON-RPC error codes (5) plus general application codes (10).
 *
 * Extensible — consumers add domain-specific codes to their own objects
 * by casting `as JsonrpcErrorCode`. Application codes use the -32000 to
 * -32099 range reserved by the JSON-RPC spec.
 *
 * Frozen with `Object.freeze` to convert accidental mutation (test
 * cross-contamination, cast escapes) into loud TypeErrors. Spread into
 * a fresh object to extend.
 */
export const JSONRPC_ERROR_CODES = Object.freeze({
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
	/**
	 * Client-side backpressure — an outbound buffer (e.g. `FrontendWebsocketClient`'s
	 * disconnected request queue) refused a new request because it was full.
	 * Distinct from `rate_limited`, which signals a server-side policy.
	 */
	queue_overflow: -32009 as JsonrpcErrorCode,
	/**
	 * Caller-initiated cancellation (e.g. `AbortSignal` fired). Cooperative,
	 * not a failure — the request did not complete because the caller asked
	 * for it to stop.
	 */
	request_cancelled: -32010 as JsonrpcErrorCode,
}) as Readonly<Record<JsonrpcErrorName, JsonrpcErrorCode>>;

/**
 * Pass `value` through in development, return `undefined` in production — so
 * `JSON.stringify` drops the field from the response.
 *
 * The single gate for keeping internal diagnostic detail out of production
 * error responses. Two classes flow through it:
 *
 * - **Zod `issues`** — the issues array exposes field names, types, and
 *   constraints, enough to reverse-engineer an input schema (including on
 *   public/unauthenticated actions). Gate the whole `data` object on JSON-RPC
 *   errors (so `error.data` is absent, matching the Rust spine) and the
 *   `issues` field on flat REST error bodies.
 * - **Raw exception messages** — an unhandled handler error's `message` can
 *   carry paths, SQL, or secrets. Gate it so production returns the generic
 *   `internal_error` and development keeps the real message for DX.
 *
 * A legitimate caller only ever needs the error code and a stable message.
 *
 * @nodocs
 */
export const dev_only = <T>(value: T): T | undefined => (DEV ? value : undefined);

/**
 * Named constructors for `JsonrpcErrorObject` values.
 *
 * Each function creates a JSON-RPC error object with the correct
 * code and a sensible default message. Used by the catch layer in
 * `apply_route_specs` to build response bodies.
 *
 * Frozen so tests must compose new objects rather than monkey-patch.
 */
export const jsonrpc_error_messages = Object.freeze({
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

	queue_overflow: (message: string = 'queue overflow', data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.queue_overflow,
		message,
		data,
	}),

	request_cancelled: (
		message: string = 'request cancelled',
		data?: unknown,
	): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.request_cancelled,
		message,
		data,
	}),
}) as Readonly<Record<JsonrpcErrorName, (...args: Array<any>) => JsonrpcErrorObject>>;

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
	queue_overflow: create_error_thrower(jsonrpc_error_messages.queue_overflow),
	request_cancelled: create_error_thrower(jsonrpc_error_messages.request_cancelled),
} as const satisfies Record<JsonrpcErrorName, (...args: Array<any>) => ThrownJsonrpcError>;

// --- HTTP status mapping ---

/**
 * Maps JSON-RPC error codes to HTTP status codes.
 *
 * Extensible — consumers with domain-specific error codes assign directly
 * (`JSONRPC_ERROR_CODE_TO_HTTP_STATUS[-32020] = 502`) at module load. The
 * lookup function reads at call time, so mutation is the supported
 * extension mechanism.
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
	// queue_overflow shares 429 with rate_limited — listed first so reverse
	// map wins with rate_limited (server-side) rather than client-side overflow.
	[-32009]: 429, // queue_overflow (client-side backpressure)
	[-32006]: 429, // rate_limited
	[-32007]: 503, // service_unavailable
	[-32008]: 504, // timeout
	[-32010]: 499, // request_cancelled (nginx "client closed request")
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
 * without a mapping default to internal server error). The return
 * is narrowed to Hono's `ContentfulStatusCode` so call sites can
 * pass the result to `c.json(body, status)` without `as any` —
 * 499 (nginx "client closed request") is non-standard and gets
 * absorbed by the cast here rather than at every dispatcher branch.
 */
export const jsonrpc_error_code_to_http_status = (code: JsonrpcErrorCode): ContentfulStatusCode =>
	(JSONRPC_ERROR_CODE_TO_HTTP_STATUS[code as number] ?? 500) as ContentfulStatusCode;

/**
 * Map an HTTP status code to a JSON-RPC error code.
 *
 * Returns `internal_error` (-32603) for unrecognized status codes.
 */
export const http_status_to_jsonrpc_error_code = (status: number): JsonrpcErrorCode =>
	HTTP_STATUS_TO_JSONRPC_ERROR_CODE[status] ?? JSONRPC_ERROR_CODES.internal_error;

/**
 * Reverse map of `JSONRPC_ERROR_CODES` — JSON-RPC error code → name.
 *
 * Used by REST emitters that need a stable string identifier for the
 * code in their flat-shape error body (`{error: '<name>', ...}`)
 * without inventing a separate vocabulary. Built once at module load
 * from the canonical `JSONRPC_ERROR_CODES` map so the two cannot drift.
 *
 * Consumer-defined codes outside the standard taxonomy are not present;
 * `jsonrpc_error_code_to_name` falls back to `'internal_error'` so the
 * REST shape always carries some reason rather than `undefined`.
 */
export const JSONRPC_ERROR_CODE_TO_NAME: Readonly<Record<number, JsonrpcErrorName>> = Object.freeze(
	Object.fromEntries(
		(Object.entries(JSONRPC_ERROR_CODES) as Array<[JsonrpcErrorName, JsonrpcErrorCode]>).map(
			([name, code]) => [code as number, name],
		),
	),
);

/**
 * Map a JSON-RPC error code to its canonical name (`'not_found'`,
 * `'forbidden'`, etc.). Falls back to `'internal_error'` for codes
 * outside the standard taxonomy so REST emitters that read this for
 * their `error` field always have a stable string to emit.
 */
export const jsonrpc_error_code_to_name = (code: JsonrpcErrorCode): JsonrpcErrorName =>
	JSONRPC_ERROR_CODE_TO_NAME[code as number] ?? 'internal_error';
