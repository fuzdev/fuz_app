/**
 * Tests for backend_session.ts - Generic session management.
 *
 * Uses a simple string identity config to test core session primitives.
 * App-specific session configs (tx_session_options, visiones_session_options)
 * are tested in their respective projects.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_keyring} from '$lib/auth/keyring.js';
import {
	parse_session,
	create_session_cookie_value,
	process_session_cookie,
	SESSION_COOKIE_OPTIONS,
	SESSION_AGE_MAX,
	type SessionOptions,
} from '$lib/auth/session_cookie.js';

const TEST_KEY = 'a'.repeat(32);
const OLD_KEY = 'b'.repeat(32);
const TEST_IDENTITY = 'user-123';

const create_test_keyring = () => create_keyring(TEST_KEY)!;

const test_session_options: SessionOptions<string> = {
	cookie_name: 'test_session',
	context_key: 'auth_session_id',
	encode_identity: (id) => id,
	decode_identity: (payload) => payload || null,
};

describe('session constants', () => {
	test('SESSION_AGE_MAX is 30 days in seconds', () => {
		const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
		assert.strictEqual(SESSION_AGE_MAX, THIRTY_DAYS_SECONDS);
	});

	test('SESSION_AGE_MAX does not exceed AUTH_SESSION_LIFETIME_MS', async () => {
		const {AUTH_SESSION_LIFETIME_MS} = await import('$lib/auth/session_queries.js');
		const db_lifetime_seconds = AUTH_SESSION_LIFETIME_MS / 1000;
		assert.ok(
			SESSION_AGE_MAX <= db_lifetime_seconds,
			`Cookie max-age (${SESSION_AGE_MAX}s) must not exceed DB session lifetime (${db_lifetime_seconds}s)`,
		);
	});
});

describe('SESSION_COOKIE_OPTIONS', () => {
	test('has strict security settings', () => {
		assert.deepEqual(SESSION_COOKIE_OPTIONS, {
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
});

describe('parse_session', () => {
	test('returns undefined for undefined input', async () => {
		const keyring = create_test_keyring();
		const result = await parse_session(undefined, keyring, test_session_options);
		assert.strictEqual(result, undefined);
	});

	test('returns undefined for empty string', async () => {
		const keyring = create_test_keyring();
		const result = await parse_session('', keyring, test_session_options);
		assert.strictEqual(result, undefined);
	});

	test('returns null for invalid signature', async () => {
		const keyring = create_test_keyring();
		const result = await parse_session(
			'user-123:99999999999.invalidsig',
			keyring,
			test_session_options,
		);
		assert.strictEqual(result, null);
	});

	test('parses valid session', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		const result = await parse_session(signed, keyring, test_session_options, now + 1);
		assert.ok(result);
		assert.strictEqual(result.identity, TEST_IDENTITY);
		assert.strictEqual(result.should_refresh_signature, false);
		assert.strictEqual(result.key_index, 0);
	});

	test('returns null for expired session', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		const result = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX + 1,
		);
		assert.strictEqual(result, null);
	});

	test('returns null at exact expiration time', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		const result = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX,
		);
		assert.strictEqual(result, null);
	});

	test('valid just before expiration', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		const result = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX - 1,
		);
		assert.ok(result);
		assert.strictEqual(result.identity, TEST_IDENTITY);
	});

	test('key rotation sets should_refresh_signature', async () => {
		const old_keyring = create_keyring(OLD_KEY)!;
		const now = 1000;
		const signed = await create_session_cookie_value(
			old_keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await parse_session(signed, rotated_keyring, test_session_options, now + 1);
		assert.ok(result);
		assert.strictEqual(result.identity, TEST_IDENTITY);
		assert.strictEqual(result.should_refresh_signature, true);
		assert.strictEqual(result.key_index, 1);
	});

	test('returns null when no key can verify', async () => {
		const other_keyring = create_keyring('completely-different-key-32-chars!')!;
		const now = 1000;
		const signed = await create_session_cookie_value(
			other_keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		const result = await parse_session(signed, create_test_keyring(), test_session_options, now);
		assert.strictEqual(result, null);
	});

	test('returns null when signed payload has no separator', async () => {
		const keyring = create_test_keyring();
		// sign a raw string with no colon separator
		const signed = await keyring.sign('noseparator');
		const result = await parse_session(signed, keyring, test_session_options);
		assert.strictEqual(result, null);
	});

	test('returns null when decode_identity returns null', async () => {
		const keyring = create_test_keyring();
		const rejecting_config: SessionOptions<string> = {
			cookie_name: 'test_session',
			context_key: 'auth_session_id',
			encode_identity: (id) => id,
			decode_identity: () => null, // always rejects
		};
		const now = 1000;
		// create a valid signed cookie with the standard config
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now,
		);
		// parse with the rejecting config
		const result = await parse_session(signed, keyring, rejecting_config, now + 1);
		assert.strictEqual(result, null);
	});

	test('returns null when expires_at portion is not a number', async () => {
		const keyring = create_test_keyring();
		const signed = await keyring.sign('user-123:notanumber');
		const result = await parse_session(signed, keyring, test_session_options);
		assert.strictEqual(result, null);
	});

	test('handles identity payload containing colons (lastIndexOf split)', async () => {
		const keyring = create_test_keyring();
		const colon_config: SessionOptions<string> = {
			cookie_name: 'test_session',
			context_key: 'auth_session_id',
			encode_identity: (id) => `prefix:${id}`,
			decode_identity: (payload) => {
				const idx = payload.indexOf(':');
				return idx !== -1 ? payload.slice(idx + 1) || null : null;
			},
		};
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, 'sess-abc', colon_config, now);
		const result = await parse_session(signed, keyring, colon_config, now + 1);
		assert.ok(result);
		assert.strictEqual(result.identity, 'sess-abc');
	});
});

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
			now,
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
			now,
		);
		const result = await process_session_cookie(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX + 1,
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
			1000,
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
			now,
		);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await process_session_cookie(
			signed,
			rotated_keyring,
			test_session_options,
			now + 1,
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
			test_session_options,
		);
		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await process_session_cookie(signed, rotated_keyring, test_session_options);

		// Verify the new cookie works with just the new key
		const new_keyring = create_test_keyring();
		const verified = await process_session_cookie(
			result.new_signed_value,
			new_keyring,
			test_session_options,
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
			original_time,
		);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await process_session_cookie(
			signed,
			rotated_keyring,
			test_session_options,
			refresh_time,
		);
		assert.strictEqual(result.action, 'refresh');

		// The new cookie should be valid for SESSION_AGE_MAX from refresh_time
		const original_expiry = original_time + SESSION_AGE_MAX;
		const new_keyring = create_test_keyring();
		const verified = await process_session_cookie(
			result.new_signed_value,
			new_keyring,
			test_session_options,
			original_expiry,
		);
		assert.strictEqual(verified.identity, TEST_IDENTITY);
	});
});

describe('session round-trip', () => {
	const IDENTITIES = ['user-1', 'admin-42', 'service-account', 'a'.repeat(100)];
	const NOW = 1000000;

	for (const identity of IDENTITIES) {
		test(`round-trips identity: ${identity.slice(0, 30)}`, async () => {
			const keyring = create_test_keyring();
			const signed = await create_session_cookie_value(
				keyring,
				identity,
				test_session_options,
				NOW,
			);
			const result = await parse_session(signed, keyring, test_session_options, NOW);
			assert.ok(result);
			assert.strictEqual(result.identity, identity);
		});
	}

	test('round-trips identity containing null byte', async () => {
		const keyring = create_test_keyring();
		const identity = 'user\x00injected';
		const signed = await create_session_cookie_value(keyring, identity, test_session_options, NOW);
		const result = await parse_session(signed, keyring, test_session_options, NOW);
		assert.ok(result);
		assert.strictEqual(result.identity, identity);
	});

	test('round-trips very long identity (>4KB)', async () => {
		const keyring = create_test_keyring();
		const identity = 'x'.repeat(5000);
		const signed = await create_session_cookie_value(keyring, identity, test_session_options, NOW);
		const result = await parse_session(signed, keyring, test_session_options, NOW);
		assert.ok(result);
		assert.strictEqual(result.identity, identity);
	});

	test('round-trips identity with HTTP-sensitive characters', async () => {
		const keyring = create_test_keyring();
		const test_identities = [
			'user;with;semicolons',
			'user=with=equals',
			'user with spaces',
			'user\twith\ttabs',
		];
		for (const identity of test_identities) {
			const signed = await create_session_cookie_value(
				keyring,
				identity,
				test_session_options,
				NOW,
			);
			const result = await parse_session(signed, keyring, test_session_options, NOW);
			assert.ok(result, `should parse identity: ${JSON.stringify(identity)}`);
			assert.strictEqual(
				result.identity,
				identity,
				`identity mismatch for ${JSON.stringify(identity)}`,
			);
		}
	});
});
