/**
 * Table-driven unit tests for `create_bearer_auth_middleware`.
 *
 * Each test case in the table exercises one branch of the middleware's
 * decision tree: session skip, no auth header, Origin rejection,
 * token validation outcomes, and the full success path.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	describe_bearer_auth_cases,
	create_bearer_auth_test_app,
	TEST_CLIENT_IP,
	type BearerAuthTestCase
} from '#lib/testing/middleware.ts';
import { create_test_request_context } from '#lib/testing/auth_apps.ts';
import {
	create_test_raw_api_token,
	create_test_validated_api_token
} from '#lib/testing/entities.ts';
import { API_TOKEN_PREFIX } from '#lib/auth/api_token.ts';
import { token_scope_methods } from '#lib/auth/token_scope.ts';

// --- Test data ---

// Well-formed tokens, so every case below past the scheme checks reaches the
// lookup unless something earlier short-circuits on purpose.
const TOKEN = create_test_raw_api_token('test123');
const TOKEN_BAD = create_test_raw_api_token('bad');
const TOKEN_GOOD = create_test_raw_api_token('good');

// A narrowed scope, so the success case proves the middleware sets the scope
// the query returns rather than a default.
const MOCK_SCOPE = token_scope_methods(['account_verify']);
const MOCK_API_TOKEN = create_test_validated_api_token({
	account_id: 'acc_1',
	id: 'tok_1',
	scope: MOCK_SCOPE
});

// --- Test case table ---

const bearer_auth_cases: Array<BearerAuthTestCase> = [
	// pass-through paths (middleware calls next without acting)
	{
		name: 'session already set — skips bearer auth, preserves original context',
		headers: { Authorization: `Bearer ${TOKEN}` },
		pre_context: create_test_request_context('admin'),
		expected_status: 'next',
		validate_expectation: 'not_called',
		assert_context_preserved: true
	},
	{
		name: 'no Authorization header — passes through',
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'non-Bearer Authorization header — passes through',
		headers: { Authorization: 'Basic dXNlcjpwYXNz' },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},

	// rejection paths
	{
		name: 'Origin header present — bearer silently discarded (browser context)',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Origin: 'https://attacker.example.com'
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'Referer header present — bearer silently discarded (browser context)',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Referer: 'https://attacker.example.com/page'
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'empty-string Origin header — still treated as browser context',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Origin: ''
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'empty-string Referer header — still treated as browser context',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Referer: ''
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'both Origin and Referer present — bearer silently discarded (browser context)',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Origin: 'https://attacker.example.com',
			Referer: 'https://attacker.example.com/page'
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},

	// defense-in-depth: scheme parsing edge cases
	{
		name: 'mixed-case BeArEr scheme — recognized, invalid token soft-fails',
		headers: { Authorization: `BeArEr ${TOKEN_BAD}` },
		mock_validate_result: undefined,
		expected_status: 'next',
		validate_expectation: 'called'
	},
	{
		name: 'tab between scheme and token — not recognized as Bearer auth',
		headers: { Authorization: `Bearer\t${TOKEN}` },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'double space after Bearer — extra space included in token, malformed, soft-fails before lookup',
		// The extra space is included in the extracted token, so it fails the shape precheck.
		headers: { Authorization: `Bearer  ${TOKEN_BAD}` },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'Bearer scheme with empty token body via Fetch — passes through (Fetch trims trailing space)',
		headers: { Authorization: 'Bearer ' },
		// The Fetch API trims trailing whitespace from header values, so
		// 'Bearer ' becomes 'Bearer' which doesn't match 'bearer ' prefix.
		// bearer_auth.ts has a defense-in-depth guard (`if (!raw_token)`) that
		// soft-fails for empty token bodies from non-Fetch HTTP clients, but
		// that path is unreachable through any spec-compliant Fetch implementation
		// — including Hono's test client. The guard costs nothing and protects
		// against non-standard runtimes or proxies that pass raw headers through.
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	// shape precheck — a value that cannot be a token never reaches the lookup
	{
		name: 'short token (prefix, truncated body) — malformed, soft-fails before lookup',
		headers: { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'long token (one body char too many) — malformed, soft-fails before lookup',
		headers: { Authorization: `Bearer ${TOKEN}A` },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'wrong prefix at the right length — malformed, soft-fails before lookup',
		headers: {
			Authorization: `Bearer ${'x'.repeat(API_TOKEN_PREFIX.length)}${TOKEN.slice(API_TOKEN_PREFIX.length)}`
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'non-base64url body char at the right length — malformed, soft-fails before lookup',
		headers: { Authorization: `Bearer ${TOKEN.slice(0, -1)}=` },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'unprefixed junk — malformed, soft-fails before lookup',
		headers: { Authorization: 'Bearer invalid_token' },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'invalid token — soft-fails (no context set, downstream enforces auth)',
		headers: { Authorization: `Bearer ${TOKEN_BAD}` },
		mock_validate_result: undefined,
		expected_status: 'next',
		validate_expectation: 'called',
		assert_mocks: (mocks) => {
			// validate was called with (deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls.length, 1);
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], TOKEN_BAD);
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![2], TEST_CLIENT_IP);
		}
	},
	// success path — bearer auth sets the account-grain identity from the
	// validated token and stops. Account / actor / role_grant lookups belong to
	// the dispatcher's authorization phase, which only runs when a route's
	// auth requires role_grants or its input declares `acting?: ActingActor`.
	{
		name: 'valid token — sets account_id, credential_type, api_token_id, and token scope',
		headers: { Authorization: `Bearer ${TOKEN_GOOD}` },
		mock_validate_result: MOCK_API_TOKEN,
		expected_status: 'next',
		validate_expectation: 'called',
		assert_account_set: true,
		expected_account_id: 'acc_1',
		expected_api_token_id: 'tok_1',
		expected_token_scope: MOCK_SCOPE,
		// an eternal token has no deadline
		expected_credential_deadline_ms: null,
		assert_mocks: (mocks) => {
			// validate called with (deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], TOKEN_GOOD);
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![2], TEST_CLIENT_IP);
			// account/actor/role_grant queries are not the bearer middleware's concern
			assert.strictEqual(mocks.mock_find_by_id.mock.calls.length, 0);
			assert.strictEqual(mocks.mock_find_actor_by_id.mock.calls.length, 0);
			assert.strictEqual(mocks.mock_find_active_for_actor.mock.calls.length, 0);
		}
	},
	{
		name: 'a token with an expiry sets the credential deadline to the row lifetime',
		headers: { Authorization: `Bearer ${TOKEN_GOOD}` },
		mock_validate_result: { ...MOCK_API_TOKEN, expires_in_ms: 5000 },
		expected_status: 'next',
		validate_expectation: 'called',
		assert_account_set: true,
		expected_credential_deadline_ms: 5000
	}
];

// --- Run the table ---

describe_bearer_auth_cases('create_bearer_auth_middleware', bearer_auth_cases);

// --- A token the query refuses sets nothing ---

describe('bearer token refused by the query', () => {
	// The query refuses a token whose stored scope is unreadable (pinned in
	// `api_token_queries.db.test.ts`) the same way as an unknown one — by
	// returning nothing — so the middleware has no scope to fall back to and
	// sets no identity at all.
	test('sets no identity, credential type, token id, or scope', async () => {
		const { app, mocks } = create_bearer_auth_test_app({
			name: 'refused token',
			mock_validate_result: undefined,
			expected_status: 'next'
		});

		const res = await app.request('/api/test', {
			headers: { Authorization: `Bearer ${TOKEN_GOOD}` }
		});
		const body = await res.json();

		assert.strictEqual(mocks.mock_validate.mock.calls.length, 1, 'the lookup ran');
		assert.strictEqual(body.account_id, null);
		assert.strictEqual(body.credential_type, null);
		assert.strictEqual(body.api_token_id, null);
		assert.strictEqual(body.token_scope, null);
	});
});

// --- DEV-only browser-context discard diagnostic header ---

describe('bearer browser-context discard diagnostic (DEV)', () => {
	test('emits X-Fuz-Auth-Debug on browser-context discard, absent otherwise', async () => {
		const { app } = create_bearer_auth_test_app({
			name: 'browser-context discard diagnostic header',
			headers: { Authorization: `Bearer ${TOKEN}` },
			expected_status: 'next'
		});

		// Origin present → discarded for browser context → DEV header set.
		const discarded = await app.request('/api/test', {
			headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://x.example' }
		});
		assert.strictEqual(
			discarded.headers.get('X-Fuz-Auth-Debug'),
			'bearer_discarded_browser_context'
		);

		// No Origin/Referer → not a browser-context discard → no diagnostic header.
		const non_browser = await app.request('/api/test', {
			headers: { Authorization: `Bearer ${TOKEN}` }
		});
		assert.strictEqual(non_browser.headers.get('X-Fuz-Auth-Debug'), null);
	});
});
