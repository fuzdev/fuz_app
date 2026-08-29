/**
 * Tests for `parse_session` + the create→parse round-trip.
 *
 * Sibling files cover `create_session_cookie_value` + constants
 * (`session_cookie.create.test.ts`) and `process_session_cookie`
 * (`session_cookie.process.test.ts`).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { create_keyring } from '$lib/auth/keyring.ts';
import {
	create_session_cookie_value,
	parse_session,
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
			test_session_options
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
			now
		);
		const result = await parse_session(signed, keyring, test_session_options, now + 1);
		assert.ok(result);
		assert.strictEqual(result.identity, TEST_IDENTITY);
		assert.strictEqual(result.key_index, 0);
	});

	test('returns null for expired session', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);
		const result = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX + 1
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
			now
		);
		const result = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX
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
			now
		);
		const result = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX - 1
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
			now
		);

		const rotated_keyring = create_keyring(TEST_KEY + '__' + OLD_KEY)!;
		const result = await parse_session(signed, rotated_keyring, test_session_options, now + 1);
		assert.ok(result);
		assert.strictEqual(result.identity, TEST_IDENTITY);
		assert.strictEqual(result.key_index, 1);
	});

	test('returns null when no key can verify', async () => {
		const other_keyring = create_keyring('completely-different-key-32-chars!')!;
		const now = 1000;
		const signed = await create_session_cookie_value(
			other_keyring,
			TEST_IDENTITY,
			test_session_options,
			now
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
			decode_identity: () => null // always rejects
		};
		const now = 1000;
		// create a valid signed cookie with the standard config
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
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
			}
		};
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, 'sess-abc', colon_config, now);
		const result = await parse_session(signed, keyring, colon_config, now + 1);
		assert.ok(result);
		assert.strictEqual(result.identity, 'sess-abc');
	});

	test('rejects negative expires_at', async () => {
		// Negative expires_at fails the strict-integer regex outright (would
		// also fall through to `expires_at <= now` if the regex were absent).
		const keyring = create_test_keyring();
		const signed = await keyring.sign(`${TEST_IDENTITY}:-100`);
		const result = await parse_session(signed, keyring, test_session_options, 1000);
		assert.strictEqual(result, null);
	});

	test.each([
		['leading whitespace', ' 123'],
		['trailing whitespace', '123 '],
		['plus sign', '+123'],
		['decimal point', '123.5'],
		['scientific notation', '1e10'],
		['hex prefix', '0x10'],
		['trailing alpha', '123abc'],
		['empty', '']
	])('rejects malformed expires_at: %s (%j)', async (_label, expires_at_str) => {
		// Strict integer regex closes the `parseInt` permissiveness gap —
		// `parseInt('123abc')` returns `123`, so without the regex a tampered
		// cookie with garbage trailing chars would parse as a valid future
		// expiration. HMAC integrity makes the threat theoretical, but
		// defense-in-depth pins the contract.
		const keyring = create_test_keyring();
		const signed = await keyring.sign(`${TEST_IDENTITY}:${expires_at_str}`);
		const result = await parse_session(signed, keyring, test_session_options, 1000);
		assert.strictEqual(result, null);
	});

	test('returns null when identity payload is empty (default decoder)', async () => {
		// Signed value `:<expires_at>` splits into identity_payload='' and
		// the default decoder (`(payload) => payload || null`) rejects it.
		// Locks in the default-decoder empty-string contract beyond the
		// explicit-rejecting-decoder path above.
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await keyring.sign(`:${now + SESSION_AGE_MAX}`);
		const result = await parse_session(signed, keyring, test_session_options, now);
		assert.strictEqual(result, null);
	});
});

describe('parse_session — absolute expiry', () => {
	test('a cookie parses identically at any age — no refresh signal exists', async () => {
		// The sliding-renewal signal (`should_refresh_expiration`) is gone:
		// the embedded expiry is absolute, set once at mint, so a near-expiry
		// parse carries no instruction to re-sign. One second past it the
		// cookie is simply invalid.
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(
			keyring,
			TEST_IDENTITY,
			test_session_options,
			now
		);
		const near_expiry = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX - 1
		);
		assert.ok(near_expiry);
		assert.deepStrictEqual(near_expiry, { identity: TEST_IDENTITY, key_index: 0 });

		const past_expiry = await parse_session(
			signed,
			keyring,
			test_session_options,
			now + SESSION_AGE_MAX
		);
		assert.strictEqual(past_expiry, null);
	});
});

describe('parse_session — generic identity', () => {
	test('round-trips with SessionOptions<number>', async () => {
		// Documents the generic `TIdentity` parameter — the visiones-style
		// account-id-as-number config from the source's docstring example.
		// Catches regressions in the encode/decode plumbing that would only
		// surface for non-string identities.
		const number_options: SessionOptions<number> = {
			cookie_name: 'test_session',
			context_key: 'auth_session_id',
			encode_identity: (id) => String(id),
			decode_identity: (payload) => {
				const n = parseInt(payload, 10);
				return Number.isFinite(n) && n > 0 ? n : null;
			}
		};
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, 42, number_options, now);
		const result = await parse_session(signed, keyring, number_options, now + 1);
		assert.ok(result);
		assert.strictEqual(result.identity, 42);
		assert.strictEqual(typeof result.identity, 'number');
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
				NOW
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
			'user\twith\ttabs'
		];
		for (const identity of test_identities) {
			const signed = await create_session_cookie_value(
				keyring,
				identity,
				test_session_options,
				NOW
			);
			const result = await parse_session(signed, keyring, test_session_options, NOW);
			assert.ok(result, `should parse identity: ${JSON.stringify(identity)}`);
			assert.strictEqual(
				result.identity,
				identity,
				`identity mismatch for ${JSON.stringify(identity)}`
			);
		}
	});
});
