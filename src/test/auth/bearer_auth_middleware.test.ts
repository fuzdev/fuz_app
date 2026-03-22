/**
 * Table-driven unit tests for `create_bearer_auth_middleware`.
 *
 * Each test case in the table exercises one branch of the middleware's
 * decision tree: session skip, no auth header, Origin rejection,
 * token validation outcomes, and the full success path.
 *
 * @module
 */

import {assert, describe, test, vi} from 'vitest';

import {
	describe_bearer_auth_cases,
	create_bearer_auth_test_app,
	TEST_CLIENT_IP,
	type BearerAuthTestCase,
	type BearerAuthTestOptions,
} from '$lib/testing/middleware.js';
import {create_test_request_context} from '$lib/testing/auth_apps.js';
import {
	RateLimitError,
	ERROR_BEARER_REJECTED_BROWSER,
	ERROR_INVALID_TOKEN,
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_RATE_LIMIT_EXCEEDED,
} from '$lib/http/error_schemas.js';

// --- Test data ---

const MOCK_ACCOUNT = {
	id: 'acc_1',
	username: 'tokenuser',
	password_hash: 'hash',
	created_at: new Date().toISOString(),
	updated_at: new Date().toISOString(),
	created_by: null,
	updated_by: null,
	email: null,
	email_verified: false,
};

const MOCK_ACTOR = {
	id: 'act_1',
	account_id: 'acc_1',
	name: 'tokenuser',
	created_at: new Date().toISOString(),
	updated_at: null,
	updated_by: null,
};

const MOCK_PERMITS = [
	{
		id: 'perm_1',
		actor_id: 'act_1',
		role: 'admin',
		created_at: new Date().toISOString(),
		expires_at: null,
		revoked_at: null,
		revoked_by: null,
		granted_by: null,
	},
];

const MOCK_API_TOKEN = {account_id: 'acc_1', id: 'tok_1'};

// --- Test case table ---

const bearer_auth_cases: Array<BearerAuthTestCase> = [
	// pass-through paths (middleware calls next without acting)
	{
		name: 'session already set — skips bearer auth, preserves original context',
		headers: {Authorization: 'Bearer secret_fuz_token_test123'},
		pre_context: create_test_request_context('admin'),
		expected_status: 'next',
		validate_expectation: 'not_called',
		assert_context_preserved: true,
	},
	{
		name: 'no Authorization header — passes through',
		expected_status: 'next',
		validate_expectation: 'not_called',
	},
	{
		name: 'non-Bearer Authorization header — passes through',
		headers: {Authorization: 'Basic dXNlcjpwYXNz'},
		expected_status: 'next',
		validate_expectation: 'not_called',
	},

	// rejection paths
	{
		name: 'Origin header present — rejects bearer token in browser context',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Origin: 'https://attacker.example.com',
		},
		expected_status: 403,
		expected_error: ERROR_BEARER_REJECTED_BROWSER,
		validate_expectation: 'not_called',
	},
	{
		name: 'Referer header present — rejects bearer token in browser context',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Referer: 'https://attacker.example.com/page',
		},
		expected_status: 403,
		expected_error: ERROR_BEARER_REJECTED_BROWSER,
		validate_expectation: 'not_called',
	},
	{
		name: 'empty-string Origin header — still treated as browser context',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Origin: '',
		},
		expected_status: 403,
		expected_error: ERROR_BEARER_REJECTED_BROWSER,
		validate_expectation: 'not_called',
	},
	{
		name: 'empty-string Referer header — still treated as browser context',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Referer: '',
		},
		expected_status: 403,
		expected_error: ERROR_BEARER_REJECTED_BROWSER,
		validate_expectation: 'not_called',
	},
	{
		name: 'both Origin and Referer present — rejected as browser context',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test123',
			Origin: 'https://attacker.example.com',
			Referer: 'https://attacker.example.com/page',
		},
		expected_status: 403,
		expected_error: ERROR_BEARER_REJECTED_BROWSER,
		validate_expectation: 'not_called',
	},

	// defense-in-depth: scheme parsing edge cases
	{
		name: 'mixed-case BeArEr scheme — recognized via case-insensitive matching',
		headers: {Authorization: 'BeArEr secret_fuz_token_bad'},
		mock_validate_result: undefined,
		expected_status: 401,
		expected_error: ERROR_INVALID_TOKEN,
		validate_expectation: 'called',
	},
	{
		name: 'tab between scheme and token — not recognized as Bearer auth',
		headers: {Authorization: 'Bearer\tsecret_fuz_token_test'},
		expected_status: 'next',
		validate_expectation: 'not_called',
	},
	{
		name: 'double space after Bearer — extra space included in token',
		headers: {Authorization: 'Bearer  secret_fuz_token_bad'},
		mock_validate_result: undefined,
		expected_status: 401,
		expected_error: ERROR_INVALID_TOKEN,
		validate_expectation: 'called',
		assert_mocks: (mocks) => {
			// The extra space is included in the extracted token (args: deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], ' secret_fuz_token_bad');
		},
	},
	{
		name: 'Bearer scheme with empty token body via Fetch — passes through (Fetch trims trailing space)',
		headers: {Authorization: 'Bearer '},
		// The Fetch API trims trailing whitespace from header values, so
		// 'Bearer ' becomes 'Bearer' which doesn't match 'bearer ' prefix.
		expected_status: 'next',
		validate_expectation: 'not_called',
	},
	{
		name: 'invalid token — returns 401',
		headers: {Authorization: 'Bearer secret_fuz_token_bad'},
		mock_validate_result: undefined,
		expected_status: 401,
		expected_error: ERROR_INVALID_TOKEN,
		validate_expectation: 'called',
		assert_mocks: (mocks) => {
			// validate was called with (deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls.length, 1);
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], 'secret_fuz_token_bad');
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![2], TEST_CLIENT_IP);
		},
	},
	{
		name: 'valid token but account deleted — returns 401',
		headers: {Authorization: 'Bearer secret_fuz_token_good'},
		mock_validate_result: MOCK_API_TOKEN,
		mock_find_by_id_result: undefined,
		expected_status: 401,
		expected_error: ERROR_ACCOUNT_NOT_FOUND,
		validate_expectation: 'called',
		assert_mocks: (mocks) => {
			// find_by_id was called with (deps, account_id)
			assert.strictEqual(mocks.mock_find_by_id.mock.calls.length, 1);
			assert.strictEqual(mocks.mock_find_by_id.mock.calls[0]![1], 'acc_1');
			// find_by_account should NOT have been called
			assert.strictEqual(mocks.mock_find_by_account.mock.calls.length, 0);
		},
	},
	{
		name: 'valid token but actor missing — returns 401',
		headers: {Authorization: 'Bearer secret_fuz_token_good'},
		mock_validate_result: MOCK_API_TOKEN,
		mock_find_by_id_result: MOCK_ACCOUNT,
		mock_find_by_account_result: undefined,
		expected_status: 401,
		expected_error: ERROR_ACCOUNT_NOT_FOUND,
		validate_expectation: 'called',
		assert_mocks: (mocks) => {
			// find_by_account was called with (deps, account_id)
			assert.strictEqual(mocks.mock_find_by_account.mock.calls.length, 1);
			assert.strictEqual(mocks.mock_find_by_account.mock.calls[0]![1], 'acc_1');
			// permits should NOT have been loaded
			assert.strictEqual(mocks.mock_find_active_for_actor.mock.calls.length, 0);
		},
	},

	// success path
	{
		name: 'full success — sets request context and credential type',
		headers: {Authorization: 'Bearer secret_fuz_token_good'},
		mock_validate_result: MOCK_API_TOKEN,
		mock_find_by_id_result: MOCK_ACCOUNT,
		mock_find_by_account_result: MOCK_ACTOR,
		mock_permits_result: MOCK_PERMITS,
		expected_status: 'next',
		validate_expectation: 'called',
		assert_context_set: true,
		assert_mocks: (mocks) => {
			// validate called with (deps, raw_token, ip, pending_effects)
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![1], 'secret_fuz_token_good');
			assert.strictEqual(mocks.mock_validate.mock.calls[0]![2], TEST_CLIENT_IP);
			// full chain was called
			assert.strictEqual(mocks.mock_find_by_id.mock.calls.length, 1);
			assert.strictEqual(mocks.mock_find_by_account.mock.calls.length, 1);
			assert.strictEqual(mocks.mock_find_active_for_actor.mock.calls.length, 1);
			// permits queried with (deps, actor_id)
			assert.strictEqual(mocks.mock_find_active_for_actor.mock.calls[0]![1], 'act_1');
		},
	},
];

// --- Run the table ---

describe_bearer_auth_cases('create_bearer_auth_middleware', bearer_auth_cases);

// --- Rate limiter integration at unit level ---

// --- Rate limiter side-effect assertions (mock limiter) ---

describe('bearer auth rate limiter side effects', () => {
	const create_mock_limiter = () => ({
		check: vi.fn((_key: string) => ({allowed: true, remaining: 5, retry_after: 0})),
		record: vi.fn((_key: string) => ({allowed: true, remaining: 4, retry_after: 0})),
		reset: vi.fn((_key: string) => undefined),
	});

	test('invalid token calls record() with resolved client IP', async () => {
		const mock_limiter = create_mock_limiter();
		const tc: BearerAuthTestOptions = {
			name: '',
			headers: {Authorization: 'Bearer secret_fuz_token_bad'},
			mock_validate_result: undefined,
			expected_status: 401,
		};
		const {app} = create_bearer_auth_test_app(tc, mock_limiter as any);
		await app.request('/api/test', {headers: tc.headers});

		assert.strictEqual(mock_limiter.check.mock.calls.length, 1);
		assert.strictEqual(mock_limiter.check.mock.calls[0]![0], TEST_CLIENT_IP);
		assert.strictEqual(mock_limiter.record.mock.calls.length, 1);
		assert.strictEqual(mock_limiter.record.mock.calls[0]![0], TEST_CLIENT_IP);
		assert.strictEqual(mock_limiter.reset.mock.calls.length, 0);
	});

	test('valid token calls reset() with resolved client IP', async () => {
		const mock_limiter = create_mock_limiter();
		const tc: BearerAuthTestOptions = {
			name: '',
			headers: {Authorization: 'Bearer secret_fuz_token_good'},
			mock_validate_result: MOCK_API_TOKEN,
			mock_find_by_id_result: MOCK_ACCOUNT,
			mock_find_by_account_result: MOCK_ACTOR,
			mock_permits_result: MOCK_PERMITS,
			expected_status: 'next',
		};
		const {app} = create_bearer_auth_test_app(tc, mock_limiter as any);
		await app.request('/api/test', {headers: tc.headers});

		assert.strictEqual(mock_limiter.check.mock.calls.length, 1);
		// record() is called eagerly before DB work to close the TOCTOU window,
		// then reset() is called on valid token — net effect: no recorded failure
		assert.strictEqual(mock_limiter.record.mock.calls.length, 1);
		assert.strictEqual(mock_limiter.record.mock.calls[0]![0], TEST_CLIENT_IP);
		assert.strictEqual(mock_limiter.reset.mock.calls.length, 1);
		assert.strictEqual(mock_limiter.reset.mock.calls[0]![0], TEST_CLIENT_IP);
	});

	test('rate-limited request short-circuits before validate', async () => {
		const mock_limiter = create_mock_limiter();
		mock_limiter.check.mockReturnValue({allowed: false, remaining: 0, retry_after: 42});
		const tc: BearerAuthTestOptions = {
			name: '',
			headers: {Authorization: 'Bearer secret_fuz_token_any'},
			expected_status: 429,
			expected_error: ERROR_RATE_LIMIT_EXCEEDED,
		};
		const {app, mocks} = create_bearer_auth_test_app(tc, mock_limiter as any);
		const res = await app.request('/api/test', {headers: tc.headers});

		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		assert.strictEqual(body.retry_after, 42);
		RateLimitError.parse(body);
		assert.strictEqual(mocks.mock_validate.mock.calls.length, 0, 'validate should be skipped');
		assert.strictEqual(mock_limiter.record.mock.calls.length, 0);
		assert.strictEqual(mock_limiter.reset.mock.calls.length, 0);
	});

	test('Origin rejection skips rate limiter entirely', async () => {
		const mock_limiter = create_mock_limiter();
		const tc: BearerAuthTestOptions = {
			name: '',
			headers: {
				Authorization: 'Bearer secret_fuz_token_any',
				Origin: 'https://evil.com',
			},
			expected_status: 403,
		};
		const {app} = create_bearer_auth_test_app(tc, mock_limiter as any);
		await app.request('/api/test', {headers: tc.headers});

		assert.strictEqual(mock_limiter.check.mock.calls.length, 0, 'check should not be called');
		assert.strictEqual(mock_limiter.record.mock.calls.length, 0);
		assert.strictEqual(mock_limiter.reset.mock.calls.length, 0);
	});
});
