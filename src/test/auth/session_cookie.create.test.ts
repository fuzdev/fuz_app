/**
 * Tests for `create_session_cookie_value` + module-level constants
 * (`SESSION_AGE_MAX`, `session_cookie_options`).
 *
 * Sibling files cover `parse_session` + round-trip
 * (`session_cookie.parse.test.ts`) and `process_session_cookie`
 * (`session_cookie.process.test.ts`).
 *
 * @module
 */

import {assert, describe, test} from 'vitest';

import {
	create_session_cookie_value,
	SESSION_AGE_MAX,
	session_cookie_options,
	type SessionOptions,
} from '$lib/auth/session_cookie.ts';
import {create_test_keyring, TEST_IDENTITY, test_session_options} from './session_test_helpers.ts';

describe('session constants', () => {
	test('SESSION_AGE_MAX is 30 days in seconds', () => {
		const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
		assert.strictEqual(SESSION_AGE_MAX, THIRTY_DAYS_SECONDS);
	});

	test('SESSION_AGE_MAX matches AUTH_SESSION_LIFETIME_MS exactly', async () => {
		// Strict equality: the cookie's signed-value lifetime and the DB
		// session's `expires_at` are paired by `query_session_touch`'s
		// extension model. If they drift, either DB sessions outlive cookies
		// (active user logged out while session is alive) or cookies outlive
		// DB sessions (cookie validates against a missing session row).
		const {AUTH_SESSION_LIFETIME_MS} = await import('$lib/auth/session_queries.ts');
		const db_lifetime_seconds = AUTH_SESSION_LIFETIME_MS / 1000;
		assert.strictEqual(
			SESSION_AGE_MAX,
			db_lifetime_seconds,
			`cookie SESSION_AGE_MAX (${
				SESSION_AGE_MAX
			}s) must equal DB AUTH_SESSION_LIFETIME_MS / 1000 (${db_lifetime_seconds}s)`,
		);
	});
});

describe('session_cookie_options', () => {
	test('has strict security settings', () => {
		assert.deepEqual(session_cookie_options, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: SESSION_AGE_MAX,
		});
	});
});

describe('create_session_cookie_value', () => {
	test('produces a signed string with dot separator', async () => {
		const keyring = create_test_keyring();
		const value = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			1000,
		);
		assert.ok(value.includes('.'));
	});

	test('embeds expiration in the signed value', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		const result = await keyring.verify(signed);
		assert.ok(result);
		assert.ok(result.value.includes(`${now + SESSION_AGE_MAX}`));
	});

	test('embeds identity in the signed value', async () => {
		const keyring = create_test_keyring();
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			1000,
		);
		const result = await keyring.verify(signed);
		assert.ok(result);
		assert.ok(result.value.startsWith(`${TEST_IDENTITY}:`));
	});

	test('different identities produce different values', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const value1 = await create_session_cookie_value(keyring, 'user-1', test_session_options, now);
		const value2 = await create_session_cookie_value(keyring, 'user-2', test_session_options, now);
		assert.notStrictEqual(value1, value2);
	});

	test('same inputs produce same output (deterministic)', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const value1 = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		const value2 = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		assert.strictEqual(value1, value2);
	});

	test('honors options.max_age override', async () => {
		// `SessionOptions.max_age` overrides the default `SESSION_AGE_MAX`.
		// Pin it: a 60s max_age must produce `expires_at = now + 60`.
		const keyring = create_test_keyring();
		const custom_options: SessionOptions<string> = {
			...test_session_options,
			max_age: 60,
		};
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, custom_options, now);
		const result = await keyring.verify(signed);
		assert.ok(result);
		assert.ok(
			result.value.endsWith(`:${now + 60}`),
			`expected expires_at = ${now + 60}, got value: ${result.value}`,
		);
	});
});
