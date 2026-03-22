/**
 * Integration tests for rate limiting through login and bearer auth HTTP handlers.
 *
 * Uses vi.mock to stub query functions — no real database needed.
 * Focuses on verifying that handlers correctly integrate with the RateLimiter:
 * checking before work, recording failures, resetting on success, and
 * using the trusted proxy middleware for IP extraction.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';
import {Hono} from 'hono';

import {RateLimiter} from '$lib/rate_limiter.js';
import {create_proxy_middleware} from '$lib/http/proxy.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_signup_route_specs} from '$lib/auth/signup_routes.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {PASSWORD_LENGTH_MAX} from '$lib/auth/password.js';
import {create_bearer_auth_middleware} from '$lib/auth/bearer_auth.js';
import {ERROR_RATE_LIMIT_EXCEEDED, ERROR_INVALID_CREDENTIALS} from '$lib/http/error_schemas.js';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {create_stub_db, create_noop_stub} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});

// --- Mock wrappers for module-level query functions ---
const {
	mock_find_by_username_or_email,
	mock_session_create,
	mock_session_enforce_limit,
	mock_validate_api_token,
	mock_account_by_id,
	mock_actor_by_account,
	mock_permit_find_active,
	mock_invite_find_unclaimed_match,
	mock_invite_claim,
	mock_create_account_with_actor,
} = vi.hoisted(() => ({
	mock_find_by_username_or_email: vi.fn((..._args: Array<any>) => Promise.resolve(null)),
	mock_session_create: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_session_enforce_limit: vi.fn((..._args: Array<any>) => Promise.resolve(0)),
	mock_validate_api_token: vi.fn((..._args: Array<any>) => Promise.resolve(undefined)),
	mock_account_by_id: vi.fn((..._args: Array<any>): Promise<any> => Promise.resolve(null)),
	mock_actor_by_account: vi.fn((..._args: Array<any>): Promise<any> => Promise.resolve(null)),
	mock_permit_find_active: vi.fn((..._args: Array<any>): Promise<any> => Promise.resolve([])),
	mock_invite_find_unclaimed_match: vi.fn(
		(..._args: Array<any>): Promise<any> => Promise.resolve(null),
	),
	mock_invite_claim: vi.fn((..._args: Array<any>): Promise<any> => Promise.resolve(true)),
	mock_create_account_with_actor: vi.fn(
		(..._args: Array<any>): Promise<any> =>
			Promise.resolve({account: {id: 'acc_new'}, actor: {id: 'act_new'}}),
	),
}));

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_username_or_email: (...a: Array<any>) => mock_find_by_username_or_email(...a),
	query_account_by_id: (...a: Array<any>) => mock_account_by_id(...a),
	query_actor_by_account: (...a: Array<any>) => mock_actor_by_account(...a),
	query_create_account_with_actor: (...a: Array<any>) => mock_create_account_with_actor(...a),
}));

vi.mock('$lib/auth/invite_queries.js', () => ({
	query_invite_find_unclaimed_match: (...a: Array<any>) => mock_invite_find_unclaimed_match(...a),
	query_invite_claim: (...a: Array<any>) => mock_invite_claim(...a),
}));

vi.mock('$lib/auth/session_queries.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/auth/session_queries.js')>();
	return {
		...actual,
		query_create_session: (...a: Array<any>) => mock_session_create(...a),
		query_session_enforce_limit: (...a: Array<any>) => mock_session_enforce_limit(...a),
	};
});

vi.mock('$lib/auth/api_token_queries.js', () => ({
	query_validate_api_token: (...a: Array<any>) => mock_validate_api_token(...a),
}));

vi.mock('$lib/auth/audit_log_queries.js', () => ({
	audit_log_fire_and_forget: (..._a: Array<any>) => Promise.resolve(),
}));

vi.mock('$lib/auth/permit_queries.js', () => ({
	query_permit_find_active_for_actor: (...a: Array<any>) => mock_permit_find_active(...a),
}));

// --- Shared fixtures ---

/** Simulated connection IP for all test requests. */
const TEST_CONNECTION_IP = '127.0.0.1';

/**
 * Proxy middleware for tests: trusts the simulated connection IP
 * so that `X-Forwarded-For` headers are honored in test requests.
 */
const test_proxy_middleware = create_proxy_middleware({
	trusted_proxies: [TEST_CONNECTION_IP],
	get_connection_ip: () => TEST_CONNECTION_IP,
});

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 3;

const create_test_limiter = (): RateLimiter =>
	new RateLimiter({max_attempts: MAX_ATTEMPTS, window_ms: WINDOW_MS, cleanup_interval_ms: 0});

const keyring = create_keyring('integration_test_key_a')!;
const session_options = create_session_config('test_session');

const db = create_stub_db();
const noop = create_noop_stub('deps');

const fake_account = {
	id: 'acc_test',
	username: 'testuser',
	email: null,
	email_verified: false,
	password_hash: 'fake_hash',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: '2025-01-01T00:00:00.000Z',
	created_by: null,
	updated_by: null,
};

// --- Login helpers ---

interface LoginTestApp {
	app: Hono;
	find_by_username_or_email: ReturnType<typeof vi.fn>;
	session_create: ReturnType<typeof vi.fn>;
	mock_verify_password: ReturnType<typeof vi.fn>;
	mock_verify_dummy: ReturnType<typeof vi.fn>;
}

const create_login_app = (
	ip_rate_limiter: RateLimiter | null,
	login_account_rate_limiter: RateLimiter | null = null,
): LoginTestApp => {
	// Reset module-level mocks for login tests
	mock_find_by_username_or_email.mockReset().mockImplementation(() => Promise.resolve(null));
	mock_session_create.mockReset().mockImplementation(() => Promise.resolve());
	mock_session_enforce_limit.mockReset().mockImplementation(() => Promise.resolve(0));

	const mock_verify_password = vi.fn(() => Promise.resolve(false));
	const mock_verify_dummy = vi.fn(() => Promise.resolve(false));

	const route_specs = create_account_route_specs(
		{
			log,
			keyring,
			password: {
				hash_password: vi.fn(),
				verify_password: mock_verify_password,
				verify_dummy: mock_verify_dummy,
			},
			stat: noop,
			read_file: noop,
			delete_file: noop,
			on_audit_event: () => {},
		},
		{session_options, ip_rate_limiter, login_account_rate_limiter},
	);

	const app = new Hono();
	app.use('*', test_proxy_middleware);
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

	return {
		app,
		find_by_username_or_email: mock_find_by_username_or_email,
		session_create: mock_session_create,
		mock_verify_password,
		mock_verify_dummy,
	};
};

const login_request = (app: Hono, headers?: Record<string, string>): Response | Promise<Response> =>
	app.request('/login', {
		method: 'POST',
		headers: {'Content-Type': 'application/json', ...headers},
		body: JSON.stringify({username: 'testuser', password: 'valid_password_123'}),
	});

// --- Bearer auth helpers ---

interface BearerTestApp {
	app: Hono;
	mock_validate: ReturnType<typeof vi.fn>;
}

const create_bearer_app = (ip_rate_limiter: RateLimiter | null): BearerTestApp => {
	const mock_validate = vi.fn(() => Promise.resolve(undefined));
	mock_validate_api_token.mockReset().mockImplementation(mock_validate);
	mock_account_by_id.mockReset().mockImplementation(() => Promise.resolve(null));
	mock_actor_by_account.mockReset().mockImplementation(() => Promise.resolve(null));
	mock_permit_find_active.mockReset().mockImplementation(() => Promise.resolve([]));

	const bearer_middleware = create_bearer_auth_middleware({db}, ip_rate_limiter, log);

	const app = new Hono();
	app.use('*', test_proxy_middleware);
	app.use('/api/*', bearer_middleware);
	app.get('/api/test', (c) => c.json({ok: true}));

	return {app, mock_validate};
};

const bearer_request = (
	app: Hono,
	token = 'invalid_token',
	headers?: Record<string, string>,
): Response | Promise<Response> =>
	app.request('/api/test', {
		method: 'GET',
		headers: {Authorization: `Bearer ${token}`, ...headers},
	});

// --- Tests ---

afterEach(() => {
	vi.restoreAllMocks();
});

describe('login handler rate limiting', () => {
	test('returns 429 with rate_limit_exceeded when limit exhausted', async () => {
		const limiter = create_test_limiter();
		const {app} = create_login_app(limiter);

		// Exhaust the limit with failed login attempts
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await login_request(app);
			assert.strictEqual(res.status, 401);
		}

		// Next request should be rate-limited
		const res = await login_request(app);
		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		assert.strictEqual(typeof body.retry_after, 'number');
		assert.ok(body.retry_after > 0);

		limiter.dispose();
	});

	test('429 response contains only error and retry_after (no sensitive data)', async () => {
		const limiter = create_test_limiter();
		const {app} = create_login_app(limiter);

		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app);
		}

		const res = await login_request(app);
		const body = await res.json();
		const keys = Object.keys(body);
		assert.deepStrictEqual(keys.sort(), ['error', 'retry_after']);

		// No session cookie set on rate-limited response
		assert.strictEqual(res.headers.get('Set-Cookie'), null, '429 should not set a session cookie');

		limiter.dispose();
	});

	test('blocked request skips auth queries and password verification', async () => {
		const limiter = create_test_limiter();
		const {app, find_by_username_or_email, mock_verify_password, mock_verify_dummy} =
			create_login_app(limiter);

		// Exhaust the limit
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app);
		}

		const db_calls = find_by_username_or_email.mock.calls.length;
		const pw_calls = mock_verify_password.mock.calls.length;
		const dummy_calls = mock_verify_dummy.mock.calls.length;

		// Blocked request — rate limit check short-circuits before any auth work
		const res = await login_request(app);
		assert.strictEqual(res.status, 429);

		assert.strictEqual(
			find_by_username_or_email.mock.calls.length,
			db_calls,
			'should not query DB when rate-limited',
		);
		assert.strictEqual(
			mock_verify_password.mock.calls.length,
			pw_calls,
			'should not verify password when rate-limited',
		);
		assert.strictEqual(
			mock_verify_dummy.mock.calls.length,
			dummy_calls,
			'should not call verify_dummy when rate-limited',
		);

		limiter.dispose();
	});

	test('failed login (account not found) records an attempt', async () => {
		const limiter = create_test_limiter();
		const {app} = create_login_app(limiter);

		// find_by_username_or_email returns null by default (account not found)
		const res = await login_request(app);
		assert.strictEqual(res.status, 401);

		// IP is the test connection IP (no X-Forwarded-For) — one attempt consumed
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS - 1);

		limiter.dispose();
	});

	test('failed login (wrong password) records an attempt', async () => {
		const limiter = create_test_limiter();
		const {app, find_by_username_or_email} = create_login_app(limiter);

		// Account exists but password verification fails (mock default is false)
		find_by_username_or_email.mockResolvedValueOnce(fake_account);

		const res = await login_request(app);
		assert.strictEqual(res.status, 401);

		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS - 1);

		limiter.dispose();
	});

	test('successful login resets the rate limit counter', async () => {
		const limiter = create_test_limiter();
		const {app, find_by_username_or_email, mock_verify_password} = create_login_app(limiter);

		// Accumulate failures
		await login_request(app);
		await login_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, 1);

		// Succeed: account found + password valid
		find_by_username_or_email.mockResolvedValueOnce(fake_account);
		mock_verify_password.mockResolvedValueOnce(true);

		const res = await login_request(app);
		assert.strictEqual(res.status, 200);

		// Rate limit fully reset — all attempts available
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS);

		// Session cookie set on success
		const cookies = res.headers.get('Set-Cookie');
		assert.ok(cookies, 'successful login should set session cookie');
		assert.ok(cookies.includes('test_session='), 'cookie name should match session config');

		// Counter restarts from zero — a new failure counts fresh
		await login_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS - 1);

		limiter.dispose();
	});

	test('rate_limiter null allows unlimited failed attempts', async () => {
		const {app} = create_login_app(null);

		// Well beyond MAX_ATTEMPTS — should never see 429
		for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
			const res = await login_request(app);
			assert.strictEqual(res.status, 401, `request ${i + 1} should be 401, not 429`);
		}
	});

	test('X-Forwarded-For determines rate limit bucket', async () => {
		const limiter = create_test_limiter();
		const {app} = create_login_app(limiter);

		// Exhaust limit for 10.0.0.1
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app, {'X-Forwarded-For': '10.0.0.1'});
		}

		// 10.0.0.1 blocked
		assert.strictEqual((await login_request(app, {'X-Forwarded-For': '10.0.0.1'})).status, 429);

		// 10.0.0.2 unaffected — different rate limit bucket
		assert.strictEqual((await login_request(app, {'X-Forwarded-For': '10.0.0.2'})).status, 401);

		limiter.dispose();
	});

	test('different IPs are rate-limited independently', async () => {
		const limiter = create_test_limiter();
		const {app} = create_login_app(limiter);

		// Exhaust limit for two different IPs
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app, {'X-Forwarded-For': '10.0.0.1'});
			await login_request(app, {'X-Forwarded-For': '10.0.0.2'});
		}

		// Both blocked
		assert.strictEqual((await login_request(app, {'X-Forwarded-For': '10.0.0.1'})).status, 429);
		assert.strictEqual((await login_request(app, {'X-Forwarded-For': '10.0.0.2'})).status, 429);

		// Third IP unaffected
		assert.strictEqual((await login_request(app, {'X-Forwarded-For': '10.0.0.3'})).status, 401);

		limiter.dispose();
	});
});

describe('login handler per-account rate limiting', () => {
	test('returns 429 when per-account limit exhausted', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app} = create_login_app(null, account_limiter);

		// Exhaust the per-account limit
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await login_request(app);
			assert.strictEqual(res.status, 401);
		}

		// Next request should be rate-limited by account
		const res = await login_request(app);
		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		assert.strictEqual(typeof body.retry_after, 'number');
		assert.ok(body.retry_after > 0);

		account_limiter.dispose();
	});

	test('blocked request skips auth work', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app, find_by_username_or_email, mock_verify_password, mock_verify_dummy} =
			create_login_app(null, account_limiter);

		// Exhaust the limit
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app);
		}

		const db_calls = find_by_username_or_email.mock.calls.length;
		const pw_calls = mock_verify_password.mock.calls.length;
		const dummy_calls = mock_verify_dummy.mock.calls.length;

		// Blocked request — account rate limit check short-circuits before DB work
		const res = await login_request(app);
		assert.strictEqual(res.status, 429);

		assert.strictEqual(
			find_by_username_or_email.mock.calls.length,
			db_calls,
			'should not query DB when account rate-limited',
		);
		assert.strictEqual(
			mock_verify_password.mock.calls.length,
			pw_calls,
			'should not verify password when account rate-limited',
		);
		assert.strictEqual(
			mock_verify_dummy.mock.calls.length,
			dummy_calls,
			'should not call verify_dummy when account rate-limited',
		);

		account_limiter.dispose();
	});

	test('both failure paths record against submitted username', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app, find_by_username_or_email} = create_login_app(null, account_limiter);

		// Path 1: account not found (default mock returns null)
		await login_request(app);
		assert.strictEqual(account_limiter.check('testuser').remaining, MAX_ATTEMPTS - 1);

		// Path 2: account found, wrong password
		find_by_username_or_email.mockResolvedValueOnce(fake_account);
		await login_request(app);
		assert.strictEqual(account_limiter.check('testuser').remaining, MAX_ATTEMPTS - 2);

		account_limiter.dispose();
	});

	test('successful login resets per-account counter', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app, find_by_username_or_email, mock_verify_password} = create_login_app(
			null,
			account_limiter,
		);

		// Accumulate failures
		await login_request(app);
		await login_request(app);
		assert.strictEqual(account_limiter.check('testuser').remaining, 1);

		// Succeed
		find_by_username_or_email.mockResolvedValueOnce(fake_account);
		mock_verify_password.mockResolvedValueOnce(true);

		const res = await login_request(app);
		assert.strictEqual(res.status, 200);

		// Per-account counter fully reset
		assert.strictEqual(account_limiter.check('testuser').remaining, MAX_ATTEMPTS);

		account_limiter.dispose();
	});

	test('account_rate_limiter null allows unlimited attempts', async () => {
		const {app} = create_login_app(null, null);

		// Well beyond MAX_ATTEMPTS — should never see 429
		for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
			const res = await login_request(app);
			assert.strictEqual(res.status, 401, `request ${i + 1} should be 401, not 429`);
		}
	});

	test('different usernames have independent account rate limit buckets', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app} = create_login_app(null, account_limiter);

		// Exhaust limit for 'testuser'
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app);
		}

		// 'testuser' blocked
		assert.strictEqual((await login_request(app)).status, 429);

		// Different username is unaffected
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'otheruser', password: 'valid_password_123'}),
		});
		assert.strictEqual(res.status, 401);

		account_limiter.dispose();
	});

	test('case variants share the same per-account rate limit bucket', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app} = create_login_app(null, account_limiter);

		// Send requests with mixed-case usernames — all should count against the same bucket
		const cases = ['TestUser', 'TESTUSER', 'testuser'];
		for (const username of cases) {
			await app.request('/login', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({username, password: 'valid_password_123'}),
			});
		}

		// All 3 count against 'testuser' (lowercased) — max_attempts exhausted
		assert.strictEqual(account_limiter.check('testuser').remaining, 0);

		// Next request with any case variant should be rate-limited
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'TestUser', password: 'valid_password_123'}),
		});
		assert.strictEqual(res.status, 429);

		account_limiter.dispose();
	});

	test('email-format login with mixed case shares rate limit bucket', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app} = create_login_app(null, account_limiter);

		// Email-format logins with different casing — all normalize to same key
		await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'Alice@Example.COM', password: 'valid_password_123'}),
		});
		await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'alice@example.com', password: 'valid_password_123'}),
		});

		// Both count against the same lowercased key
		assert.strictEqual(account_limiter.check('alice@example.com').remaining, MAX_ATTEMPTS - 2);

		account_limiter.dispose();
	});

	test('whitespace-padded username normalizes for rate limiting', async () => {
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app} = create_login_app(null, account_limiter);

		// Whitespace-padded username should trim then lowercase
		await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: '  TestUser  ', password: 'valid_password_123'}),
		});

		assert.strictEqual(account_limiter.check('testuser').remaining, MAX_ATTEMPTS - 1);

		account_limiter.dispose();
	});

	test('account enumeration: locking existing vs non-existing username produces identical 429', async () => {
		// Lock out 'testuser' (exists in fake_account)
		const limiter_a = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app: app_a, find_by_username_or_email: find_a} = create_login_app(null, limiter_a);

		// Some requests find account, some don't — lockout behavior should be identical
		find_a.mockResolvedValueOnce(fake_account);
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app_a);
		}
		const res_existing = await login_request(app_a);
		const body_existing = await res_existing.json();

		// Lock out 'testuser' (never exists — default mock returns null)
		const limiter_b = new RateLimiter({
			max_attempts: MAX_ATTEMPTS,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app: app_b} = create_login_app(null, limiter_b);
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app_b);
		}
		const res_nonexisting = await login_request(app_b);
		const body_nonexisting = await res_nonexisting.json();

		// Both 429s must be identical
		assert.strictEqual(res_existing.status, 429);
		assert.strictEqual(res_nonexisting.status, 429);
		assert.deepStrictEqual(Object.keys(body_existing).sort(), ['error', 'retry_after']);
		assert.deepStrictEqual(Object.keys(body_nonexisting).sort(), ['error', 'retry_after']);
		assert.strictEqual(body_existing.error, body_nonexisting.error);

		limiter_a.dispose();
		limiter_b.dispose();
	});

	test('IP and account limiters are independent', async () => {
		const ip_limiter = create_test_limiter();
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS + 2,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const {app} = create_login_app(ip_limiter, account_limiter);

		// Exhaust IP limiter (3 attempts), account limiter still has capacity (5)
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await login_request(app);
		}

		// IP-blocked — short-circuits before account check
		const res = await login_request(app);
		assert.strictEqual(res.status, 429);

		// Account limiter should have recorded the 3 failures
		assert.strictEqual(account_limiter.check('testuser').remaining, 2);

		ip_limiter.dispose();
		account_limiter.dispose();
	});
});

describe('login error response consistency (account enumeration prevention)', () => {
	test('account-not-found and wrong-password produce identical responses', async () => {
		const {app, find_by_username_or_email} = create_login_app(null);

		// Path 1: account not found (find_by_username_or_email returns null by default)
		const no_account = await login_request(app);
		const no_account_body = await no_account.json();

		// Path 2: account found, wrong password
		find_by_username_or_email.mockResolvedValueOnce(fake_account);
		const wrong_pw = await login_request(app);
		const wrong_pw_body = await wrong_pw.json();

		// Status codes must be identical
		assert.strictEqual(no_account.status, 401);
		assert.strictEqual(wrong_pw.status, 401);

		// Response bodies must be byte-identical — different messages enable account enumeration
		assert.deepStrictEqual(no_account_body, wrong_pw_body);

		// Neither should set a session cookie
		assert.strictEqual(no_account.headers.get('Set-Cookie'), null);
		assert.strictEqual(wrong_pw.headers.get('Set-Cookie'), null);
	});

	test('error response contains only generic error field', async () => {
		const {app} = create_login_app(null);

		const res = await login_request(app);
		const body = await res.json();

		// Only an 'error' key — no 'username', 'account', 'reason', or other detail
		assert.deepStrictEqual(Object.keys(body), ['error']);
		assert.strictEqual(body.error, ERROR_INVALID_CREDENTIALS);
	});

	test('account-not-found calls verify_dummy, wrong-password calls verify_password', async () => {
		const {app, find_by_username_or_email, mock_verify_password, mock_verify_dummy} =
			create_login_app(null);

		// Path 1: account not found → verify_dummy called, verify_password not called
		await login_request(app);
		assert.strictEqual(
			mock_verify_dummy.mock.calls.length,
			1,
			'verify_dummy must be called when account not found (timing resistance)',
		);
		assert.strictEqual(
			mock_verify_password.mock.calls.length,
			0,
			'verify_password must not be called when account not found',
		);

		// Path 2: account found, wrong password → verify_password called, verify_dummy not called again
		find_by_username_or_email.mockResolvedValueOnce(fake_account);
		await login_request(app);
		assert.strictEqual(
			mock_verify_password.mock.calls.length,
			1,
			'verify_password must be called when account exists',
		);
		assert.strictEqual(
			mock_verify_dummy.mock.calls.length,
			1,
			'verify_dummy must not be called again when account exists',
		);
	});

	test('email-format and plain username produce identical 401 responses', async () => {
		const {app} = create_login_app(null);

		// Plain username (not found)
		const plain_res = await login_request(app);
		const plain_body = await plain_res.json();

		// Email-format username (not found) — exercises the @-branch in find_by_username_or_email
		const email_res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'user@example.com', password: 'valid_password_123'}),
		});
		const email_body = await email_res.json();

		assert.strictEqual(plain_res.status, 401);
		assert.strictEqual(email_res.status, 401);
		assert.deepStrictEqual(plain_body, email_body);
	});
});

describe('bearer auth rate limiting', () => {
	test('returns 429 when per-IP limit exhausted (invalid tokens)', async () => {
		const limiter = create_test_limiter();
		const {app} = create_bearer_app(limiter);

		// Exhaust the limit with invalid token attempts
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await bearer_request(app);
			assert.strictEqual(res.status, 401);
		}

		// Next request should be rate-limited
		const res = await bearer_request(app);
		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		assert.strictEqual(typeof body.retry_after, 'number');
		assert.ok(body.retry_after > 0);

		limiter.dispose();
	});

	test('blocked request skips token validation (no hash/DB work)', async () => {
		const limiter = create_test_limiter();
		const {app, mock_validate} = create_bearer_app(limiter);

		// Exhaust the limit
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await bearer_request(app);
		}

		const validate_calls = mock_validate.mock.calls.length;

		// Blocked request — rate limit check short-circuits before validate
		const res = await bearer_request(app);
		assert.strictEqual(res.status, 429);
		assert.strictEqual(
			mock_validate.mock.calls.length,
			validate_calls,
			'should not call validate when rate-limited',
		);

		limiter.dispose();
	});

	test('valid token resets rate limit counter', async () => {
		const limiter = create_test_limiter();
		const mock_validate = vi.fn((): Promise<any> => Promise.resolve(undefined));
		const mock_find_by_id = vi.fn((): Promise<any> => Promise.resolve(null));
		mock_validate_api_token.mockReset().mockImplementation(mock_validate);
		mock_account_by_id.mockReset().mockImplementation(mock_find_by_id);
		mock_actor_by_account.mockReset().mockImplementation(() => Promise.resolve({id: 'actor_1'}));
		mock_permit_find_active.mockReset().mockImplementation(() => Promise.resolve([]));

		const bearer_middleware = create_bearer_auth_middleware({db}, limiter, log);

		const app = new Hono();
		app.use('*', test_proxy_middleware);
		app.use('/api/*', bearer_middleware);
		app.get('/api/test', (c) => c.json({ok: true}));

		// Accumulate failures
		await bearer_request(app);
		await bearer_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, 1);

		// Succeed: validate returns a token, account + actor found
		mock_validate.mockResolvedValueOnce({id: 'tok_1', account_id: 'acc_1'});
		mock_find_by_id.mockResolvedValueOnce({id: 'acc_1'});

		const res = await bearer_request(app, 'valid_token');
		assert.strictEqual(res.status, 200);

		// Rate limit fully reset
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS);

		limiter.dispose();
	});

	test('ip_rate_limiter null allows unlimited invalid attempts', async () => {
		const {app} = create_bearer_app(null);

		// Well beyond MAX_ATTEMPTS — should never see 429
		for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
			const res = await bearer_request(app);
			assert.strictEqual(res.status, 401, `request ${i + 1} should be 401, not 429`);
		}
	});

	test('different IPs rate-limited independently', async () => {
		const limiter = create_test_limiter();
		const {app} = create_bearer_app(limiter);

		// Exhaust limit for 10.0.0.1
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await bearer_request(app, 'bad', {'X-Forwarded-For': '10.0.0.1'});
		}

		// 10.0.0.1 blocked
		assert.strictEqual(
			(await bearer_request(app, 'bad', {'X-Forwarded-For': '10.0.0.1'})).status,
			429,
		);

		// 10.0.0.2 unaffected
		assert.strictEqual(
			(await bearer_request(app, 'bad', {'X-Forwarded-For': '10.0.0.2'})).status,
			401,
		);

		limiter.dispose();
	});

	test('429 response shape matches login rate limiting', async () => {
		const limiter = create_test_limiter();
		const {app} = create_bearer_app(limiter);

		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await bearer_request(app);
		}

		const res = await bearer_request(app);
		const body = await res.json();
		assert.deepStrictEqual(Object.keys(body).sort(), ['error', 'retry_after']);
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);

		limiter.dispose();
	});
});

// --- Cookie security tests (GAP-16) ---

describe('session cookie security attributes', () => {
	test('successful login sets cookie with HttpOnly, Secure, SameSite=Strict, Path=/', async () => {
		const {app, find_by_username_or_email, mock_verify_password} = create_login_app(null);
		find_by_username_or_email.mockResolvedValueOnce(fake_account);
		mock_verify_password.mockResolvedValueOnce(true);

		const res = await login_request(app);
		assert.strictEqual(res.status, 200);

		const cookie = res.headers.get('Set-Cookie')!;
		assert.ok(cookie, 'successful login must set a cookie');
		assert.ok(cookie.includes('HttpOnly'), 'cookie must be HttpOnly');
		assert.ok(cookie.includes('Secure'), 'cookie must be Secure');
		assert.ok(cookie.includes('SameSite=Strict'), 'cookie must be SameSite=Strict');
		assert.ok(cookie.includes('Path=/'), 'cookie must have Path=/');
	});

	test('failed login does not set session cookie', async () => {
		const {app} = create_login_app(null);

		const res = await login_request(app);
		assert.strictEqual(res.status, 401);
		assert.strictEqual(res.headers.get('Set-Cookie'), null, 'failed login must not set a cookie');
	});
});

describe('password max length validation', () => {
	const oversized_password = 'a'.repeat(PASSWORD_LENGTH_MAX + 1);

	test('login rejects password exceeding max length', async () => {
		const {app} = create_login_app(null);
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'testuser', password: oversized_password}),
		});
		assert.strictEqual(res.status, 400);
	});

	test('login accepts password at max length', async () => {
		const {app} = create_login_app(null);
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'testuser', password: 'a'.repeat(PASSWORD_LENGTH_MAX)}),
		});
		// 401 (invalid credentials), not 400 — schema accepted it
		assert.strictEqual(res.status, 401);
	});
});

// --- Signup handler rate limiting ---

const create_signup_app = (
	ip_rate_limiter: RateLimiter | null,
	signup_account_rate_limiter: RateLimiter | null = null,
): Hono => {
	// Reset signup-related mocks
	mock_invite_find_unclaimed_match.mockReset().mockImplementation(() => Promise.resolve(null));
	mock_invite_claim.mockReset().mockImplementation(() => Promise.resolve(true));
	mock_create_account_with_actor
		.mockReset()
		.mockImplementation(() => Promise.resolve({account: {id: 'acc_new'}, actor: {id: 'act_new'}}));
	mock_session_create.mockReset().mockImplementation(() => Promise.resolve());
	mock_session_enforce_limit.mockReset().mockImplementation(() => Promise.resolve(0));

	const route_specs = create_signup_route_specs(
		{
			log,
			keyring,
			password: {
				hash_password: vi.fn().mockResolvedValue('hashed_pw'),
				verify_password: vi.fn(),
				verify_dummy: vi.fn(),
			},
			stat: noop,
			read_file: noop,
			delete_file: noop,
			on_audit_event: () => {},
		},
		{
			session_options,
			ip_rate_limiter,
			signup_account_rate_limiter,
			app_settings: {open_signup: false, updated_at: null, updated_by: null},
		},
	);

	const app = new Hono();
	app.use('*', async (c, next) => {
		c.set('pending_effects', []);
		await next();
	});
	app.use('*', test_proxy_middleware);
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

	return app;
};

const signup_request = (
	app: Hono,
	username = 'newuser',
	headers?: Record<string, string>,
): Response | Promise<Response> =>
	app.request('/signup', {
		method: 'POST',
		headers: {'Content-Type': 'application/json', ...headers},
		body: JSON.stringify({username, password: 'securepassword123'}),
	});

describe('signup handler per-account rate limiting', () => {
	test('returns 429 when per-account limit exhausted', async () => {
		const account_limiter = create_test_limiter();
		const app = create_signup_app(null, account_limiter);

		// No invite match → 403, but records against account limiter
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await signup_request(app);
			assert.strictEqual(res.status, 403);
		}

		// Next request should be rate-limited by account
		const res = await signup_request(app);
		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);

		account_limiter.dispose();
	});

	test('exhausting limit for one username does not block a different username', async () => {
		const account_limiter = create_test_limiter();
		const app = create_signup_app(null, account_limiter);

		// Exhaust limit for 'newuser'
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await signup_request(app);
		}

		// 'newuser' blocked
		assert.strictEqual((await signup_request(app)).status, 429);

		// Different username is unaffected
		const res = await signup_request(app, 'otheruser');
		assert.strictEqual(res.status, 403);

		account_limiter.dispose();
	});

	test('success resets the per-account limiter', async () => {
		const account_limiter = create_test_limiter();
		const app = create_signup_app(null, account_limiter);

		// Accumulate failures
		await signup_request(app);
		await signup_request(app);
		assert.strictEqual(account_limiter.check('newuser').remaining, MAX_ATTEMPTS - 2);

		// Make signup succeed: invite found + claim succeeds
		mock_invite_find_unclaimed_match.mockResolvedValueOnce({id: 'inv_1'});
		mock_invite_claim.mockResolvedValueOnce(true);

		const res = await signup_request(app);
		assert.strictEqual(res.status, 200);

		// Per-account counter fully reset
		assert.strictEqual(account_limiter.check('newuser').remaining, MAX_ATTEMPTS);

		account_limiter.dispose();
	});

	test('case variants share the same signup rate limit bucket', async () => {
		const account_limiter = create_test_limiter();
		const app = create_signup_app(null, account_limiter);

		// Mixed-case usernames should all count against the same lowercased key
		await signup_request(app, 'NewUser');
		await signup_request(app, 'NEWUSER');
		await signup_request(app, 'newuser');

		// All 3 count against 'newuser' (lowercased) — max_attempts exhausted
		assert.strictEqual(account_limiter.check('newuser').remaining, 0);

		// Next request with any case variant should be rate-limited
		const res = await signup_request(app, 'NewUser');
		assert.strictEqual(res.status, 429);

		account_limiter.dispose();
	});

	test('IP and account limiters are independent', async () => {
		const ip_limiter = create_test_limiter();
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS + 2,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0,
		});
		const app = create_signup_app(ip_limiter, account_limiter);

		// Exhaust IP limiter (3 attempts), account limiter still has capacity (5)
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await signup_request(app);
		}

		// IP-blocked — short-circuits before account check
		const res = await signup_request(app);
		assert.strictEqual(res.status, 429);

		// Account limiter should NOT have recorded the 3 failures (IP check is first,
		// but failures after input parsing do record on both)
		// The 3 failed attempts reached the invite check (past IP check), so both recorded
		assert.strictEqual(account_limiter.check('newuser').remaining, 2);

		ip_limiter.dispose();
		account_limiter.dispose();
	});
});
