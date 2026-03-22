/**
 * Unit tests for API token generation and hashing.
 *
 * Tests the pure cryptographic functions in `auth/api_token.ts`.
 * Integration tests for token CRUD and validation live in
 * `src/test/middleware/api_token.test.ts`.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {API_TOKEN_PREFIX, generate_api_token, hash_api_token} from '$lib/auth/api_token.js';

describe('API_TOKEN_PREFIX', () => {
	test('is the expected value', () => {
		assert.strictEqual(API_TOKEN_PREFIX, 'secret_fuz_token_');
	});
});

describe('generate_api_token', () => {
	test('token starts with prefix', () => {
		const {token} = generate_api_token();

		assert.ok(token.startsWith(API_TOKEN_PREFIX));
	});

	test('token body is base64url (no +, /, or =)', () => {
		const {token} = generate_api_token();
		const body = token.slice(API_TOKEN_PREFIX.length);

		assert.ok(!body.includes('+'), 'should not contain +');
		assert.ok(!body.includes('/'), 'should not contain /');
		assert.ok(!body.includes('='), 'should not contain padding');
	});

	test('id starts with tok_ prefix', () => {
		const {id} = generate_api_token();

		assert.ok(id.startsWith('tok_'));
	});

	test('id is tok_ plus 12 chars', () => {
		const {id} = generate_api_token();

		assert.strictEqual(id.length, 4 + 12);
	});

	test('token_hash is a 64-char hex string', () => {
		const {token_hash} = generate_api_token();

		assert.strictEqual(token_hash.length, 64);
		assert.ok(/^[0-9a-f]{64}$/.test(token_hash));
	});

	test('generates unique tokens', () => {
		const a = generate_api_token();
		const b = generate_api_token();

		assert.notStrictEqual(a.token, b.token);
		assert.notStrictEqual(a.id, b.id);
		assert.notStrictEqual(a.token_hash, b.token_hash);
	});

	test('hash matches hash_api_token of the token', () => {
		const {token, token_hash} = generate_api_token();

		assert.strictEqual(hash_api_token(token), token_hash);
	});
});

describe('hash_api_token', () => {
	test('returns 64-char hex string', () => {
		const hash = hash_api_token('test_token');

		assert.strictEqual(hash.length, 64);
		assert.ok(/^[0-9a-f]{64}$/.test(hash));
	});

	test('is deterministic', () => {
		const a = hash_api_token('same_input');
		const b = hash_api_token('same_input');

		assert.strictEqual(a, b);
	});

	test('different inputs produce different hashes', () => {
		const a = hash_api_token('input_a');
		const b = hash_api_token('input_b');

		assert.notStrictEqual(a, b);
	});
});
