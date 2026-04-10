/**
 * Tests for jsonrpc_errors.ts — JSON-RPC error infrastructure.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	JSONRPC_ERROR_CODES,
	ThrownJsonrpcError,
	jsonrpc_errors,
	jsonrpc_error_messages,
	jsonrpc_error_code_to_http_status,
	type JsonrpcErrorCode,
	type JsonrpcErrorJson,
} from '$lib/http/jsonrpc_errors.js';

describe('JSONRPC_ERROR_CODES', () => {
	test('standard codes have correct values', () => {
		assert.strictEqual(JSONRPC_ERROR_CODES.parse_error as number, -32700);
		assert.strictEqual(JSONRPC_ERROR_CODES.invalid_request as number, -32600);
		assert.strictEqual(JSONRPC_ERROR_CODES.method_not_found as number, -32601);
		assert.strictEqual(JSONRPC_ERROR_CODES.invalid_params as number, -32602);
		assert.strictEqual(JSONRPC_ERROR_CODES.internal_error as number, -32603);
	});

	test('application codes have correct values', () => {
		assert.strictEqual(JSONRPC_ERROR_CODES.unauthenticated as number, -32001);
		assert.strictEqual(JSONRPC_ERROR_CODES.forbidden as number, -32002);
		assert.strictEqual(JSONRPC_ERROR_CODES.not_found as number, -32003);
		assert.strictEqual(JSONRPC_ERROR_CODES.conflict as number, -32004);
		assert.strictEqual(JSONRPC_ERROR_CODES.validation_error as number, -32005);
		assert.strictEqual(JSONRPC_ERROR_CODES.rate_limited as number, -32006);
		assert.strictEqual(JSONRPC_ERROR_CODES.service_unavailable as number, -32007);
		assert.strictEqual(JSONRPC_ERROR_CODES.timeout as number, -32008);
	});

	test('has 13 error codes total (5 standard + 8 application)', () => {
		assert.strictEqual(Object.keys(JSONRPC_ERROR_CODES).length, 13);
	});
});

describe('ThrownJsonrpcError', () => {
	test('carries code, message, and data', () => {
		const err = new ThrownJsonrpcError(JSONRPC_ERROR_CODES.not_found, 'user not found', {
			id: 42,
		});
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(err.message, 'user not found');
		assert.deepStrictEqual(err.data, {id: 42});
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
			cause,
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
		const err = jsonrpc_errors.conflict('duplicate', {field: 'username'});
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.conflict);
		assert.strictEqual(err.message, 'duplicate');
		assert.deepStrictEqual(err.data, {field: 'username'});
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
		const err = jsonrpc_errors.parse_error({offset: 42});
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.parse_error);
		assert.strictEqual(err.message, 'parse error');
		assert.deepStrictEqual(err.data, {offset: 42});
	});

	test('invalid_request with data', () => {
		const err = jsonrpc_errors.invalid_request({reason: 'missing jsonrpc field'});
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.invalid_request);
		assert.strictEqual(err.message, 'invalid request');
		assert.deepStrictEqual(err.data, {reason: 'missing jsonrpc field'});
	});
});

describe('jsonrpc_error_messages', () => {
	test('produces correct JsonrpcErrorJson shape', () => {
		const msg = jsonrpc_error_messages.not_found('session');
		assert.strictEqual(msg.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(msg.message, 'session not found');
		assert.strictEqual(msg.data, undefined);
	});

	test('includes data when provided', () => {
		const msg = jsonrpc_error_messages.internal_error('db error', {table: 'users'});
		assert.strictEqual(msg.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(msg.message, 'db error');
		assert.deepStrictEqual(msg.data, {table: 'users'});
	});

	test('all constructors return code and message', () => {
		const names = Object.keys(jsonrpc_error_messages) as Array<keyof typeof jsonrpc_error_messages>;
		for (const name of names) {
			const fn = jsonrpc_error_messages[name] as (...args: Array<any>) => JsonrpcErrorJson;
			const result = fn();
			assert.ok(typeof result.code === 'number', `${name} should have numeric code`);
			assert.ok(typeof result.message === 'string', `${name} should have string message`);
			assert.strictEqual(
				result.code,
				JSONRPC_ERROR_CODES[name],
				`${name} code should match JSONRPC_ERROR_CODES`,
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
			404,
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
			422,
		);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.rate_limited), 429);
		assert.strictEqual(
			jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.service_unavailable),
			503,
		);
		assert.strictEqual(jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.timeout), 504);
	});

	test('all 13 codes have mappings', () => {
		for (const [name, code] of Object.entries(JSONRPC_ERROR_CODES)) {
			const status = jsonrpc_error_code_to_http_status(code);
			assert.ok(status >= 400 && status <= 599, `${name} should map to 4xx or 5xx status`);
		}
	});

	test('unrecognized code defaults to 500', () => {
		assert.strictEqual(jsonrpc_error_code_to_http_status(-32099 as JsonrpcErrorCode), 500);
		assert.strictEqual(jsonrpc_error_code_to_http_status(-32020 as JsonrpcErrorCode), 500);
	});
});
