import './assert_dev_env.ts';

/**
 * Frontend test doubles for the throwing RPC client (`ThrowingApi`, what
 * `create_frontend_rpc_client` hands out as `api`): a stub holding only the
 * methods a test supplies, and the error a refused call throws.
 *
 * @module
 */

import { to_rpc_call_error } from '../actions/rpc_client.ts';
import type { JsonrpcErrorCode, JsonrpcErrorObject } from '../http/jsonrpc.ts';
import { JSONRPC_ERROR_CODES } from '../http/jsonrpc_errors.ts';

/**
 * An API object holding only `methods`; calling any other string-keyed
 * method throws naming it, so a state class reaching a method the test didn't
 * expect fails with that method's name, never "not a function" or a silent
 * `undefined`. Symbol keys, `then` and `toJSON` read `undefined`, so awaiting
 * the stub doesn't treat it as a thenable and `JSON.stringify` doesn't throw.
 *
 * @param methods - the methods the test drives, typed by the API
 * @returns the stub, typed as the whole API
 */
export const create_stub_api = <TApi extends object>(methods: Partial<TApi>): TApi =>
	new Proxy<Record<string | symbol, unknown>>(methods, {
		get: (target, key) => {
			if (key in target) return target[key];
			if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return undefined;
			return () => {
				throw new Error(`create_stub_api: unexpected call to '${key}' — stub it`);
			};
		}
	}) as TApi;

/**
 * The error a `ThrowingApi` call throws for a refusal carrying `reason` —
 * `code`, `message` and `data: {reason}` as `to_rpc_call_error` copies them
 * from the wire, so a catch block reading `err.data?.reason` or `err.code`
 * reads it here as in production.
 *
 * @param reason - the refusal's `data.reason`, also the message
 * @param code - the JSON-RPC code, default `forbidden`; pass the one the code under test reads
 * @returns the error to reject with
 */
export const rpc_error = (
	reason: string,
	code: JsonrpcErrorCode = JSONRPC_ERROR_CODES.forbidden
): Error & Pick<JsonrpcErrorObject, 'code' | 'data'> =>
	to_rpc_call_error({ code, message: reason, data: { reason } });
