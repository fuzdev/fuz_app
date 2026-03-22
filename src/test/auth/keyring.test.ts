/**
 * Tests for backend_keyring.ts - Opaque key ring for cookie signing.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {create_keyring, validate_keyring, create_validated_keyring} from '$lib/auth/keyring.js';

const TEST_KEY = 'test-secret-key-that-is-at-least-32-chars';
const OTHER_KEY = 'other-secret-key-that-is-different-32ch';

describe('create_keyring', () => {
	const EMPTY_INPUTS = [undefined, '', '____'];

	test.each(EMPTY_INPUTS)('returns null for empty input: %s', (input) => {
		assert.strictEqual(create_keyring(input), null);
	});

	test('returns keyring for valid key', () => {
		const keyring = create_keyring(TEST_KEY);
		assert.ok(keyring);
		assert.ok(keyring.sign);
		assert.ok(keyring.verify);
	});

	test('returns keyring for multiple keys', () => {
		const keyring = create_keyring(`${TEST_KEY}__${OTHER_KEY}`);
		assert.ok(keyring);
	});

	test('filters empty segments from multiple separators', async () => {
		const keyring = create_keyring(`${TEST_KEY}____${OTHER_KEY}`);
		assert.ok(keyring);
		// Verify both keys work
		const signed = await keyring.sign('test');
		const result = await keyring.verify(signed);
		assert.strictEqual(result?.key_index, 0);
	});
});

describe('Keyring.sign', () => {
	test('returns value.signature format', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		const signed = await keyring.sign('hello');
		const parts = signed.split('.');
		assert.strictEqual(parts.length, 2);
		assert.strictEqual(parts[0], 'hello');
	});

	test('signature is valid base64', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		const signed = await keyring.sign('test');
		const signature = signed.split('.')[1]!;
		// atob should not throw for valid base64
		atob(signature);
	});

	test('different values produce different signatures', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		const signed1 = await keyring.sign('value1');
		const signed2 = await keyring.sign('value2');
		assert.notStrictEqual(signed1, signed2);
	});

	test('different keys produce different signatures', async () => {
		const keyring1 = create_keyring(TEST_KEY)!;
		const keyring2 = create_keyring(OTHER_KEY)!;
		const signed1 = await keyring1.sign('same');
		const signed2 = await keyring2.sign('same');
		assert.notStrictEqual(signed1, signed2);
	});

	test('same inputs produce same output (deterministic)', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		const signed1 = await keyring.sign('test');
		const signed2 = await keyring.sign('test');
		assert.strictEqual(signed1, signed2);
	});
});

describe('Keyring.verify', () => {
	describe('valid signatures', () => {
		test('returns value for valid signature', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const signed = await keyring.sign('hello');
			const result = await keyring.verify(signed);
			assert.strictEqual(result?.value, 'hello');
			assert.strictEqual(result?.key_index, 0);
		});

		test('handles empty value', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const signed = await keyring.sign('');
			const result = await keyring.verify(signed);
			assert.strictEqual(result?.value, '');
		});

		const SPECIAL_VALUES = [
			['numeric string', '12345'],
			['value with dots', 'hello.world.test'],
			['value with equals', 'key=value'],
			['unicode', '\u{1F600}emoji'],
			['long value', 'x'.repeat(1000)],
			['special chars', '!@#$%^&*()'],
			['whitespace', '  spaces  '],
			['newlines', 'line1\nline2'],
		] as const;

		test.each(SPECIAL_VALUES)('handles %s: %s', async (_name, value) => {
			const keyring = create_keyring(TEST_KEY)!;
			const signed = await keyring.sign(value);
			const result = await keyring.verify(signed);
			assert.strictEqual(result?.value, value);
		});
	});

	describe('invalid signatures', () => {
		test('returns null for wrong key', async () => {
			const keyring1 = create_keyring(TEST_KEY)!;
			const keyring2 = create_keyring(OTHER_KEY)!;
			const signed = await keyring1.sign('hello');
			const result = await keyring2.verify(signed);
			assert.strictEqual(result, null);
		});

		test('returns null for tampered value', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const signed = await keyring.sign('hello');
			const tampered = 'goodbye' + signed.slice(5);
			const result = await keyring.verify(tampered);
			assert.strictEqual(result, null);
		});

		test('returns null for tampered signature', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const signed = await keyring.sign('hello');
			const tampered = signed.slice(0, -1) + 'X';
			const result = await keyring.verify(tampered);
			assert.strictEqual(result, null);
		});

		test('returns null for missing dot', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const result = await keyring.verify('no-dot-here');
			assert.strictEqual(result, null);
		});

		test('returns null for invalid base64 signature', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const result = await keyring.verify('value.!!!invalid!!!');
			assert.strictEqual(result, null);
		});

		test('returns null for empty signature', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const result = await keyring.verify('value.');
			assert.strictEqual(result, null);
		});

		test('returns null for truncated signature', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const signed = await keyring.sign('hello');
			const truncated = signed.slice(0, signed.indexOf('.') + 5);
			const result = await keyring.verify(truncated);
			assert.strictEqual(result, null);
		});

		test('returns null for value that is just a dot', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const result = await keyring.verify('.');
			assert.strictEqual(result, null);
		});

		test('returns null for only dots', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const result = await keyring.verify('...');
			assert.strictEqual(result, null);
		});

		test('returns null for wrong-length signature (valid base64)', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			// Valid base64 but only 16 bytes instead of 32 for SHA-256
			const short_sig = btoa('x'.repeat(16));
			const result = await keyring.verify(`value.${short_sig}`);
			assert.strictEqual(result, null);
		});

		test('returns null for whitespace-only input', async () => {
			const keyring = create_keyring(TEST_KEY)!;
			const result = await keyring.verify('   ');
			assert.strictEqual(result, null);
		});
	});
});

describe('concurrent access', () => {
	test('concurrent sign calls return consistent results', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		const promises = Array.from({length: 10}, () => keyring.sign('concurrent'));
		const results = await Promise.all(promises);
		// All results should be identical (deterministic + cached key)
		assert.strictEqual(new Set(results).size, 1);
	});

	test('concurrent verify calls all succeed', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		const signed = await keyring.sign('test');
		const promises = Array.from({length: 10}, () => keyring.verify(signed));
		const results = await Promise.all(promises);
		for (const result of results) {
			assert.deepEqual(result, {value: 'test', key_index: 0});
		}
	});

	test('concurrent sign and verify with multiple keys', async () => {
		const keyring = create_keyring(`${TEST_KEY}__${OTHER_KEY}`)!;
		const old_keyring = create_keyring(OTHER_KEY)!;
		const old_signed = await old_keyring.sign('old');

		const promises = [
			keyring.sign('new1'),
			keyring.verify(old_signed),
			keyring.sign('new2'),
			keyring.verify(old_signed),
		];
		const [signed1, verified1, signed2, verified2] = await Promise.all(promises);

		assert.ok(signed1);
		assert.ok(signed2);
		assert.deepEqual(verified1, {value: 'old', key_index: 1});
		assert.deepEqual(verified2, {value: 'old', key_index: 1});
	});
});

describe('key rotation', () => {
	test('returns key_index 0 when verified with first key', async () => {
		const keyring = create_keyring(`${TEST_KEY}__${OTHER_KEY}`)!;
		const signed = await keyring.sign('test');
		const result = await keyring.verify(signed);
		assert.deepEqual(result, {value: 'test', key_index: 0});
	});

	test('returns key_index 1 when signed with old key', async () => {
		const old_keyring = create_keyring(OTHER_KEY)!;
		const signed = await old_keyring.sign('test');

		const new_keyring = create_keyring(`${TEST_KEY}__${OTHER_KEY}`)!;
		const result = await new_keyring.verify(signed);
		assert.deepEqual(result, {value: 'test', key_index: 1});
	});

	test('returns null when no key matches', async () => {
		const keyring1 = create_keyring(TEST_KEY)!;
		const signed = await keyring1.sign('test');

		const keyring2 = create_keyring('completely-different-key-32-chars!')!;
		const result = await keyring2.verify(signed);
		assert.strictEqual(result, null);
	});
});

describe('create_validated_keyring', () => {
	const LONG_KEY = 'a'.repeat(32);

	test('returns ok with keyring for valid key', () => {
		const result = create_validated_keyring(LONG_KEY);
		if (!result.ok) assert.fail('expected ok result');
		assert.ok(result.keyring);
		assert.ok(result.keyring.sign);
		assert.ok(result.keyring.verify);
	});

	test('returns ok with keyring for multiple valid keys', () => {
		const result = create_validated_keyring(`${LONG_KEY}__${'b'.repeat(32)}`);
		assert.isTrue(result.ok);
	});

	test('returns errors for short keys', () => {
		const result = create_validated_keyring('short');
		if (result.ok) assert.fail('expected error result');
		assert.isAbove(result.errors.length, 0);
		assert.ok(result.errors[0]!.includes('too short'));
	});

	test('returns required error for undefined', () => {
		const result = create_validated_keyring(undefined);
		if (result.ok) assert.fail('expected error result');
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.errors[0]!.includes('SECRET_COOKIE_KEYS is required'));
	});

	test('returns required error for empty string', () => {
		const result = create_validated_keyring('');
		if (result.ok) assert.fail('expected error result');
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.errors[0]!.includes('SECRET_COOKIE_KEYS is required'));
	});

	test('keyring from ok result can sign and verify', async () => {
		const result = create_validated_keyring(LONG_KEY);
		if (!result.ok) assert.fail('expected ok result');
		const signed = await result.keyring.sign('test-value');
		const verified = await result.keyring.verify(signed);
		assert.strictEqual(verified?.value, 'test-value');
	});
});

describe('validate_keyring', () => {
	const LONG_KEY = 'a'.repeat(32);

	test('returns empty array for valid key', () => {
		assert.deepEqual(validate_keyring(LONG_KEY), []);
	});

	test('returns empty array for multiple valid keys', () => {
		assert.deepEqual(validate_keyring(`${LONG_KEY}__${'b'.repeat(32)}`), []);
	});

	test('returns empty array for undefined', () => {
		assert.deepEqual(validate_keyring(undefined), []);
	});

	test('returns error for key shorter than 32 chars', () => {
		const errors = validate_keyring('short');
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0]!.includes('too short'));
		assert.ok(errors[0]!.includes('5 chars'));
		assert.ok(errors[0]!.includes('min 32'));
	});

	test('returns error for each short key', () => {
		const errors = validate_keyring(`short1__short2__${LONG_KEY}`);
		assert.strictEqual(errors.length, 2);
		assert.ok(errors[0]!.includes('Key 1'));
		assert.ok(errors[1]!.includes('Key 2'));
	});

	test('error message includes key position (1-indexed)', () => {
		const errors = validate_keyring(`${LONG_KEY}__short`);
		assert.ok(errors[0]!.includes('Key 2'));
	});
});
