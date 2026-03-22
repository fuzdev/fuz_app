/**
 * Tests for middleware/session_lifecycle - session creation and cookie setting.
 *
 * @module
 */

import {describe, assert, test, vi} from 'vitest';

import {create_session_and_set_cookie} from '$lib/auth/session_lifecycle.js';
import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {AUTH_SESSION_LIFETIME_MS} from '$lib/auth/session_queries.js';

// Mock the module-level query functions that session_lifecycle imports
const {mock_query_create_session, mock_query_session_enforce_limit} = vi.hoisted(() => ({
	mock_query_create_session: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_query_session_enforce_limit: vi.fn((..._args: Array<any>) => Promise.resolve()),
}));

vi.mock('$lib/auth/session_queries.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/auth/session_queries.js')>();
	return {
		...actual,
		query_create_session: mock_query_create_session,
		query_session_enforce_limit: mock_query_session_enforce_limit,
	};
});

const TEST_KEY = 'test-secret-key-that-is-at-least-32-chars';
const SESSION_OPTIONS = create_session_config('test_session');

/** Create a mock Hono context that captures set-cookie headers. */
const create_mock_context = (): {c: any; cookies: Array<string>} => {
	const cookies: Array<string> = [];
	const c = {
		header: (name: string, value: string) => {
			if (name.toLowerCase() === 'set-cookie') {
				cookies.push(value);
			}
		},
	};
	return {c, cookies};
};

/** Mock QueryDeps with a stub db. */
const mock_deps = {db: {}} as any;

describe('create_session_and_set_cookie', () => {
	test('creates a server-side session', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		mock_query_create_session.mockClear();
		const {c} = create_mock_context();

		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
		});

		assert.strictEqual(mock_query_create_session.mock.calls.length, 1);
		const call = mock_query_create_session.mock.calls[0]!;
		assert.strictEqual(call[0], mock_deps); // deps
		const token_hash = call[1] as string;
		assert.ok(typeof token_hash === 'string');
		assert.ok(token_hash.length > 0, 'token hash should be non-empty');
		assert.strictEqual(call[2], 'acct-1'); // account_id
		assert.ok(call[3] instanceof Date); // expires_at
	});

	test('generates unique tokens per call', async () => {
		mock_query_create_session.mockClear();
		const keyring = create_keyring(TEST_KEY)!;
		const {c: c1} = create_mock_context();
		const {c: c2} = create_mock_context();

		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c: c1,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
		});
		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c: c2,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
		});

		const hash1 = mock_query_create_session.mock.calls[0]![1] as string;
		const hash2 = mock_query_create_session.mock.calls[1]![1] as string;
		assert.notStrictEqual(hash1, hash2, 'each session should have a unique token hash');
	});

	test('sets a cookie on the response', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		const {c, cookies} = create_mock_context();

		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
		});

		assert.ok(cookies.length > 0);
		const cookie = cookies[0]!;
		assert.ok(cookie.includes('test_session='));
		assert.ok(cookie.includes('HttpOnly'));
		assert.ok(cookie.includes('Secure'), 'cookie must have Secure flag');
		assert.ok(cookie.includes('SameSite=Strict'), 'cookie must have SameSite=Strict');
		assert.ok(cookie.includes('Path=/'), 'cookie must have Path=/');
	});

	test('stores hash in DB, not raw token', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		mock_query_create_session.mockClear();
		const {c, cookies} = create_mock_context();

		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
		});

		const token_hash = mock_query_create_session.mock.calls[0]![1] as string;
		const cookie = cookies[0]!;
		// the hash stored in DB must not appear in the cookie value
		assert.ok(!cookie.includes(token_hash), 'raw token hash must not appear in cookie');
		// the cookie must contain the cookie name
		assert.ok(cookie.includes('test_session='), 'cookie should contain session name');
	});

	test('enforces session limit when max_sessions is provided', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		mock_query_session_enforce_limit.mockClear();
		const {c} = create_mock_context();

		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
			max_sessions: 5,
		});

		assert.strictEqual(mock_query_session_enforce_limit.mock.calls.length, 1);
		const call = mock_query_session_enforce_limit.mock.calls[0]!;
		assert.strictEqual(call[0], mock_deps); // deps
		assert.strictEqual(call[1], 'acct-1');
		assert.strictEqual(call[2], 5);
	});

	test('does not enforce session limit when max_sessions is null', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		mock_query_session_enforce_limit.mockClear();
		const {c} = create_mock_context();

		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
			max_sessions: null,
		});

		assert.strictEqual(mock_query_session_enforce_limit.mock.calls.length, 0);
	});

	test('does not enforce session limit when max_sessions is omitted', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		mock_query_session_enforce_limit.mockClear();
		const {c} = create_mock_context();

		await create_session_and_set_cookie({
			keyring,
			deps: mock_deps,
			c,
			account_id: 'acct-1',
			session_options: SESSION_OPTIONS,
		});

		assert.strictEqual(mock_query_session_enforce_limit.mock.calls.length, 0);
	});

	test('session expires in the future', async () => {
		const keyring = create_keyring(TEST_KEY)!;
		mock_query_create_session.mockClear();
		const {c} = create_mock_context();

		const fake_now = 1_700_000_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(fake_now);
		try {
			await create_session_and_set_cookie({
				keyring,
				deps: mock_deps,
				c,
				account_id: 'acct-1',
				session_options: SESSION_OPTIONS,
			});

			const expires_at = mock_query_create_session.mock.calls[0]![3] as Date;
			assert.strictEqual(expires_at.getTime(), fake_now + AUTH_SESSION_LIFETIME_MS);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
