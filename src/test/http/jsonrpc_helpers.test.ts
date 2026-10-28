/**
 * Tests for jsonrpc_helpers.ts — JSON-RPC message builders, type guards, and converters.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { JSONRPC_VERSION, type JsonrpcRequestId } from '#lib/http/jsonrpc.ts';
import { ThrownJsonrpcError, JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import {
	classify_jsonrpc_message,
	create_jsonrpc_request,
	create_jsonrpc_response,
	create_jsonrpc_notification,
	create_jsonrpc_error_response,
	create_jsonrpc_error_response_from_thrown,
	is_jsonrpc_request_id,
	is_jsonrpc_object,
	is_jsonrpc_request,
	is_jsonrpc_notification,
	is_jsonrpc_response,
	is_jsonrpc_error_response,
	to_jsonrpc_message_id,
	to_jsonrpc_params
} from '#lib/http/jsonrpc_helpers.ts';

describe('create_jsonrpc_request', () => {
	test('creates request with params', () => {
		const req = create_jsonrpc_request('ping', { foo: 'bar' }, 1);
		assert.strictEqual(req.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(req.method, 'ping');
		assert.strictEqual(req.id, 1);
		assert.deepStrictEqual(req.params, { foo: 'bar' });
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
		const res = create_jsonrpc_response(1, { value: 42 });
		assert.strictEqual(res.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(res.id, 1);
		assert.deepStrictEqual(res.result, { value: 42 });
	});
});

describe('create_jsonrpc_notification', () => {
	test('creates notification with params', () => {
		const n = create_jsonrpc_notification('event', { data: 'test' });
		assert.strictEqual(n.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(n.method, 'event');
		assert.deepStrictEqual(n.params, { data: 'test' });
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
			message: 'not found'
		});
		assert.strictEqual(err.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(err.id, 1);
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(err.error.message, 'not found');
	});

	test('accepts null id', () => {
		const err = create_jsonrpc_error_response(null, {
			code: JSONRPC_ERROR_CODES.parse_error,
			message: 'parse error'
		});
		assert.strictEqual(err.id, null);
	});
});

describe('create_jsonrpc_error_response_from_thrown', () => {
	test('handles ThrownJsonrpcError', () => {
		const thrown = new ThrownJsonrpcError(JSONRPC_ERROR_CODES.forbidden, 'nope', {
			reason: 'test'
		});
		const err = create_jsonrpc_error_response_from_thrown(1, thrown);
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.forbidden);
		assert.strictEqual(err.error.message, 'nope');
		assert.deepStrictEqual(err.error.data, { reason: 'test' });
	});

	test('handles regular Error', () => {
		const err = create_jsonrpc_error_response_from_thrown(1, new Error('boom'));
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(err.error.message, 'boom');
		// DEV is true in vitest — stack trace should be included
		assert.ok(err.error.data);
		assert.ok((err.error.data as { stack: string }).stack);
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
		assert.ok(is_jsonrpc_object({ jsonrpc: '2.0' }));
		assert.ok(is_jsonrpc_object({ jsonrpc: '2.0', method: 'ping' }));
	});

	test('rejects non-objects and wrong version', () => {
		assert.ok(!is_jsonrpc_object(null));
		assert.ok(!is_jsonrpc_object('string'));
		assert.ok(!is_jsonrpc_object([]));
		assert.ok(!is_jsonrpc_object({ jsonrpc: '1.0' }));
		assert.ok(!is_jsonrpc_object({}));
	});
});

describe('is_jsonrpc_request', () => {
	test('accepts requests (method + id)', () => {
		assert.ok(is_jsonrpc_request({ jsonrpc: '2.0', method: 'ping', id: 1 }));
	});

	test('rejects notifications (no id)', () => {
		assert.ok(!is_jsonrpc_request({ jsonrpc: '2.0', method: 'ping' }));
	});

	test('rejects responses', () => {
		assert.ok(!is_jsonrpc_request({ jsonrpc: '2.0', result: {}, id: 1 }));
	});
});

describe('is_jsonrpc_notification', () => {
	test('accepts notifications (method, no id)', () => {
		assert.ok(is_jsonrpc_notification({ jsonrpc: '2.0', method: 'event' }));
	});

	test('rejects requests (has id)', () => {
		assert.ok(!is_jsonrpc_notification({ jsonrpc: '2.0', method: 'ping', id: 1 }));
	});
});

describe('is_jsonrpc_response', () => {
	test('accepts responses (result + id)', () => {
		assert.ok(is_jsonrpc_response({ jsonrpc: '2.0', result: {}, id: 1 }));
	});

	test('rejects error responses', () => {
		assert.ok(
			!is_jsonrpc_response({ jsonrpc: '2.0', error: { code: -32600, message: 'bad' }, id: 1 })
		);
	});
});

describe('is_jsonrpc_error_response', () => {
	test('accepts error responses (error + id)', () => {
		assert.ok(
			is_jsonrpc_error_response({ jsonrpc: '2.0', error: { code: -32600, message: 'bad' }, id: 1 })
		);
	});

	test('accepts error responses with null id', () => {
		assert.ok(
			is_jsonrpc_error_response({
				jsonrpc: '2.0',
				error: { code: -32700, message: 'parse error' },
				id: null
			})
		);
	});

	test('rejects success responses', () => {
		assert.ok(!is_jsonrpc_error_response({ jsonrpc: '2.0', result: {}, id: 1 }));
	});
});

describe('to_jsonrpc_message_id', () => {
	test('extracts id from message object', () => {
		assert.strictEqual(to_jsonrpc_message_id({ id: 42 }), 42);
		assert.strictEqual(to_jsonrpc_message_id({ id: 'abc' }), 'abc');
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
		assert.strictEqual(to_jsonrpc_message_id({ id: NaN }), null);
		assert.strictEqual(to_jsonrpc_message_id({ id: Infinity }), null);
		assert.strictEqual(to_jsonrpc_message_id({ id: -Infinity }), null);
	});
});

describe('to_jsonrpc_params', () => {
	test('passes through objects', () => {
		const obj = { foo: 'bar' };
		assert.strictEqual(to_jsonrpc_params(obj), obj);
	});

	test('returns undefined for null/undefined', () => {
		assert.strictEqual(to_jsonrpc_params(null), undefined);
		assert.strictEqual(to_jsonrpc_params(undefined), undefined);
	});

	test('wraps primitives in {value}', () => {
		assert.deepStrictEqual(to_jsonrpc_params('hello'), { value: 'hello' });
		assert.deepStrictEqual(to_jsonrpc_params(42), { value: 42 });
	});

	test('wraps arrays in {value}', () => {
		assert.deepStrictEqual(to_jsonrpc_params([1, 2]), { value: [1, 2] });
	});
});

describe('classify_jsonrpc_message', () => {
	// The Rust twin's `classify` cases, plus the TS-side edges the WS and POST
	// paths read. `issues` is whether an `invalid` carries the envelope schema's
	// DEV-only `data.issues` — only a refused request envelope does.
	type Expected =
		| { kind: 'request'; method: string; id: JsonrpcRequestId; params: unknown }
		| { kind: 'notification'; method: string; params: unknown }
		| { kind: 'response'; id: JsonrpcRequestId }
		| { kind: 'invalid'; id: JsonrpcRequestId | null; issues: boolean };
	const v = JSONRPC_VERSION;
	const cases: Array<[string, unknown, Expected]> = [
		[
			'a request',
			{ jsonrpc: v, method: 'ping', id: 1, params: { x: 1 } },
			{ kind: 'request', method: 'ping', id: 1, params: { x: 1 } }
		],
		[
			'a request with a string id',
			{ jsonrpc: v, method: 'ping', id: 'req-1' },
			{ kind: 'request', method: 'ping', id: 'req-1', params: undefined }
		],
		[
			'a request with empty params',
			{ jsonrpc: v, method: 'ping', id: 1, params: {} },
			{ kind: 'request', method: 'ping', id: 1, params: {} }
		],
		...[null, [], ['3f8a1c2e'], 'x', 1, true].map((params): [string, unknown, Expected] => [
			`a request with params ${JSON.stringify(params)}`,
			{ jsonrpc: v, method: 'ping', id: 7, params },
			{ kind: 'invalid', id: 7, issues: true }
		]),
		[
			'a notification',
			{ jsonrpc: v, method: 'evt' },
			{ kind: 'notification', method: 'evt', params: undefined }
		],
		[
			'a notification carrying params',
			{ jsonrpc: v, method: 'cancel', params: { request_id: 'r-9' } },
			{ kind: 'notification', method: 'cancel', params: { request_id: 'r-9' } }
		],
		...[null, [1], 'x'].map((params): [string, unknown, Expected] => [
			`a notification with params ${JSON.stringify(params)}, unvalidated`,
			{ jsonrpc: v, method: 'evt', params },
			{ kind: 'notification', method: 'evt', params }
		]),
		[
			'a response with a result',
			{ jsonrpc: v, id: 's7', result: { nonce: 9 } },
			{ kind: 'response', id: 's7' }
		],
		[
			'a response with a null result',
			{ jsonrpc: v, id: 3, result: null },
			{ kind: 'response', id: 3 }
		],
		[
			'a response with an error',
			{ jsonrpc: v, id: 's1', error: { code: -32603, message: 'x', data: { x: 1 } } },
			{ kind: 'response', id: 's1' }
		],
		[
			'a response with a non-string method',
			{ jsonrpc: v, id: 's2', method: 123, result: 1 },
			{ kind: 'response', id: 's2' }
		],
		[
			'a response with both result and error',
			{ jsonrpc: v, id: 's1', result: 1, error: { code: -32603, message: 'x' } },
			{ kind: 'invalid', id: 's1', issues: false }
		],
		[
			'a response with a null id',
			{ jsonrpc: v, id: null, result: 1 },
			{ kind: 'invalid', id: null, issues: false }
		],
		[
			'a request-shaped frame with a result is a request',
			{ jsonrpc: v, id: 1, method: 'ping', result: 1 },
			{ kind: 'request', method: 'ping', id: 1, params: undefined }
		],
		['an array', [1, 2, 3], { kind: 'invalid', id: null, issues: false }],
		[
			'a batch',
			[{ jsonrpc: v, id: 1, method: 'ping' }],
			{ kind: 'invalid', id: null, issues: false }
		],
		['a scalar is never its own id', 5, { kind: 'invalid', id: null, issues: false }],
		['a string', 'abc', { kind: 'invalid', id: null, issues: false }],
		['null', null, { kind: 'invalid', id: null, issues: false }],
		['a missing jsonrpc', { method: 'ping', id: 1 }, { kind: 'invalid', id: 1, issues: false }],
		[
			'a wrong jsonrpc version',
			{ jsonrpc: '1.0', method: 'ping', id: 1 },
			{ kind: 'invalid', id: 1, issues: false }
		],
		[
			'a response with a wrong version',
			{ jsonrpc: '1.0', id: 's3', result: 1 },
			{ kind: 'invalid', id: 's3', issues: false }
		],
		[
			'a wrong version with a method and no id',
			{ jsonrpc: '1.0', method: 'x' },
			{ kind: 'invalid', id: null, issues: false }
		],
		[
			'a null id',
			{ jsonrpc: v, method: 'ping', id: null },
			{ kind: 'invalid', id: null, issues: true }
		],
		[
			'a boolean id',
			{ jsonrpc: v, method: 'ping', id: true },
			{ kind: 'invalid', id: null, issues: true }
		],
		['a missing method', { jsonrpc: v, id: 1 }, { kind: 'invalid', id: 1, issues: false }],
		[
			'a non-string method with an id',
			{ jsonrpc: v, method: 123, id: 4 },
			{ kind: 'invalid', id: 4, issues: true }
		],
		[
			'a non-string method with no id',
			{ jsonrpc: v, method: 123 },
			{ kind: 'invalid', id: null, issues: false }
		]
	];

	for (const [name, input, expected] of cases) {
		test(name, () => {
			const classified = classify_jsonrpc_message(input);
			assert.strictEqual(classified.kind, expected.kind);
			switch (classified.kind) {
				case 'request': {
					assert(expected.kind === 'request');
					const { method, id, params } = classified.request;
					assert.deepStrictEqual(
						{ method, id, params },
						{
							method: expected.method,
							id: expected.id,
							params: expected.params
						}
					);
					break;
				}
				case 'notification':
					assert(expected.kind === 'notification');
					assert.strictEqual(classified.method, expected.method);
					assert.deepStrictEqual(classified.params, expected.params);
					break;
				case 'response':
					assert(expected.kind === 'response');
					assert.strictEqual(classified.response.id, expected.id);
					assert.strictEqual(classified.response, input, 'the frame itself');
					break;
				case 'invalid': {
					assert(expected.kind === 'invalid');
					assert.strictEqual(classified.id, expected.id);
					assert.strictEqual(classified.error.code, JSONRPC_ERROR_CODES.invalid_request);
					const data = classified.error.data as { issues?: unknown } | undefined;
					assert.strictEqual(data?.issues !== undefined, expected.issues, 'DEV issues');
					break;
				}
			}
		});
	}
});
