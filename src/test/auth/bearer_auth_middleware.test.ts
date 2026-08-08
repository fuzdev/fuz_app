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
} from '$lib/testing/middleware.ts';
import { create_test_request_context } from '$lib/testing/auth_apps.ts';

// --- Test data ---

const MOCK_API_TOKEN = { account_id: 'acc_1', actor_id: 'act_1', id: 'tok_1' };

// --- Test case table ---

const bearer_auth_cases: Array<BearerAuthTestCase> = [
	// pass-through paths (middleware calls next without acting)
	{
		name: 'session already set — skips bearer auth, preserves original context',
		headers: { Authorization: 'Bearer secret_fuz_token_test123' },
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
			Authorization: 'Bearer secret_fuz_token_test123',
			Origin: 'https://attacker.example.com'
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'Referer header present — bearer silently discarded (browser context)',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Referer: 'https://attacker.example.com/page'
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'empty-string Origin header — still treated as browser context',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Origin: ''
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'empty-string Referer header — still treated as browser context',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Referer: ''
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'both Origin and Referer present — bearer silently discarded (browser context)',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Origin: 'https://attacker.example.com',
			Referer: 'https://attacker.example.com/page'
		},
		expected_status: 'next',
		validate_expectation: 'not_called'
	},

	// defense-in-depth: scheme parsing edge cases
	{
		name: 'mixed-case BeArEr scheme — recognized, invalid token soft-fails',
		headers: { Authorization: 'BeArEr secret_fuz_token_bad' },
		mock_validate_result: undefined,
		expected_status: 'next',
		validate_expectation: 'called'
	},
	{
		name: 'tab between scheme and token — not recognized as Bearer auth',
		headers: { Authorization: 'Bearer\tsecret_fuz_token_test' },
		expected_status: 'next',
		validate_expectation: 'not_called'
	},
	{
		name: 'double space after Bearer — extra space included in token, soft-fails',
		headers: { Authorization: 'Bearer  secret_fuz_token_bad' },
		mock_validate_result: undefined,
		expected_status: 'next',
		validate_expectation: 'called',
		assert_mocks: (mocks) => {
			// The extra space is included in the extracted token (args: deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], ' secret_fuz_token_bad');
		}
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
	{
		name: 'invalid token — soft-fails (no context set, downstream enforces auth)',
		headers: { Authorization: 'Bearer secret_fuz_token_bad' },
		mock_validate_result: undefined,
		expected_status: 'next',
		validate_expectation: 'called',
		assert_mocks: (mocks) => {
			// validate was called with (deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls.length, 1);
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], 'secret_fuz_token_bad');
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![2], TEST_CLIENT_IP);
		}
	},
	// success path — bearer auth sets the account-grain identity from the
	// validated token and stops. Account / actor / role_grant lookups belong to
	// the dispatcher's authorization phase, which only runs when a route's
	// auth requires role_grants or its input declares `acting?: ActingActor`.
	{
		name: 'valid token — sets account_id, credential_type, and api_token_id',
		headers: { Authorization: 'Bearer secret_fuz_token_good' },
		mock_validate_result: MOCK_API_TOKEN,
		expected_status: 'next',
		validate_expectation: 'called',
		assert_account_set: true,
		expected_account_id: 'acc_1',
		expected_api_token_id: 'tok_1',
		assert_mocks: (mocks) => {
			// validate called with (deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], 'secret_fuz_token_good');
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![2], TEST_CLIENT_IP);
			// account/actor/role_grant queries are not the bearer middleware's concern
			assert.strictEqual(mocks.mock_find_by_id.mock.calls.length, 0);
			assert.strictEqual(mocks.mock_find_actor_by_id.mock.calls.length, 0);
			assert.strictEqual(mocks.mock_find_active_for_actor.mock.calls.length, 0);
		}
	}
];

// --- Run the table ---

describe_bearer_auth_cases('create_bearer_auth_middleware', bearer_auth_cases);

// --- DEV-only browser-context discard diagnostic header ---

describe('bearer browser-context discard diagnostic (DEV)', () => {
	test('emits X-Fuz-Auth-Debug on browser-context discard, absent otherwise', async () => {
		const { app } = create_bearer_auth_test_app({
			name: 'browser-context discard diagnostic header',
			headers: { Authorization: 'Bearer secret_fuz_token_test' },
			expected_status: 'next'
		});

		// Origin present → discarded for browser context → DEV header set.
		const discarded = await app.request('/api/test', {
			headers: { Authorization: 'Bearer secret_fuz_token_test', Origin: 'https://x.example' }
		});
		assert.strictEqual(
			discarded.headers.get('X-Fuz-Auth-Debug'),
			'bearer_discarded_browser_context'
		);

		// No Origin/Referer → not a browser-context discard → no diagnostic header.
		const non_browser = await app.request('/api/test', {
			headers: { Authorization: 'Bearer secret_fuz_token_test' }
		});
		assert.strictEqual(non_browser.headers.get('X-Fuz-Auth-Debug'), null);
	});
});
