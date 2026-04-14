/**
 * JSON-RPC 2.0 envelope schemas for RPC dispatch and SAES transport.
 *
 * MCP-superset: includes optional `_meta` and `progressToken` fields
 * on params and results. These are `optional()` so consumers that
 * don't use MCP are unaffected.
 *
 * Following MCP, params and result are object-only (no positional arrays).
 *
 * @source https://github.com/modelcontextprotocol/typescript-sdk
 * @see https://www.jsonrpc.org/specification
 * @module
 */

import {z} from 'zod';

export const JSONRPC_VERSION = '2.0';

/** A uniquely identifying id for a request in JSON-RPC. Like MCP, excludes null. */
export const JsonrpcRequestId = z.union([z.string(), z.number()]);
export type JsonrpcRequestId = z.infer<typeof JsonrpcRequestId>;

/** A JSON-RPC method name. */
export const JsonrpcMethod = z.string();
export type JsonrpcMethod = z.infer<typeof JsonrpcMethod>;

/** A progress token, used to associate progress notifications with the original request. */
export const JsonrpcProgressToken = z.union([z.string(), z.number()]);
export type JsonrpcProgressToken = z.infer<typeof JsonrpcProgressToken>;

/** MCP metadata object — loose to allow additional properties and `.extend`. */
export const JsonrpcMcpMeta = z.looseObject({});
export type JsonrpcMcpMeta = z.infer<typeof JsonrpcMcpMeta>;

/** Request params metadata — extends MCP meta with optional progress token. */
export const JsonrpcRequestParamsMeta = JsonrpcMcpMeta.extend({
	/**
	 * If specified, the caller is requesting out-of-band progress notifications
	 * for this request. The value is an opaque token attached to subsequent
	 * notifications. The receiver is not obligated to provide these notifications.
	 */
	progressToken: JsonrpcProgressToken.optional(),
});
export type JsonrpcRequestParamsMeta = z.infer<typeof JsonrpcRequestParamsMeta>;

/** Request params — loose object with optional MCP metadata. */
export const JsonrpcRequestParams = z.looseObject({
	_meta: JsonrpcRequestParamsMeta.optional(),
});
export type JsonrpcRequestParams = z.infer<typeof JsonrpcRequestParams>;

/** Notification params — loose object with optional MCP metadata. */
export const JsonrpcNotificationParams = z.looseObject({
	/**
	 * Reserved by MCP to allow clients and servers to attach
	 * additional metadata to their notifications.
	 */
	_meta: JsonrpcMcpMeta.optional(),
});
export type JsonrpcNotificationParams = z.infer<typeof JsonrpcNotificationParams>;

/** Result — loose object with optional MCP metadata. */
export const JsonrpcResult = z.looseObject({
	/**
	 * Reserved by the protocol to allow clients and servers
	 * to attach additional metadata to their responses.
	 */
	_meta: JsonrpcMcpMeta.optional(),
});
export type JsonrpcResult = z.infer<typeof JsonrpcResult>;

/** A request that expects a response. */
export const JsonrpcRequest = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	method: JsonrpcMethod,
	params: JsonrpcRequestParams.optional(),
});
export type JsonrpcRequest = z.infer<typeof JsonrpcRequest>;

/** A notification which does not expect a response. */
export const JsonrpcNotification = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	method: JsonrpcMethod,
	params: JsonrpcNotificationParams.optional(),
});
export type JsonrpcNotification = z.infer<typeof JsonrpcNotification>;

/** A successful (non-error) response to a request. */
export const JsonrpcResponse = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	result: JsonrpcResult,
});
export type JsonrpcResponse = z.infer<typeof JsonrpcResponse>;

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

/** A server-defined error code in the -32000 to -32099 range. */
export const JsonrpcServerErrorCode = z
	.number()
	.gte(JSONRPC_SERVER_ERROR_END)
	.lte(JSONRPC_SERVER_ERROR_START)
	.brand('JsonrpcServerErrorCode');
export type JsonrpcServerErrorCode = z.infer<typeof JsonrpcServerErrorCode>;

/**
 * A valid JSON-RPC error code — one of the 5 standard codes or
 * a server-defined code in the -32000 to -32099 range.
 */
export const JsonrpcErrorCode = z.union([
	z.literal(JSONRPC_PARSE_ERROR),
	z.literal(JSONRPC_INVALID_REQUEST),
	z.literal(JSONRPC_METHOD_NOT_FOUND),
	z.literal(JSONRPC_INVALID_PARAMS),
	z.literal(JSONRPC_INTERNAL_ERROR),
	JsonrpcServerErrorCode,
]);
export type JsonrpcErrorCode = z.infer<typeof JsonrpcErrorCode>;

/** Error object within a JSON-RPC error response. */
export const JsonrpcErrorObject = z.looseObject({
	code: JsonrpcErrorCode,
	message: z.string(),
	data: z.unknown().optional(),
});
export type JsonrpcErrorObject = z.infer<typeof JsonrpcErrorObject>;

/** A response that indicates an error occurred. */
export const JsonrpcErrorResponse = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId.nullable(),
	error: JsonrpcErrorObject,
});
export type JsonrpcErrorResponse = z.infer<typeof JsonrpcErrorResponse>;

/** A successful response or an error response. */
export const JsonrpcResponseOrError = z.union([JsonrpcResponse, JsonrpcErrorResponse]);
export type JsonrpcResponseOrError = z.infer<typeof JsonrpcResponseOrError>;

/** Any valid JSON-RPC message (request, notification, response, or error response). */
export const JsonrpcMessage = z.union([
	JsonrpcRequest,
	JsonrpcNotification,
	JsonrpcResponse,
	JsonrpcErrorResponse,
]);
export type JsonrpcMessage = z.infer<typeof JsonrpcMessage>;

/** Messages a client can send to a server (request or notification). */
export const JsonrpcMessageFromClientToServer = z.union([JsonrpcRequest, JsonrpcNotification]);
export type JsonrpcMessageFromClientToServer = z.infer<typeof JsonrpcMessageFromClientToServer>;

/** Messages a server can send to a client (notification, response, or error response). */
export const JsonrpcMessageFromServerToClient = z.union([
	JsonrpcNotification,
	JsonrpcResponse,
	JsonrpcErrorResponse,
]);
export type JsonrpcMessageFromServerToClient = z.infer<typeof JsonrpcMessageFromServerToClient>;
