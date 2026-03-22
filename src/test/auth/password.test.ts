/**
 * Tests for backend_password.ts - Argon2id password hashing.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {hash_password, verify_password, verify_dummy} from '$lib/auth/password_argon2.js';
import {PASSWORD_LENGTH_MIN, PASSWORD_LENGTH_MAX} from '$lib/auth/password.js';

describe('hash_password', () => {
	test('returns an Argon2id hash string', async () => {
		const hashed = await hash_password('test_password_123');
		assert.ok(hashed.startsWith('$argon2id$'));
	});

	test('produces different hashes for the same password', async () => {
		const hash1 = await hash_password('test_password_123');
		const hash2 = await hash_password('test_password_123');
		assert.notStrictEqual(hash1, hash2);
	});

	test('produces different hashes for different passwords', async () => {
		const hash1 = await hash_password('password_one_12');
		const hash2 = await hash_password('password_two_12');
		assert.notStrictEqual(hash1, hash2);
	});
});

describe('verify_password', () => {
	test('returns true for matching password', async () => {
		const hashed = await hash_password('correct_password');
		assert.strictEqual(await verify_password('correct_password', hashed), true);
	});

	test('returns false for wrong password', async () => {
		const hashed = await hash_password('correct_password');
		assert.strictEqual(await verify_password('wrong_password_!', hashed), false);
	});

	test('returns false for invalid hash', async () => {
		assert.strictEqual(await verify_password('any_password_!!', 'not-a-valid-hash'), false);
	});

	test('returns false for empty hash', async () => {
		assert.strictEqual(await verify_password('any_password_!!', ''), false);
	});
});

describe('verify_dummy', () => {
	test('always returns false', async () => {
		assert.strictEqual(await verify_dummy('any_password_!!'), false);
	});

	test('always returns false on repeated calls', async () => {
		assert.strictEqual(await verify_dummy('another_password'), false);
		assert.strictEqual(await verify_dummy('yet_another_pass'), false);
	});

	test('takes measurable time (not a no-op)', async () => {
		// verify_dummy must do real Argon2 work for timing attack resistance
		const start = performance.now();
		await verify_dummy('timing_test_password');
		const elapsed = performance.now() - start;
		assert.ok(
			elapsed > 1,
			`verify_dummy completed in ${elapsed.toFixed(1)}ms — should take >1ms for Argon2`,
		);
	});
});

describe('PASSWORD_LENGTH_MIN', () => {
	test('is 12 per OWASP recommendation', () => {
		assert.strictEqual(PASSWORD_LENGTH_MIN, 12);
	});
});

describe('PASSWORD_LENGTH_MAX', () => {
	test('is 300 to cap hashing cost against DoS', () => {
		assert.strictEqual(PASSWORD_LENGTH_MAX, 300);
	});
});
