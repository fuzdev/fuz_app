/**
 * JSON-RPC 2.0 envelope schemas for the single RPC endpoint dispatcher.
 *
 * Minimal subset extracted from zzz's `jsonrpc.ts` — only what the
 * `create_rpc_endpoint` dispatcher needs to parse incoming requests
 * and format outgoing responses. Full JSON-RPC schemas (batching,
 * MCP extensions, notification types) remain in zzz.
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

/** Request params — loose object to allow additional properties. */
export const JsonrpcRequestParams = z.looseObject({});
export type JsonrpcRequestParams = z.infer<typeof JsonrpcRequestParams>;

/** Result — loose object to allow additional properties. */
export const JsonrpcResult = z.looseObject({});
export type JsonrpcResult = z.infer<typeof JsonrpcResult>;

/** A request that expects a response. */
export const JsonrpcRequest = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	method: JsonrpcMethod,
	params: JsonrpcRequestParams.optional(),
});
export type JsonrpcRequest = z.infer<typeof JsonrpcRequest>;

/** A successful (non-error) response to a request. */
export const JsonrpcResponse = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	result: JsonrpcResult,
});
export type JsonrpcResponse = z.infer<typeof JsonrpcResponse>;

/** Error object within a JSON-RPC error response. */
export const JsonrpcErrorObject = z.looseObject({
	code: z.number(),
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
