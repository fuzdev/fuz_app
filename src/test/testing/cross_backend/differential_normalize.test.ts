import { assert, describe, test } from 'vitest';

import {
	diff_differential_responses,
	differential_path_covers,
	normalize_differential_response
} from '#lib/testing/cross_backend/differential_normalize.ts';

const UUID_A = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const UUID_B = '11111111-2222-4333-8444-555555555555';
const UUID_C = '99999999-8888-4777-8666-555555555555';

describe('normalize_differential_response', () => {
	test('numbers volatile values by first appearance, per kind', () => {
		const n = normalize_differential_response({
			status: 200,
			headers: {},
			body: {
				a_owner: UUID_A,
				b_rows: [{ id: UUID_B, owner: UUID_A }],
				c_at: '2026-10-25T12:00:00Z',
				d_token: 'secret_fuz_token_abcDEF123_-xyz',
				e_token_id: 'tok_abC0_d-3xyzA',
				f_hash: 'a'.repeat(64),
				g_message: `account ${UUID_B} not found`
			}
		});
		assert.deepEqual(n.body, {
			a_owner: '<uuid:1>',
			b_rows: [{ id: '<uuid:2>', owner: '<uuid:1>' }],
			c_at: '<timestamp:1>',
			d_token: '<token:1>',
			e_token_id: '<token_id:1>',
			f_hash: '<hash:1>',
			g_message: 'account <uuid:2> not found'
		});
	});

	test('two responses with different ids in the same relations normalize equal', () => {
		const a = normalize_differential_response({
			status: 200,
			headers: {},
			body: { owner: UUID_A, rows: [{ id: UUID_B, owner: UUID_A }] }
		});
		const b = normalize_differential_response({
			status: 200,
			headers: {},
			body: { owner: UUID_C, rows: [{ id: UUID_A, owner: UUID_C }] }
		});
		assert.deepEqual(diff_differential_responses(a, b), []);
	});

	test('a broken identity relation differs', () => {
		const a = normalize_differential_response({
			status: 200,
			headers: {},
			body: { owner: UUID_A, rows: [{ owner: UUID_A }] }
		});
		const b = normalize_differential_response({
			status: 200,
			headers: {},
			body: { owner: UUID_A, rows: [{ owner: UUID_B }] }
		});
		assert.deepEqual(diff_differential_responses(a, b), [
			{ path: 'body.rows[0].owner', a: '<uuid:1>', b: '<uuid:2>' }
		]);
	});

	test('non-canonical spellings stay raw', () => {
		const n = normalize_differential_response({
			status: 200,
			headers: {},
			body: { upper: UUID_A.toUpperCase(), millis: '2026-10-25T12:00:00.123Z' }
		});
		assert.deepEqual(n.body, {
			upper: UUID_A.toUpperCase(),
			millis: '2026-10-25T12:00:00.123Z'
		});
	});

	test('key order is ignored, array order is not', () => {
		const a = normalize_differential_response({
			status: 200,
			headers: {},
			body: { x: 1, y: [1, 2] }
		});
		const b = normalize_differential_response({
			status: 200,
			headers: {},
			body: { y: [2, 1], x: 1 }
		});
		assert.deepEqual(
			diff_differential_responses(a, b).map((d) => d.path),
			['body.y[0]', 'body.y[1]']
		);
	});

	test('header names are sorted, volatile ones dropped, values ignored', () => {
		const n = normalize_differential_response({
			status: 200,
			headers: {
				'set-cookie': 'session=abc',
				'content-type': 'application/json',
				date: 'Sun, 25 Oct 2026 12:00:00 GMT',
				'content-length': '12',
				connection: 'keep-alive',
				'keep-alive': 'timeout=5',
				'transfer-encoding': 'chunked'
			},
			body: null
		});
		assert.deepEqual(n.header_names, ['content-type', 'set-cookie']);
	});
});

describe('content addresses', () => {
	const fact = (hash: string) =>
		normalize_differential_response({ status: 200, headers: {}, body: { hash } });

	test('a blake3 content address stays verbatim', () => {
		const hash = `blake3:${'c'.repeat(64)}`;
		assert.deepEqual(fact(hash).body, { hash });
	});

	test('the same content address on both sides is equal', () => {
		const hash = `blake3:${'c'.repeat(64)}`;
		assert.deepEqual(diff_differential_responses(fact(hash), fact(hash)), []);
	});

	test('different content addresses differ', () => {
		const a = `blake3:${'c'.repeat(64)}`;
		const b = `blake3:${'d'.repeat(64)}`;
		assert.deepEqual(diff_differential_responses(fact(a), fact(b)), [{ path: 'body.hash', a, b }]);
	});

	test('a bare digest is still placeholdered', () => {
		assert.deepEqual(diff_differential_responses(fact('c'.repeat(64)), fact('d'.repeat(64))), []);
	});
});

describe('diff_differential_responses', () => {
	test('a header one side sent is its own path', () => {
		const diffs = diff_differential_responses(
			{ status: 401, body: null, header_names: ['content-type', 'x-extra'] },
			{ status: 401, body: null, header_names: ['content-type'] }
		);
		assert.deepEqual(diffs, [{ path: 'headers.x-extra', a: true, b: undefined }]);
	});

	test('an object one side lacks diffs key by key', () => {
		const diffs = diff_differential_responses(
			{ status: 400, body: { error: { code: -32602 } }, header_names: [] },
			{
				status: 400,
				body: { error: { code: -32602, data: { reason: 'limit_out_of_range' } } },
				header_names: []
			}
		);
		assert.deepEqual(diffs, [
			{ path: 'body.error.data.reason', a: undefined, b: 'limit_out_of_range' }
		]);
	});

	test('an empty object against a missing one differs', () => {
		assert.deepEqual(
			diff_differential_responses(
				{ status: 400, body: { error: { code: -32602, data: {} } }, header_names: [] },
				{ status: 400, body: { error: { code: -32602 } }, header_names: [] }
			),
			[{ path: 'body.error.data', a: {}, b: undefined }]
		);
	});

	test('status and a type change both show', () => {
		const diffs = diff_differential_responses(
			{ status: 200, body: { n: 1 }, header_names: [] },
			{ status: 201, body: { n: '1' }, header_names: [] }
		);
		assert.deepEqual(diffs, [
			{ path: 'status', a: 200, b: 201 },
			{ path: 'body.n', a: 1, b: '1' }
		]);
	});
});

describe('differential_path_covers', () => {
	test('covers itself and what lies under it, not a sibling prefix', () => {
		assert.ok(differential_path_covers('body.error.data', 'body.error.data'));
		assert.ok(differential_path_covers('body.error.data', 'body.error.data.reason'));
		assert.ok(differential_path_covers('body.error.data', 'body.error.data[0]'));
		assert.ok(!differential_path_covers('body.error.data', 'body.error.database'));
		assert.ok(!differential_path_covers('body.error.data.reason', 'body.error.data'));
	});
});
