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
	parse_session,
	process_session_cookie,
	SESSION_AGE_MAX,
	type SessionOptions
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

	test('key rotation triggers refresh with new signed value', async () => {
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
		assert.strictEqual(result.action, 'refresh');
		assert.strictEqual(result.identity, TEST_IDENTITY);
		assert.ok(result.new_signed_value);

		// The refreshed value should verify with the primary key
		const verify_result = await rotated_keyring.verify(result.new_signed_value);
		assert.ok(verify_result);
		assert.strictEqual(verify_result.key_index, 0);
	});

	test('refreshed cookie is signed with new key', async () => {
		const old_keyring = create_keyring(OLD_KEY)!;
		const signed = await create_session_cookie_value(
			old_keyring,
			TEST_IDENTITY,
			test_session_options
		);
		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await process_session_cookie(signed, rotated_keyring, test_session_options);

		// Verify the new cookie works with just the new key
		const new_keyring = create_test_keyring();
		const verified = await process_session_cookie(
			result.new_signed_value,
			new_keyring,
			test_session_options
		);
		assert.strictEqual(verified.identity, TEST_IDENTITY);
		assert.strictEqual(verified.action, 'none');
	});

	test('refreshed cookie gets fresh expiration', async () => {
		const original_time = 1000000;
		const refresh_time = original_time + 1000;

		const old_keyring = create_keyring(OLD_KEY)!;
		const signed = await create_session_cookie_value(
			old_keyring,
			TEST_IDENTITY,
			test_session_options,
			original_time
		);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await process_session_cookie(
			signed,
			rotated_keyring,
			test_session_options,
			refresh_time
		);
		assert.strictEqual(result.action, 'refresh');

		// The new cookie should be valid for SESSION_AGE_MAX from refresh_time
		const original_expiry = original_time + SESSION_AGE_MAX;
		const new_keyring = create_test_keyring();
		const verified = await process_session_cookie(
			result.new_signed_value,
			new_keyring,
			test_session_options,
			original_expiry
		);
		assert.strictEqual(verified.identity, TEST_IDENTITY);
	});

	test('refreshes cookie within default threshold and extends expiration', async () => {
		// Mirrors `query_session_touch` for the cookie layer: a still-valid
		// cookie within `SESSION_REFRESH_THRESHOLD_S` of expiry returns
		// `action: 'refresh'` with a freshly-signed value carrying
		// `now + SESSION_AGE_MAX` as the new `expires_at`.
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);

		// Parse at expires_at - 1 hour: within the 1-day default window.
		const within = now + SESSION_AGE_MAX - 60 * 60;
		const result = await process_session_cookie(signed, keyring, test_session_options, within);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.action, 'refresh');
		assert.strictEqual(result.identity, TEST_IDENTITY);
		assert.ok(result.new_signed_value);

		// New cookie's embedded expiration is `within + SESSION_AGE_MAX`.
		const verify = await keyring.verify(result.new_signed_value);
		assert.ok(verify);
		assert.ok(
			verify.value.endsWith(`:${within + SESSION_AGE_MAX}`),
			`expected refreshed expires_at = ${within + SESSION_AGE_MAX}, got ${verify.value}`
		);
	});

	test('does not refresh cookie far from expiry', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);
		const result = await process_session_cookie(signed, keyring, test_session_options, now + 10);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.action, 'none');
		assert.strictEqual(result.identity, TEST_IDENTITY);
	});

	test('refresh_threshold_seconds = 0 disables expiration-based refresh', async () => {
		const opts: SessionOptions<string> = { ...test_session_options, refresh_threshold_seconds: 0 };
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, opts, now);
		// 1 second before expiry — without the threshold, no refresh.
		const result = await process_session_cookie(signed, keyring, opts, now + SESSION_AGE_MAX - 1);
		assert.strictEqual(result.action, 'none');
	});

	test('respects custom refresh_threshold_seconds', async () => {
		const opts: SessionOptions<string> = { ...test_session_options, refresh_threshold_seconds: 60 };
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, opts, now);

		const outside = await process_session_cookie(
			signed,
			keyring,
			opts,
			now + SESSION_AGE_MAX - 100
		);
		assert.strictEqual(outside.action, 'none');

		const inside = await process_session_cookie(signed, keyring, opts, now + SESSION_AGE_MAX - 30);
		assert.strictEqual(inside.action, 'refresh');
	});

	test('expiration-based refresh combines with key-rotation refresh', async () => {
		// Both signals true — single refresh, identity preserved, new cookie
		// signed with the primary key.
		const old_keyring = create_keyring(OLD_KEY)!;
		const now = 1000;
		const signed = await create_session_cookie_value(
			old_keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const within = now + SESSION_AGE_MAX - 60 * 60;
		const result = await process_session_cookie(
			signed,
			rotated_keyring,
			test_session_options,
			within
		);
		assert.strictEqual(result.action, 'refresh');
		assert.strictEqual(result.identity, TEST_IDENTITY);
		assert.ok(result.new_signed_value);

		const verify = await rotated_keyring.verify(result.new_signed_value);
		assert.ok(verify);
		assert.strictEqual(verify.key_index, 0);
	});

	test('refresh round-trips identity with colons in payload', async () => {
		// Composition test: encoded identities containing the value
		// separator must survive the refresh re-encoding intact. The
		// original colons-in-identity test only exercises the parse path;
		// this catches any regression where the refresh path's
		// `create_session_cookie_value` call mishandles a non-trivial
		// `encode_identity`.
		const colon_config: SessionOptions<string> = {
			cookie_name: 'test_session',
			context_key: 'auth_session_id',
			encode_identity: (id) => `prefix:${id}`,
			decode_identity: (payload) => {
				const idx = payload.indexOf(':');
				return idx !== -1 ? payload.slice(idx + 1) || null : null;
			}
		};
		const old_keyring = create_keyring(OLD_KEY)!;
		const now = 1000;
		const signed = await create_session_cookie_value(old_keyring, 'sess-abc', colon_config, now);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await process_session_cookie(signed, rotated_keyring, colon_config, now + 1);
		assert.strictEqual(result.action, 'refresh');
		assert.strictEqual(result.identity, 'sess-abc');
		assert.ok(result.new_signed_value);

		const reparsed = await parse_session(
			result.new_signed_value,
			rotated_keyring,
			colon_config,
			now + 2
		);
		assert.ok(reparsed);
		assert.strictEqual(reparsed.identity, 'sess-abc');
	});
});
