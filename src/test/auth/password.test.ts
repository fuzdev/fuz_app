/**
 * Tests for backend_password.ts - Argon2id password hashing.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { hash_password, verify_password, verify_dummy } from '$lib/auth/password_argon2.ts';
import {
	PASSWORD_LENGTH_MIN,
	PASSWORD_LENGTH_MAX,
	Password,
	PasswordProvided
} from '$lib/auth/password.ts';

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
			`verify_dummy completed in ${elapsed.toFixed(1)}ms — should take >1ms for Argon2`
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

describe('Password schema', () => {
	test('accepts valid password at minimum length', () => {
		const result = Password.safeParse('a'.repeat(PASSWORD_LENGTH_MIN));
		assert.ok(result.success);
	});

	test('accepts valid password at maximum length', () => {
		const result = Password.safeParse('a'.repeat(PASSWORD_LENGTH_MAX));
		assert.ok(result.success);
	});

	test('rejects password below minimum length', () => {
		const result = Password.safeParse('a'.repeat(PASSWORD_LENGTH_MIN - 1));
		assert.strictEqual(result.success, false);
	});

	test('rejects password above maximum length', () => {
		const result = Password.safeParse('a'.repeat(PASSWORD_LENGTH_MAX + 1));
		assert.strictEqual(result.success, false);
	});

	test('rejects empty string', () => {
		const result = Password.safeParse('');
		assert.strictEqual(result.success, false);
	});
});

describe('PasswordProvided schema', () => {
	test('accepts single character (minimal validation for login)', () => {
		const result = PasswordProvided.safeParse('a');
		assert.ok(result.success);
	});

	test('accepts password at maximum length', () => {
		const result = PasswordProvided.safeParse('a'.repeat(PASSWORD_LENGTH_MAX));
		assert.ok(result.success);
	});

	test('rejects empty string', () => {
		const result = PasswordProvided.safeParse('');
		assert.strictEqual(result.success, false);
	});

	test('rejects password above maximum length', () => {
		const result = PasswordProvided.safeParse('a'.repeat(PASSWORD_LENGTH_MAX + 1));
		assert.strictEqual(result.success, false);
	});
});
