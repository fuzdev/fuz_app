/**
 * Unit tests for API token generation and hashing.
 *
 * Tests the pure cryptographic functions in `auth/api_token.ts`.
 * Integration tests for token CRUD and validation live in
 * `src/test/middleware/api_token.test.ts`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	API_TOKEN_BODY_LENGTH,
	API_TOKEN_PREFIX,
	generate_api_token,
	hash_api_token,
	is_api_token_shaped
} from '#lib/auth/api_token.ts';
import { create_test_raw_api_token } from '#lib/testing/entities.ts';

describe('API_TOKEN_PREFIX', () => {
	test('is the expected value', () => {
		assert.strictEqual(API_TOKEN_PREFIX, 'secret_fuz_token_');
	});
});

describe('generate_api_token', () => {
	test('token starts with prefix', () => {
		const { token } = generate_api_token();

		assert.ok(token.startsWith(API_TOKEN_PREFIX));
	});

	test('token body is base64url (no +, /, or =)', () => {
		const { token } = generate_api_token();
		const body = token.slice(API_TOKEN_PREFIX.length);

		assert.ok(!body.includes('+'), 'should not contain +');
		assert.ok(!body.includes('/'), 'should not contain /');
		assert.ok(!body.includes('='), 'should not contain padding');
	});

	test('id starts with tok_ prefix', () => {
		const { id } = generate_api_token();

		assert.ok(id.startsWith('tok_'));
	});

	test('id is tok_ plus 12 chars', () => {
		const { id } = generate_api_token();

		assert.strictEqual(id.length, 4 + 12);
	});

	test('token_hash is a 64-char hex string', () => {
		const { token_hash } = generate_api_token();

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
		const { token, token_hash } = generate_api_token();

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

describe('is_api_token_shaped', () => {
	test('the token is the prefix plus a 43-char body — 60 chars', () => {
		assert.strictEqual(API_TOKEN_BODY_LENGTH, 43);
		assert.strictEqual(generate_api_token().token.length, 60);
	});

	test('accepts every generated token', () => {
		for (let i = 0; i < 200; i++) {
			const { token } = generate_api_token();
			assert.ok(is_api_token_shaped(token), token);
		}
	});

	test('accepts the test helper tokens', () => {
		assert.ok(is_api_token_shaped(create_test_raw_api_token()));
		assert.ok(is_api_token_shaped(create_test_raw_api_token('a-b_C9')));
		assert.ok(is_api_token_shaped(create_test_raw_api_token('x'.repeat(API_TOKEN_BODY_LENGTH))));
	});

	const valid = create_test_raw_api_token('shape');
	const body = valid.slice(API_TOKEN_PREFIX.length);
	const refused: Array<[string, string]> = [
		['empty', ''],
		['prefix alone', API_TOKEN_PREFIX],
		['body one char short', valid.slice(0, -1)],
		['body one char long', `${valid}A`],
		['no prefix', body],
		['wrong prefix at the right length', `secret_fuz_tokem_${body}`],
		['uppercased prefix', `${API_TOKEN_PREFIX.toUpperCase()}${body}`],
		['padding char', `${valid.slice(0, -1)}=`],
		['standard base64 char', `${valid.slice(0, -1)}+`],
		['slash', `${valid.slice(0, -1)}/`],
		['trailing whitespace', `${valid.slice(0, -1)} `],
		['leading whitespace', ` ${valid.slice(1)}`],
		['a char before a whole token', `x${valid}`],
		['newline', `${valid}\n`],
		['non-ASCII letter', `${valid.slice(0, -1)}é`]
	];
	for (const [name, value] of refused) {
		test(`refuses: ${name}`, () => {
			assert.ok(!is_api_token_shaped(value), JSON.stringify(value));
		});
	}
});

describe('create_test_raw_api_token', () => {
	test('distinct labels give distinct tokens', () => {
		assert.notStrictEqual(create_test_raw_api_token('a'), create_test_raw_api_token('b'));
	});

	test('throws on a label that cannot fit or is not base64url', () => {
		assert.throws(() => create_test_raw_api_token('x'.repeat(API_TOKEN_BODY_LENGTH + 1)));
		assert.throws(() => create_test_raw_api_token('not ok'));
	});
});
