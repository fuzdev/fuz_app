/**
 * Tests for jsonrpc_helpers.ts — JSON-RPC message builders, type guards, and converters.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {JSONRPC_VERSION} from '$lib/http/jsonrpc.js';
import {ThrownJsonrpcError, JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {
	create_jsonrpc_request,
	create_jsonrpc_response,
	create_jsonrpc_notification,
	create_jsonrpc_error_response,
	create_jsonrpc_error_response_from_thrown,
	is_jsonrpc_request_id,
	is_jsonrpc_object,
	is_jsonrpc_message,
	is_jsonrpc_request,
	is_jsonrpc_notification,
	is_jsonrpc_response,
	is_jsonrpc_error_response,
	to_jsonrpc_message_id,
	to_jsonrpc_params,
	to_jsonrpc_result,
} from '$lib/http/jsonrpc_helpers.js';

describe('create_jsonrpc_request', () => {
	test('creates request with params', () => {
		const req = create_jsonrpc_request('ping', {foo: 'bar'}, 1);
		assert.strictEqual(req.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(req.method, 'ping');
		assert.strictEqual(req.id, 1);
		assert.deepStrictEqual(req.params, {foo: 'bar'});
	});

	test('omits params when undefined', () => {
		const req = create_jsonrpc_request('ping', undefined, 'abc');
		assert.strictEqual(req.method, 'ping');
		assert.strictEqual(req.id, 'abc');
		assert.strictEqual(req.params, undefined);
	});
});

describe('create_jsonrpc_response', () => {
	test('creates response with result', () => {
		const res = create_jsonrpc_response(1, {value: 42});
		assert.strictEqual(res.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(res.id, 1);
		assert.deepStrictEqual(res.result, {value: 42});
	});
});

describe('create_jsonrpc_notification', () => {
	test('creates notification with params', () => {
		const n = create_jsonrpc_notification('event', {data: 'test'});
		assert.strictEqual(n.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(n.method, 'event');
		assert.deepStrictEqual(n.params, {data: 'test'});
	});

	test('omits params when undefined', () => {
		const n = create_jsonrpc_notification('event', undefined);
		assert.strictEqual(n.method, 'event');
		assert.strictEqual(n.params, undefined);
	});
});

describe('create_jsonrpc_error_response', () => {
	test('creates error response', () => {
		const err = create_jsonrpc_error_response(1, {
			code: JSONRPC_ERROR_CODES.not_found,
			message: 'not found',
		});
		assert.strictEqual(err.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(err.id, 1);
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(err.error.message, 'not found');
	});

	test('accepts null id', () => {
		const err = create_jsonrpc_error_response(null, {
			code: JSONRPC_ERROR_CODES.parse_error,
			message: 'parse error',
		});
		assert.strictEqual(err.id, null);
	});
});

describe('create_jsonrpc_error_response_from_thrown', () => {
	test('handles ThrownJsonrpcError', () => {
		const thrown = new ThrownJsonrpcError(JSONRPC_ERROR_CODES.forbidden, 'nope', {reason: 'test'});
		const err = create_jsonrpc_error_response_from_thrown(1, thrown);
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.forbidden);
		assert.strictEqual(err.error.message, 'nope');
		assert.deepStrictEqual(err.error.data, {reason: 'test'});
	});

	test('handles regular Error', () => {
		const err = create_jsonrpc_error_response_from_thrown(1, new Error('boom'));
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(err.error.message, 'boom');
		// DEV is true in vitest — stack trace should be included
		assert.ok(err.error.data);
		assert.ok((err.error.data as {stack: string}).stack);
	});

	test('handles non-Error values', () => {
		const err = create_jsonrpc_error_response_from_thrown(null, 'string error');
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(err.error.message, 'internal server error');
		assert.strictEqual(err.id, null);
	});
});

describe('is_jsonrpc_request_id', () => {
	test('accepts strings', () => {
		assert.ok(is_jsonrpc_request_id('abc'));
		assert.ok(is_jsonrpc_request_id(''));
	});

	test('accepts finite numbers', () => {
		assert.ok(is_jsonrpc_request_id(1));
		assert.ok(is_jsonrpc_request_id(0));
		assert.ok(is_jsonrpc_request_id(-1));
	});

	test('rejects NaN and Infinity', () => {
		assert.ok(!is_jsonrpc_request_id(NaN));
		assert.ok(!is_jsonrpc_request_id(Infinity));
		assert.ok(!is_jsonrpc_request_id(-Infinity));
	});

	test('rejects non-string non-number', () => {
		assert.ok(!is_jsonrpc_request_id(null));
		assert.ok(!is_jsonrpc_request_id(undefined));
		assert.ok(!is_jsonrpc_request_id(true));
		assert.ok(!is_jsonrpc_request_id({}));
	});
});

describe('is_jsonrpc_object', () => {
	test('accepts objects with jsonrpc 2.0', () => {
		assert.ok(is_jsonrpc_object({jsonrpc: '2.0'}));
		assert.ok(is_jsonrpc_object({jsonrpc: '2.0', method: 'ping'}));
	});

	test('rejects non-objects and wrong version', () => {
		assert.ok(!is_jsonrpc_object(null));
		assert.ok(!is_jsonrpc_object('string'));
		assert.ok(!is_jsonrpc_object([]));
		assert.ok(!is_jsonrpc_object({jsonrpc: '1.0'}));
		assert.ok(!is_jsonrpc_object({}));
	});
});

describe('is_jsonrpc_message', () => {
	test('accepts single JSON-RPC objects', () => {
		assert.ok(is_jsonrpc_message({jsonrpc: '2.0', method: 'ping', id: 1}));
	});

	test('accepts arrays of JSON-RPC objects', () => {
		assert.ok(
			is_jsonrpc_message([
				{jsonrpc: '2.0', method: 'a', id: 1},
				{jsonrpc: '2.0', method: 'b', id: 2},
			]),
		);
	});

	test('rejects empty arrays', () => {
		assert.ok(!is_jsonrpc_message([]));
	});
});

describe('is_jsonrpc_request', () => {
	test('accepts requests (method + id)', () => {
		assert.ok(is_jsonrpc_request({jsonrpc: '2.0', method: 'ping', id: 1}));
	});

	test('rejects notifications (no id)', () => {
		assert.ok(!is_jsonrpc_request({jsonrpc: '2.0', method: 'ping'}));
	});

	test('rejects responses', () => {
		assert.ok(!is_jsonrpc_request({jsonrpc: '2.0', result: {}, id: 1}));
	});
});

describe('is_jsonrpc_notification', () => {
	test('accepts notifications (method, no id)', () => {
		assert.ok(is_jsonrpc_notification({jsonrpc: '2.0', method: 'event'}));
	});

	test('rejects requests (has id)', () => {
		assert.ok(!is_jsonrpc_notification({jsonrpc: '2.0', method: 'ping', id: 1}));
	});
});

describe('is_jsonrpc_response', () => {
	test('accepts responses (result + id)', () => {
		assert.ok(is_jsonrpc_response({jsonrpc: '2.0', result: {}, id: 1}));
	});

	test('rejects error responses', () => {
		assert.ok(!is_jsonrpc_response({jsonrpc: '2.0', error: {code: -32600, message: 'bad'}, id: 1}));
	});
});

describe('is_jsonrpc_error_response', () => {
	test('accepts error responses (error + id)', () => {
		assert.ok(
			is_jsonrpc_error_response({jsonrpc: '2.0', error: {code: -32600, message: 'bad'}, id: 1}),
		);
	});

	test('accepts error responses with null id', () => {
		assert.ok(
			is_jsonrpc_error_response({
				jsonrpc: '2.0',
				error: {code: -32700, message: 'parse error'},
				id: null,
			}),
		);
	});

	test('rejects success responses', () => {
		assert.ok(!is_jsonrpc_error_response({jsonrpc: '2.0', result: {}, id: 1}));
	});
});

describe('to_jsonrpc_message_id', () => {
	test('extracts id from message object', () => {
		assert.strictEqual(to_jsonrpc_message_id({id: 42}), 42);
		assert.strictEqual(to_jsonrpc_message_id({id: 'abc'}), 'abc');
	});

	test('passes through raw id', () => {
		assert.strictEqual(to_jsonrpc_message_id(42), 42);
		assert.strictEqual(to_jsonrpc_message_id('abc'), 'abc');
	});

	test('returns null for invalid values', () => {
		assert.strictEqual(to_jsonrpc_message_id(null), null);
		assert.strictEqual(to_jsonrpc_message_id(undefined), null);
		assert.strictEqual(to_jsonrpc_message_id({}), null);
	});

	test('handles falsy-but-valid ids', () => {
		assert.strictEqual(to_jsonrpc_message_id(0), 0);
		assert.strictEqual(to_jsonrpc_message_id(''), '');
	});

	test('rejects NaN and Infinity in objects', () => {
		assert.strictEqual(to_jsonrpc_message_id({id: NaN}), null);
		assert.strictEqual(to_jsonrpc_message_id({id: Infinity}), null);
		assert.strictEqual(to_jsonrpc_message_id({id: -Infinity}), null);
	});
});

describe('to_jsonrpc_params', () => {
	test('passes through objects', () => {
		const obj = {foo: 'bar'};
		assert.strictEqual(to_jsonrpc_params(obj), obj);
	});

	test('returns undefined for null/undefined', () => {
		assert.strictEqual(to_jsonrpc_params(null), undefined);
		assert.strictEqual(to_jsonrpc_params(undefined), undefined);
	});

	test('wraps primitives in {value}', () => {
		assert.deepStrictEqual(to_jsonrpc_params('hello'), {value: 'hello'});
		assert.deepStrictEqual(to_jsonrpc_params(42), {value: 42});
	});

	test('wraps arrays in {value}', () => {
		assert.deepStrictEqual(to_jsonrpc_params([1, 2]), {value: [1, 2]});
	});
});

describe('to_jsonrpc_result', () => {
	test('passes through objects', () => {
		const obj = {foo: 'bar'};
		assert.strictEqual(to_jsonrpc_result(obj), obj);
	});

	test('returns empty object for null/undefined', () => {
		assert.deepStrictEqual(to_jsonrpc_result(null), {});
		assert.deepStrictEqual(to_jsonrpc_result(undefined), {});
	});

	test('wraps primitives in {value}', () => {
		assert.deepStrictEqual(to_jsonrpc_result('hello'), {value: 'hello'});
		assert.deepStrictEqual(to_jsonrpc_result(42), {value: 42});
	});

	test('wraps arrays in {value}', () => {
		assert.deepStrictEqual(to_jsonrpc_result([1, 2]), {value: [1, 2]});
	});
});
