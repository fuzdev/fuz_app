/**
 * Tests for `process_session_cookie`.
 *
 * Sibling files cover `create_session_cookie_value` + constants
 * (`session_cookie.create.test.ts`) and `parse_session` + round-trip
 * (`session_cookie.parse.test.ts`).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { create_keyring } from '$lib/auth/keyring.ts';
import {
	create_session_cookie_value,
	process_session_cookie,
	SESSION_AGE_MAX
} from '$lib/auth/session_cookie.ts';
import {
	create_test_keyring,
	OLD_KEY,
	TEST_IDENTITY,
	TEST_KEY,
	test_session_options
} from './session_test_helpers.ts';

describe('process_session_cookie', () => {
	test('no cookie returns valid=false, action=none', async () => {
		const keyring = create_test_keyring();
		const result = await process_session_cookie(undefined, keyring, test_session_options);
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.action, 'none');
		assert.strictEqual(result.identity, undefined);
	});

	test('empty string returns valid=false, action=none', async () => {
		const keyring = create_test_keyring();
		const result = await process_session_cookie('', keyring, test_session_options);
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.action, 'none');
	});

	test('valid cookie returns valid=true, action=none with identity', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);
		const result = await process_session_cookie(signed, keyring, test_session_options, now + 1);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.action, 'none');
		assert.strictEqual(result.identity, TEST_IDENTITY);
	});

	test('expired cookie returns valid=false, action=clear', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);
		const result = await process_session_cookie(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX + 1
		);
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.action, 'clear');
	});

	test('invalid signature returns valid=false, action=clear', async () => {
		const keyring = create_test_keyring();
		const result = await process_session_cookie(
			'garbage.data',
			keyring,
			test_session_options,
			1000
		);
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.action, 'clear');
	});

	test('a rotated-key cookie stays valid but is never re-signed', async () => {
		// The hard-cap invariant: any re-sign computes `now + max_age`, which
		// would extend the cookie past the DB row's fixed `expires_at` — so
		// key rotation no longer refreshes. The old-key cookie keeps verifying
		// until the retired key leaves the keyring (safe after
		// `SESSION_AGE_MAX`, when every cookie it signed has expired).
		const old_keyring = create_keyring(OLD_KEY)!;
		const now = 1000;
		const signed = await create_session_cookie_value(
			old_keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await process_session_cookie(
			signed,
			rotated_keyring,
			test_session_options,
			now + 1
		);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.action, 'none');
		assert.strictEqual(result.identity, TEST_IDENTITY);
	});

	test('a near-expiry cookie is never refreshed — the lifetime is absolute', async () => {
		// The other deleted branch: an impending-expiry re-sign was the cookie
		// half of the sliding renewal (`query_session_touch`), which let a
		// leaked cookie live forever at one request per ~29 days. Both halves
		// died together; a cookie one second from expiry is still just valid.
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);
		const result = await process_session_cookie(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX - 1
		);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.action, 'none');
		assert.strictEqual(result.identity, TEST_IDENTITY);
	});

	test('the embedded expiry is immutable across processing', async () => {
		// Processing a cookie N times never changes what the keyring verifies —
		// there is no path that produces a new signed value.
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);
		for (const at of [now + 1, now + SESSION_AGE_MAX - 60, now + SESSION_AGE_MAX - 1]) {
			const result = await process_session_cookie(signed, keyring, test_session_options, at);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.action, 'none');
		}
		const verify = await keyring.verify(signed);
		assert.ok(verify);
		assert.ok(verify.value.endsWith(`:${now + SESSION_AGE_MAX}`));
	});
});
