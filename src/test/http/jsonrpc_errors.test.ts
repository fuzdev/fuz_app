/**
 * Tests for jsonrpc_errors.ts — JSON-RPC error infrastructure.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	is_jsonrpc_error_code,
	JsonrpcErrorCode,
	type JsonrpcErrorObject
} from '#lib/http/jsonrpc.ts';
import {
	JSONRPC_ERROR_CODES,
	ThrownJsonrpcError,
	jsonrpc_errors,
	jsonrpc_error_messages,
	jsonrpc_error_code_to_http_status,
	jsonrpc_error_code_to_name,
	register_jsonrpc_error_code,
	to_thrown_jsonrpc_error,
	HTTP_STATUS_TO_JSONRPC_ERROR_CODE,
	http_status_to_jsonrpc_error_code,
	type JsonrpcErrorName
} from '#lib/http/jsonrpc_errors.ts';
import { ForeignRpcError, SecondCopyThrownJsonrpcError } from './thrown_jsonrpc_error_helpers.ts';

describe('JSONRPC_ERROR_CODES', () => {
	test('standard codes have correct values', () => {
		assert.strictEqual(JSONRPC_ERROR_CODES.parse_error, -32700);
		assert.strictEqual(JSONRPC_ERROR_CODES.invalid_request, -32600);
		assert.strictEqual(JSONRPC_ERROR_CODES.method_not_found, -32601);
		assert.strictEqual(JSONRPC_ERROR_CODES.invalid_params, -32602);
		assert.strictEqual(JSONRPC_ERROR_CODES.internal_error, -32603);
	});

	test('application codes have correct values', () => {
		assert.strictEqual(JSONRPC_ERROR_CODES.unauthenticated, -32001);
		assert.strictEqual(JSONRPC_ERROR_CODES.forbidden, -32002);
		assert.strictEqual(JSONRPC_ERROR_CODES.not_found, -32003);
		assert.strictEqual(JSONRPC_ERROR_CODES.conflict, -32004);
		assert.strictEqual(JSONRPC_ERROR_CODES.validation_error, -32005);
		assert.strictEqual(JSONRPC_ERROR_CODES.rate_limited, -32006);
		assert.strictEqual(JSONRPC_ERROR_CODES.service_unavailable, -32007);
		assert.strictEqual(JSONRPC_ERROR_CODES.timeout, -32008);
		assert.strictEqual(JSONRPC_ERROR_CODES.queue_overflow, -32009);
		assert.strictEqual(JSONRPC_ERROR_CODES.request_cancelled, -32010);
	});

	test('has 15 error codes total (5 standard + 10 application)', () => {
		assert.strictEqual(Object.keys(JSONRPC_ERROR_CODES).length, 15);
	});
});

describe('ThrownJsonrpcError', () => {
	test('carries code, message, and data', () => {
		const err = new ThrownJsonrpcError(JSONRPC_ERROR_CODES.not_found, 'user not found', {
			id: 42
		});
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(err.message, 'user not found');
		assert.deepStrictEqual(err.data, { id: 42 });
	});

	test('extends Error', () => {
		const err = new ThrownJsonrpcError(JSONRPC_ERROR_CODES.internal_error, 'boom');
		assert.ok(err instanceof Error);
		assert.ok(err instanceof ThrownJsonrpcError);
	});

	test('data is optional', () => {
		const err = new ThrownJsonrpcError(JSONRPC_ERROR_CODES.forbidden, 'forbidden');
		assert.strictEqual(err.data, undefined);
	});

	test('supports ErrorOptions cause', () => {
		const cause = new Error('root cause');
		const err = new ThrownJsonrpcError(JSONRPC_ERROR_CODES.internal_error, 'wrapped', undefined, {
			cause
		});
		assert.strictEqual(err.cause, cause);
	});
});

describe('jsonrpc_errors named constructors', () => {
	test('not_found with resource', () => {
		const err = jsonrpc_errors.not_found('user');
		assert.ok(err instanceof ThrownJsonrpcError);
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(err.message, 'user not found');
	});

	test('not_found without resource', () => {
		const err = jsonrpc_errors.not_found();
		assert.strictEqual(err.message, 'not found');
	});

	test('internal_error default message', () => {
		const err = jsonrpc_errors.internal_error();
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(err.message, 'internal server error');
	});

	test('internal_error custom message', () => {
		const err = jsonrpc_errors.internal_error('db connection failed');
		assert.strictEqual(err.message, 'db connection failed');
	});

	test('unauthenticated default message', () => {
		const err = jsonrpc_errors.unauthenticated();
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.unauthenticated);
		assert.strictEqual(err.message, 'unauthenticated');
	});

	test('forbidden default message', () => {
		const err = jsonrpc_errors.forbidden();
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.forbidden);
		assert.strictEqual(err.message, 'forbidden');
	});

	test('invalid_params with message', () => {
		const err = jsonrpc_errors.invalid_params('missing field: name');
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.strictEqual(err.message, 'missing field: name');
	});

	test('method_not_found with method name', () => {
		const err = jsonrpc_errors.method_not_found('do_thing');
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.method_not_found);
		assert.strictEqual(err.message, 'method not found: do_thing');
	});

	test('conflict with data', () => {
		const err = jsonrpc_errors.conflict('duplicate', { field: 'username' });
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.conflict);
		assert.strictEqual(err.message, 'duplicate');
		assert.deepStrictEqual(err.data, { field: 'username' });
	});

	test('rate_limited default message', () => {
		const err = jsonrpc_errors.rate_limited();
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.rate_limited);
		assert.strictEqual(err.message, 'rate limited');
	});

	test('service_unavailable default message', () => {
		const err = jsonrpc_errors.service_unavailable();
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.service_unavailable);
		assert.strictEqual(err.message, 'service unavailable');
	});

	test('timeout default message', () => {
		const err = jsonrpc_errors.timeout();
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.timeout);
		assert.strictEqual(err.message, 'timeout');
	});

	test('validation_error default message', () => {
		const err = jsonrpc_errors.validation_error();
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.validation_error);
		assert.strictEqual(err.message, 'validation error');
	});

	test('parse_error with data', () => {
		const err = jsonrpc_errors.parse_error({ offset: 42 });
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.parse_error);
		assert.strictEqual(err.message, 'parse error');
		assert.deepStrictEqual(err.data, { offset: 42 });
	});

	test('invalid_request with data', () => {
		const err = jsonrpc_errors.invalid_request({ reason: 'missing jsonrpc field' });
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.invalid_request);
		assert.strictEqual(err.message, 'invalid request');
		assert.deepStrictEqual(err.data, { reason: 'missing jsonrpc field' });
	});
});

describe('jsonrpc_error_messages', () => {
	test('produces correct JsonrpcErrorObject shape', () => {
		const msg = jsonrpc_error_messages.not_found('session');
		assert.strictEqual(msg.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(msg.message, 'session not found');
		assert.strictEqual(msg.data, undefined);
	});

	test('includes data when provided', () => {
		const msg = jsonrpc_error_messages.internal_error('db error', { table: 'users' });
		assert.strictEqual(msg.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(msg.message, 'db error');
		assert.deepStrictEqual(msg.data, { table: 'users' });
	});

	test('all constructors return code and message', () => {
		const names = Object.keys(jsonrpc_error_messages) as Array<keyof typeof jsonrpc_error_messages>;
		for (const name of names) {
			const fn = jsonrpc_error_messages[name] as (...args: Array<any>) => JsonrpcErrorObject;
			const result = fn();
			assert.ok(typeof result.code === 'number', `${name} should have numeric code`);
			assert.ok(typeof result.message === 'string', `${name} should have string message`);
			assert.strictEqual(
				result.code,
				JSONRPC_ERROR_CODES[name],
				`${name} code should match JSONRPC_ERROR_CODES`
			);
		}
	});
});

describe('jsonrpc_error_code_to_http_status', () => {
	test('standard codes map correctly', () => {
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.parse_error), 400);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_request), 400);
		assert.strictEqual(
			jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.method_not_found),
			404
		);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_params), 400);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.internal_error), 500);
	});

	test('application codes map correctly', () => {
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.unauthenticated), 401);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.forbidden), 403);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.not_found), 404);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.conflict), 409);
		assert.strictEqual(
			jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.validation_error),
			422
		);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.rate_limited), 429);
		assert.strictEqual(
			jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.service_unavailable),
			503
		);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.timeout), 504);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.queue_overflow), 429);
		assert.strictEqual(
			jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.request_cancelled),
			499
		);
	});

	test('every base code answers its own status, not the unregistered fallback', () => {
		// keyed by name, so a builtin added to the taxonomy without a row here is a type error
		const expected = {
			parse_error: 400,
			invalid_request: 400,
			method_not_found: 404,
			invalid_params: 400,
			internal_error: 500,
			unauthenticated: 401,
			forbidden: 403,
			not_found: 404,
			conflict: 409,
			validation_error: 422,
			queue_overflow: 429,
			rate_limited: 429,
			service_unavailable: 503,
			timeout: 504,
			request_cancelled: 499
		} satisfies Record<JsonrpcErrorName, number>;
		for (const [name, code] of Object.entries(JSONRPC_ERROR_CODES)) {
			assert.strictEqual(
				jsonrpc_error_code_to_http_status(code),
				expected[name as JsonrpcErrorName],
				name
			);
		}
	});

	test('unrecognized code defaults to 500', () => {
		assert.strictEqual(jsonrpc_error_code_to_http_status(-32097 as JsonrpcErrorCode), 500);
		assert.strictEqual(jsonrpc_error_code_to_http_status(-32020 as JsonrpcErrorCode), 500);
	});
});

// Registration is module state that persists for the file, so every case
// registers its own code, disjoint from the others and from the -32020 and
// -32097 the fallback case above reads as unregistered.
describe('register_jsonrpc_error_code', () => {
	test('a registered code answers its status', () => {
		const code = -32050 as JsonrpcErrorCode;
		assert.strictEqual(jsonrpc_error_code_to_http_status(code), 500);
		register_jsonrpc_error_code(code, 502);
		assert.strictEqual(jsonrpc_error_code_to_http_status(code), 502);
	});

	test('the range ends are registrable', () => {
		register_jsonrpc_error_code(-32000 as JsonrpcErrorCode, 418);
		register_jsonrpc_error_code(-32099 as JsonrpcErrorCode, 451);
		assert.strictEqual(jsonrpc_error_code_to_http_status(-32000 as JsonrpcErrorCode), 418);
		assert.strictEqual(jsonrpc_error_code_to_http_status(-32099 as JsonrpcErrorCode), 451);
	});

	test('registering again with the same status is a no-op', () => {
		const code = -32051 as JsonrpcErrorCode;
		register_jsonrpc_error_code(code, 400);
		register_jsonrpc_error_code(code, 400);
		assert.strictEqual(jsonrpc_error_code_to_http_status(code), 400);
	});

	test('registering again with another status throws and keeps the first', () => {
		const code = -32052 as JsonrpcErrorCode;
		register_jsonrpc_error_code(code, 502);
		assert.throws(
			() => register_jsonrpc_error_code(code, 503),
			/already registered with status 502, not 503/
		);
		assert.strictEqual(jsonrpc_error_code_to_http_status(code), 502);
	});

	test('every base-set code is refused and keeps its status', () => {
		for (const [name, code] of Object.entries(JSONRPC_ERROR_CODES)) {
			const before = jsonrpc_error_code_to_http_status(code);
			// a status no base code answers, so a silent remap would show
			assert.throws(
				() => register_jsonrpc_error_code(code, 507),
				// the five standard codes sit outside the range, and are refused by it
				code > -32100 ? /may not reuse a base-set code/ : /must be an integer in -32099 to -32000/,
				name
			);
			assert.strictEqual(jsonrpc_error_code_to_http_status(code), before, name);
		}
	});

	test('a code outside -32099 to -32000 is refused', () => {
		for (const code of [-32100, -31999, -32768, 0, 500, -32050.5, Number.NaN]) {
			assert.throws(
				() => register_jsonrpc_error_code(code as JsonrpcErrorCode, 502),
				/must be an integer in -32099 to -32000/,
				String(code)
			);
			assert.strictEqual(jsonrpc_error_code_to_http_status(code as JsonrpcErrorCode), 500);
		}
	});

	test('a status outside 400 to 599 is refused', () => {
		const code = -32053 as JsonrpcErrorCode;
		for (const status of [200, 399, 600, 302, 450.5, Number.NaN]) {
			assert.throws(
				() => register_jsonrpc_error_code(code, status),
				/must answer a 4xx or 5xx status/,
				String(status)
			);
		}
		assert.strictEqual(jsonrpc_error_code_to_http_status(code), 500);
		// the boundary statuses are admitted
		register_jsonrpc_error_code(code, 400);
		register_jsonrpc_error_code(-32054 as JsonrpcErrorCode, 599);
	});

	test('a registered code joins neither the reverse map nor the name map', () => {
		const code = -32055 as JsonrpcErrorCode;
		register_jsonrpc_error_code(code, 507);
		assert.strictEqual(jsonrpc_error_code_to_http_status(code), 507);
		assert.strictEqual(http_status_to_jsonrpc_error_code(507), JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(jsonrpc_error_code_to_name(code), 'internal_error');
	});
});

describe('HTTP_STATUS_TO_JSONRPC_ERROR_CODE', () => {
	test('reverse maps known HTTP statuses', () => {
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[401], JSONRPC_ERROR_CODES.unauthenticated);
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[403], JSONRPC_ERROR_CODES.forbidden);
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[409], JSONRPC_ERROR_CODES.conflict);
		assert.strictEqual(
			HTTP_STATUS_TO_JSONRPC_ERROR_CODE[422],
			JSONRPC_ERROR_CODES.validation_error
		);
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[500], JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(
			HTTP_STATUS_TO_JSONRPC_ERROR_CODE[503],
			JSONRPC_ERROR_CODES.service_unavailable
		);
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[504], JSONRPC_ERROR_CODES.timeout);
	});

	test('is frozen', () => {
		assert.ok(Object.isFrozen(HTTP_STATUS_TO_JSONRPC_ERROR_CODE));
	});

	test('400 maps to invalid_params (last of parse_error, invalid_request, invalid_params)', () => {
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[400], JSONRPC_ERROR_CODES.invalid_params);
	});

	test('404 maps to not_found (last of method_not_found, not_found)', () => {
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[404], JSONRPC_ERROR_CODES.not_found);
	});

	test('429 maps to rate_limited, not queue_overflow (server-side wins over client-side)', () => {
		// Load-bearing: the forward status table lists `queue_overflow` before
		// `rate_limited` so the last-wins reverse map resolves 429 to the
		// server-side code. Anyone re-sorting the forward table must preserve this.
		assert.strictEqual(HTTP_STATUS_TO_JSONRPC_ERROR_CODE[429], JSONRPC_ERROR_CODES.rate_limited);
	});
});

describe('http_status_to_jsonrpc_error_code', () => {
	test('maps known statuses', () => {
		assert.strictEqual(http_status_to_jsonrpc_error_code(401), JSONRPC_ERROR_CODES.unauthenticated);
		assert.strictEqual(http_status_to_jsonrpc_error_code(403), JSONRPC_ERROR_CODES.forbidden);
		assert.strictEqual(http_status_to_jsonrpc_error_code(500), JSONRPC_ERROR_CODES.internal_error);
	});

	test('unrecognized status defaults to internal_error', () => {
		assert.strictEqual(http_status_to_jsonrpc_error_code(418), JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(http_status_to_jsonrpc_error_code(200), JSONRPC_ERROR_CODES.internal_error);
	});
});

describe('is_jsonrpc_error_code', () => {
	test('agrees with the JsonrpcErrorCode schema', () => {
		for (const value of [
			-32700,
			-32600,
			-32601,
			-32602,
			-32603,
			-32000,
			-32050,
			-32099,
			-32100,
			-31999,
			-32604,
			0,
			20,
			23,
			404,
			NaN,
			Infinity,
			'-32000',
			null,
			undefined
		]) {
			assert.strictEqual(
				is_jsonrpc_error_code(value),
				JsonrpcErrorCode.safeParse(value).success,
				String(value)
			);
		}
	});

	test('refuses a fractional code in the server range, which JSON-RPC forbids', () => {
		assert.isFalse(is_jsonrpc_error_code(-32000.5));
	});
});

describe('to_thrown_jsonrpc_error', () => {
	test('reads a ThrownJsonrpcError', () => {
		assert.deepStrictEqual(
			to_thrown_jsonrpc_error(
				new ThrownJsonrpcError(JSONRPC_ERROR_CODES.conflict, 'taken', { reason: 'x' })
			),
			{ code: JSONRPC_ERROR_CODES.conflict, message: 'taken', data: { reason: 'x' } }
		);
	});

	test('reads one from a second fuz_app copy by its brand', () => {
		assert.deepStrictEqual(
			to_thrown_jsonrpc_error(
				new SecondCopyThrownJsonrpcError(JSONRPC_ERROR_CODES.not_found, 'gone', { reason: 'y' })
			),
			{ code: JSONRPC_ERROR_CODES.not_found, message: 'gone', data: { reason: 'y' } }
		);
	});

	test('is null for a foreign error class carrying a JSON-RPC code', () => {
		assert.isNull(
			to_thrown_jsonrpc_error(
				new ForeignRpcError(JSONRPC_ERROR_CODES.invalid_params, 'bad', { secret: 'x' })
			)
		);
	});

	test('is null for a ThrownJsonrpcError whose code was cast outside the JSON-RPC set', () => {
		assert.isNull(to_thrown_jsonrpc_error(new ThrownJsonrpcError(42 as JsonrpcErrorCode, 'x')));
	});

	test('leaves data off when the error carries none', () => {
		const error = to_thrown_jsonrpc_error(jsonrpc_errors.forbidden());
		assert.ok(error);
		assert.isFalse('data' in error);
	});

	test('is null for anything but an Error with a JSON-RPC code', () => {
		for (const thrown of [
			new Error('plain'),
			new DOMException('The operation was aborted.', 'AbortError'),
			Object.assign(new Error('x'), { code: 42 }),
			Object.assign(new Error('x'), { code: -32000.5 }),
			Object.assign(new Error('x'), { code: String(JSONRPC_ERROR_CODES.conflict) }),
			{ code: JSONRPC_ERROR_CODES.conflict, message: 'not an Error' },
			'string',
			null
		]) {
			assert.isNull(to_thrown_jsonrpc_error(thrown), JSON.stringify(thrown));
		}
	});
});
