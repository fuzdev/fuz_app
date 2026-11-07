/**
 * JSON-RPC 2.0 envelope schemas for RPC dispatch and SAES transport.
 *
 * Params are object-only following MCP (no positional arrays); per-action
 * spec.input narrows further. Result is any value per spec §5 ("determined
 * by the method invoked") — the per-action spec.output is the actual
 * contract, so an action whose output is `null` or a string travels in the
 * same envelope as one whose output is an object.
 *
 * The envelopes are `loose_object`s: JSON-RPC and MCP both extend them with
 * members a reader passes over, so an unknown key is kept rather than
 * refused. A parse returns the frame itself, not a copy.
 *
 * @source https://github.com/modelcontextprotocol/typescript-sdk
 * @see https://www.jsonrpc.org/specification
 * @module
 */

import {
	brand,
	integer,
	literal,
	loose_object,
	max_value,
	min_value,
	nullable,
	number,
	one_of,
	optional,
	pipe,
	string,
	union,
	unknown,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

export const JSONRPC_VERSION = '2.0';

/** A uniquely identifying id for a request in JSON-RPC. Like MCP, excludes null. */
export const JsonrpcRequestId = union([string, number]);
export type JsonrpcRequestId = Infer<typeof JsonrpcRequestId>;

/** A JSON-RPC method name. */
export const JsonrpcMethod = string;
export type JsonrpcMethod = Infer<typeof JsonrpcMethod>;

/** Request params — an object, its keys kept. Per-action schemas validate the content. */
export const JsonrpcRequestParams = loose_object({});
export type JsonrpcRequestParams = Infer<typeof JsonrpcRequestParams>;

/** Notification params — an object, its keys kept. Per-action schemas validate the content. */
export const JsonrpcNotificationParams = loose_object({});
export type JsonrpcNotificationParams = Infer<typeof JsonrpcNotificationParams>;

/**
 * Result — any value per JSON-RPC 2.0 §5. Per-action `spec.output` is the
 * actual contract; the envelope asserts only that the key is present.
 *
 * `unknown` needs its key, so an error envelope `{jsonrpc, id, error}` fails
 * the success envelope at `result` and the two stay apart in a union. It
 * also takes what isn't a JSON value: `undefined` at a present key or a
 * `Date`, which no parsed frame holds, and `±Infinity`, which `JSON.parse`
 * makes of an out-of-range number such as `1e400` and which no server
 * writes.
 */
export const JsonrpcResult = unknown;
export type JsonrpcResult = Infer<typeof JsonrpcResult>;

/** A request that expects a response. */
export const JsonrpcRequest = loose_object({
	jsonrpc: literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	method: JsonrpcMethod,
	params: optional(JsonrpcRequestParams)
});
export type JsonrpcRequest = Infer<typeof JsonrpcRequest>;

/** A notification which does not expect a response. */
export const JsonrpcNotification = loose_object({
	jsonrpc: literal(JSONRPC_VERSION),
	method: JsonrpcMethod,
	params: optional(JsonrpcNotificationParams)
});
export type JsonrpcNotification = Infer<typeof JsonrpcNotification>;

/** A successful (non-error) response to a request. */
export const JsonrpcResponse = loose_object({
	jsonrpc: literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	result: JsonrpcResult
});
export type JsonrpcResponse = Infer<typeof JsonrpcResponse>;

// --- Error code schemas ---

// Standard JSON-RPC error codes — https://www.jsonrpc.org/specification
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** Start of the server-defined error code range (-32000). */
export const JSONRPC_SERVER_ERROR_START = -32000;
/** End of the server-defined error code range (-32099). */
export const JSONRPC_SERVER_ERROR_END = -32099;

/**
 * A server-defined error code, an integer in the -32000 to -32099 range (the
 * Rust spine's codes are `i32`s).
 */
export const JsonrpcServerErrorCode = brand(
	pipe(number, integer, min_value(JSONRPC_SERVER_ERROR_END), max_value(JSONRPC_SERVER_ERROR_START)),
	'JsonrpcServerErrorCode'
);
export type JsonrpcServerErrorCode = Infer<typeof JsonrpcServerErrorCode>;

/**
 * A valid JSON-RPC error code — one of the standard codes or a
 * server-defined code in the -32000 to -32099 range.
 */
export const JsonrpcErrorCode = union([
	one_of([
		JSONRPC_PARSE_ERROR,
		JSONRPC_INVALID_REQUEST,
		JSONRPC_METHOD_NOT_FOUND,
		JSONRPC_INVALID_PARAMS,
		JSONRPC_INTERNAL_ERROR
	]),
	JsonrpcServerErrorCode
]);
export type JsonrpcErrorCode = Infer<typeof JsonrpcErrorCode>;

/**
 * Whether `value` is a valid JSON-RPC error code — the codes `JsonrpcErrorCode`
 * parses. A numeric `code` alone doesn't make an error a JSON-RPC one: a
 * `DOMException`'s `code` is a small positive number.
 *
 * @param value - the candidate code
 * @returns whether `value` is one of the standard codes or an integer in the server range
 */
export const is_jsonrpc_error_code = (value: unknown): value is JsonrpcErrorCode =>
	typeof value === 'number' &&
	(value === JSONRPC_PARSE_ERROR ||
		value === JSONRPC_INVALID_REQUEST ||
		value === JSONRPC_METHOD_NOT_FOUND ||
		value === JSONRPC_INVALID_PARAMS ||
		value === JSONRPC_INTERNAL_ERROR ||
		(Number.isInteger(value) &&
			value >= JSONRPC_SERVER_ERROR_END &&
			value <= JSONRPC_SERVER_ERROR_START));

/** Error object within a JSON-RPC error response. */
export const JsonrpcErrorObject = loose_object({
	code: JsonrpcErrorCode,
	message: string,
	data: optional(unknown)
});
export type JsonrpcErrorObject = Infer<typeof JsonrpcErrorObject>;

/** A response that indicates an error occurred. */
export const JsonrpcErrorResponse = loose_object({
	jsonrpc: literal(JSONRPC_VERSION),
	id: nullable(JsonrpcRequestId),
	error: JsonrpcErrorObject
});
export type JsonrpcErrorResponse = Infer<typeof JsonrpcErrorResponse>;

/** A successful response or an error response. */
export const JsonrpcResponseOrError = union([JsonrpcResponse, JsonrpcErrorResponse]);
export type JsonrpcResponseOrError = Infer<typeof JsonrpcResponseOrError>;

/** Any valid JSON-RPC message (request, notification, response, or error response). */
export type JsonrpcMessage =
	JsonrpcRequest | JsonrpcNotification | JsonrpcResponse | JsonrpcErrorResponse;

/** Messages a client can send to a server (request or notification). */
export type JsonrpcMessageFromClientToServer = JsonrpcRequest | JsonrpcNotification;

/** Messages a server can send to a client (notification, response, or error response). */
export type JsonrpcMessageFromServerToClient =
	JsonrpcNotification | JsonrpcResponse | JsonrpcErrorResponse;
