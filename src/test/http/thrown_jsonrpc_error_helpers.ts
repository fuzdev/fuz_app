/**
 * Thrown-error doubles for `to_thrown_jsonrpc_error` and the sites that read
 * through it: a `ThrownJsonrpcError` from a second copy of fuz_app, and a
 * foreign library's RPC error that carries a JSON-RPC code but is no
 * `ThrownJsonrpcError`.
 *
 * @module
 */

/**
 * A `ThrownJsonrpcError` from a second copy of fuz_app: another class, so
 * `instanceof` misses it, carrying the same realm-global brand that copy's
 * module mints with `Symbol.for`.
 */
export class SecondCopyThrownJsonrpcError extends Error {
	code: number;
	data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

Object.defineProperty(
	SecondCopyThrownJsonrpcError.prototype,
	Symbol.for('@fuzdev/fuz_app/ThrownJsonrpcError'),
	{ value: true }
);

/**
 * Another library's RPC error (MCP's `McpError`, viem's `RpcError`): an
 * `Error` with a JSON-RPC `code` and `data`, but no fuz_app brand, so its
 * message and data are no part of fuz_app's wire contract and must be masked.
 */
export class ForeignRpcError extends Error {
	code: number;
	data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}
