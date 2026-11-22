/**
 * Tests for `parse_session_from_cookies` — its three answers, the cookie's
 * verification, and the create→parse round-trip.
 *
 * The sibling `session_cookie.create.test.ts` covers
 * `create_session_cookie_value`, `sign_session_cookie` and the `Set-Cookie`
 * formatters.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import type { Keyring } from '#lib/auth/keyring.ts';

import {
	create_session_cookie_value,
	parse_session_from_cookies,
	SESSION_AGE_MAX,
	type SessionCookieRead
} from '#lib/auth/session_cookie.ts';
import {
	create_test_keyring,
	OLD_KEY,
	TEST_COOKIE_NAME,
	TEST_IDENTITY,
	TEST_KEY
} from './session_test_helpers.ts';

/** Read `value` as the session cookie of one `Cookie` line, or no line for `null`. */
const read = (
	value: string | null,
	keyring: Keyring,
	now_seconds?: number
): Promise<SessionCookieRead> =>
	parse_session_from_cookies(
		value === null ? [] : [`${TEST_COOKIE_NAME}=${value}`],
		keyring,
		TEST_COOKIE_NAME,
		now_seconds
	);

/** The verified cookie of a `valid` read, failing the test on any other. */
const valid_cookie = (result: SessionCookieRead) => {
	assert.strictEqual(result.kind, 'valid');
	if (result.kind !== 'valid') throw new Error('unreachable');
	return result.cookie;
};

describe('parse_session_from_cookies — the three answers', () => {
	test('absent: no Cookie line, or no pair naming the cookie', async () => {
		const keyring = create_test_keyring();
		assert.deepStrictEqual(await read(null, keyring), { kind: 'absent' });
		const other = await parse_session_from_cookies(
			['other_cookie=value', 'another=1'],
			keyring,
			TEST_COOKIE_NAME
		);
		assert.deepStrictEqual(other, { kind: 'absent' });
	});

	test('invalid: a pair naming the cookie whose value fails verification', async () => {
		const keyring = create_test_keyring();
		// an empty value is a cookie sent with none: present, not absent
		assert.deepStrictEqual(await read('', keyring), { kind: 'invalid' });
		assert.deepStrictEqual(await read('user-123:99999999999.invalidsig', keyring), {
			kind: 'invalid'
		});
	});

	test('valid: the token and the signed expiry', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		assert.deepStrictEqual(await read(signed, keyring, now + 1), {
			kind: 'valid',
			cookie: { token: TEST_IDENTITY, expires_at: now + SESSION_AGE_MAX }
		});
	});

	test('reads the first pair naming the cookie, among other cookies', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		const result = await parse_session_from_cookies(
			[`theme=dark; ${TEST_COOKIE_NAME}=${signed}; ${TEST_COOKIE_NAME}=garbage`],
			keyring,
			TEST_COOKIE_NAME,
			now + 1
		);
		assert.strictEqual(valid_cookie(result).token, TEST_IDENTITY);
	});
});

describe('parse_session_from_cookies — verification', () => {
	test('invalid past the signed expiry, and at it', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		assert.strictEqual((await read(signed, keyring, now + SESSION_AGE_MAX + 1)).kind, 'invalid');
		assert.strictEqual((await read(signed, keyring, now + SESSION_AGE_MAX)).kind, 'invalid');
	});

	test('valid just before the signed expiry', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		const cookie = valid_cookie(await read(signed, keyring, now + SESSION_AGE_MAX - 1));
		assert.strictEqual(cookie.token, TEST_IDENTITY);
	});

	test('a retired key keeps verifying its cookies until it leaves the keyring', async () => {
		const now = 1000;
		const signed = await create_session_cookie_value(
			create_test_keyring(OLD_KEY),
			TEST_IDENTITY,
			now
		);
		const rotated_keyring = create_test_keyring(TEST_KEY + '__' + OLD_KEY);
		assert.strictEqual(
			valid_cookie(await read(signed, rotated_keyring, now + 1)).token,
			TEST_IDENTITY
		);
		assert.strictEqual((await read(signed, create_test_keyring(), now + 1)).kind, 'invalid');
	});

	test('invalid when no key can verify', async () => {
		const other_keyring = create_test_keyring('completely-different-key-32-chars!');
		const now = 1000;
		const signed = await create_session_cookie_value(other_keyring, TEST_IDENTITY, now);
		assert.strictEqual((await read(signed, create_test_keyring(), now)).kind, 'invalid');
	});

	test('invalid when the signed payload has no separator', async () => {
		const keyring = create_test_keyring();
		const signed = await keyring.sign('noseparator');
		assert.strictEqual((await read(signed, keyring)).kind, 'invalid');
	});

	test('invalid when the token is empty', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await keyring.sign(`:${now + SESSION_AGE_MAX}`);
		assert.strictEqual((await read(signed, keyring, now)).kind, 'invalid');
	});

	test('a token holding a colon splits at the last one', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, 'prefix:sess-abc', now);
		assert.strictEqual(valid_cookie(await read(signed, keyring, now + 1)).token, 'prefix:sess-abc');
	});

	test.each([
		['not a number', 'notanumber'],
		['negative', '-100'],
		['leading whitespace', ' 123'],
		['trailing whitespace', '123 '],
		['plus sign', '+123'],
		['decimal point', '123.5'],
		['scientific notation', '1e10'],
		['hex prefix', '0x10'],
		['trailing alpha', '123abc'],
		['empty', '']
	])('invalid for a malformed expires_at: %s (%j)', async (_label, expires_at_str) => {
		// Strict integer regex closes the `parseInt` permissiveness gap —
		// `parseInt('123abc')` returns `123`, so without the regex a tampered
		// cookie with garbage trailing chars would parse as a valid future
		// expiration. HMAC integrity makes the threat theoretical, but
		// defense-in-depth pins the contract.
		const keyring = create_test_keyring();
		const signed = await keyring.sign(`${TEST_IDENTITY}:${expires_at_str}`);
		assert.strictEqual((await read(signed, keyring, 1000)).kind, 'invalid');
	});

	test('invalid for an all-digit expires_at beyond u64::MAX', async () => {
		// the Rust spine parses `expires_at` as `u64`, so one past its max is refused
		// there; `parseInt` alone would read it as a finite far-future float
		const keyring = create_test_keyring();
		const signed = await keyring.sign(`${TEST_IDENTITY}:18446744073709551616`);
		assert.strictEqual((await read(signed, keyring, 1000)).kind, 'invalid');
	});

	test('valid for expires_at at exactly u64::MAX', async () => {
		const keyring = create_test_keyring();
		const signed = await keyring.sign(`${TEST_IDENTITY}:18446744073709551615`);
		assert.strictEqual(valid_cookie(await read(signed, keyring, 1000)).token, TEST_IDENTITY);
	});

	test('leading zeros past twenty digits pass when the value fits u64', async () => {
		// `u64::from_str` takes leading zeros, so the bound is on the value, not the length
		const keyring = create_test_keyring();
		const signed = await keyring.sign(`${TEST_IDENTITY}:000000000000000000000002000`);
		assert.strictEqual(valid_cookie(await read(signed, keyring, 1000)).expires_at, 2000);
	});
});

describe('parse_session_from_cookies — absolute lifetime', () => {
	test('a cookie reads identically at any age, and its expiry never moves', async () => {
		// No refresh exists: a re-sign would compute a fresh `now +
		// SESSION_AGE_MAX`, extending the cookie past the DB row's fixed
		// `expires_at`. The signed expiry is set once at mint — one second
		// before it the cookie is just valid, at it, invalid.
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		for (const at of [now + 1, now + SESSION_AGE_MAX - 60, now + SESSION_AGE_MAX - 1]) {
			assert.deepStrictEqual(await read(signed, keyring, at), {
				kind: 'valid',
				cookie: { token: TEST_IDENTITY, expires_at: now + SESSION_AGE_MAX }
			});
		}
		assert.strictEqual((await read(signed, keyring, now + SESSION_AGE_MAX)).kind, 'invalid');
		const verified = await keyring.verify(signed);
		assert.ok(verified);
		assert.ok(verified.value.endsWith(`:${now + SESSION_AGE_MAX}`));
	});
});

describe('session cookie round-trip', () => {
	const TOKENS = ['user-1', 'admin-42', 'service-account', 'a'.repeat(100), 'x'.repeat(5000)];
	const NOW = 1000000;

	for (const token of TOKENS) {
		test(`round-trips token: ${token.slice(0, 30)}`, async () => {
			const keyring = create_test_keyring();
			const signed = await create_session_cookie_value(keyring, token, NOW);
			assert.strictEqual(valid_cookie(await read(signed, keyring, NOW)).token, token);
		});
	}
});
