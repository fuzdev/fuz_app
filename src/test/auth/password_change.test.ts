/**
 * Integration tests for the `POST /password` endpoint.
 *
 * Verifies the password change handler correctly verifies the current password,
 * hashes the new one, updates the account, revokes all sessions, clears the
 * session cookie, and integrates with the per-IP rate limiter.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';
import { Hono } from 'hono';

import { RateLimiter } from '$lib/rate_limiter.ts';
import { create_proxy_middleware } from '$lib/http/proxy.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { REQUEST_CONTEXT_KEY, type RequestContext } from '$lib/auth/request_context.ts';
import { ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY, TEST_CONTEXT_PRESET_KEY } from '$lib/hono_context.ts';
import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { apply_route_specs } from '$lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '$lib/auth/auth_guard_resolver.ts';
import { create_keyring } from '$lib/auth/keyring.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { PASSWORD_LENGTH_MIN, PASSWORD_LENGTH_MAX } from '$lib/auth/password.ts';
import { ERROR_RATE_LIMIT_EXCEEDED, ERROR_INVALID_CREDENTIALS } from '$lib/http/error_schemas.ts';
import { create_stub_db, create_noop_stub, create_test_audit_emitter } from '$lib/testing/stubs.ts';
import { create_recording_audit_emitter } from '$lib/testing/audit_drift_guard.ts';
import type { ConnectionCloser } from '$lib/actions/connection_closer.ts';
import type { AuditLogInput } from '$lib/auth/audit_log_schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

const log = new Logger('test', { level: 'off' });

// --- Mock module-level query functions ---
const { mock_update_password, mock_revoke_all, mock_revoke_all_tokens } = vi.hoisted(() => ({
	mock_update_password: vi.fn(() => Promise.resolve(true)),
	mock_revoke_all: vi.fn(() => Promise.resolve(0)),
	mock_revoke_all_tokens: vi.fn(() => Promise.resolve(0))
}));

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_username_or_email: vi.fn(),
	query_update_account_password: mock_update_password,
	query_account_by_id: vi.fn(),
	query_actor_by_id: vi.fn(),
	query_active_actors_by_account: vi.fn(() => Promise.resolve([]))
}));

vi.mock('$lib/auth/session_queries.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/auth/session_queries.ts')>();
	return {
		...actual,
		query_create_session: vi.fn(() => Promise.resolve()),
		query_session_enforce_limit: vi.fn(() => Promise.resolve(0)),
		query_session_revoke_all_for_account: mock_revoke_all
	};
});

vi.mock('$lib/auth/api_token_queries.js', () => ({
	query_create_api_token: vi.fn(() => Promise.resolve()),
	query_api_token_enforce_limit: vi.fn(() => Promise.resolve()),
	query_revoke_api_token_for_account: vi.fn(() => Promise.resolve(true)),
	query_api_token_list_for_account: vi.fn(() => Promise.resolve([])),
	query_revoke_all_api_tokens_for_account: mock_revoke_all_tokens,
	query_validate_api_token: vi.fn(() => Promise.resolve(undefined))
}));

// Audit fan-out is intercepted via the bound `audit` slot on the deps
// factory below (a `create_test_audit_emitter()` no-op).

vi.mock('$lib/auth/role_grant_queries.js', () => ({
	query_role_grant_find_active_for_actor: vi.fn(() => Promise.resolve([]))
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
	get_connection_ip: () => TEST_CONNECTION_IP
});

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 3;

const create_test_limiter = (): RateLimiter =>
	new RateLimiter({ max_attempts: MAX_ATTEMPTS, window_ms: WINDOW_MS, cleanup_interval_ms: 0 });

const keyring = create_keyring('integration_test_key_a')!;
const session_options = create_session_config('test_session');

const db = create_stub_db();
const noop = create_noop_stub('deps');

const fake_account = {
	id: 'acc_test' as Uuid,
	username: 'testuser',
	email: null,
	email_verified: false,
	password_hash: 'fake_hash',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: '2025-01-01T00:00:00.000Z',
	created_by: null,
	updated_by: null,
	deleted_at: null,
	deleted_by: null
};

const fake_actor = {
	id: 'act_test' as Uuid,
	account_id: 'acc_test' as Uuid,
	name: 'testuser',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: null,
	updated_by: null,
	deleted_at: null,
	deleted_by: null
};

const fake_ctx: RequestContext = {
	account: fake_account,
	actor: fake_actor,
	role_grants: []
};

// --- Test app factory ---

interface PasswordChangeTestApp {
	app: Hono;
	mock_verify_password: ReturnType<typeof vi.fn>;
	mock_hash_password: ReturnType<typeof vi.fn>;
	mock_update_password: ReturnType<typeof vi.fn>;
	mock_revoke_all: ReturnType<typeof vi.fn>;
	mock_revoke_all_tokens: ReturnType<typeof vi.fn>;
}

const create_password_change_app = (
	ip_rate_limiter: RateLimiter | null,
	login_account_rate_limiter: RateLimiter | null = null,
	connection_closer: ConnectionCloser | null = null,
	audit_events: Array<AuditLogInput> | null = null
): PasswordChangeTestApp => {
	const mock_verify_password = vi.fn(() => Promise.resolve(false));
	const mock_hash_password = vi.fn(() => Promise.resolve('new_hashed_password'));
	// Reset module-level mocks for each app creation
	mock_update_password.mockReset().mockImplementation(() => Promise.resolve(true));
	mock_revoke_all.mockReset().mockImplementation(() => Promise.resolve(0));
	mock_revoke_all_tokens.mockReset().mockImplementation(() => Promise.resolve(0));

	// When the caller passes an `audit_events` array, wire a recording
	// emitter that appends every `emit` / `emit_pool` call into it (the
	// helper's `calls_ref` form writes into the caller-owned array so
	// the test's existing `.filter` / index access reads work unchanged).
	// Otherwise use the no-op test emitter.
	const audit = audit_events
		? create_recording_audit_emitter(audit_events).emitter
		: create_test_audit_emitter();

	const route_specs = create_account_route_specs(
		{
			log,
			keyring,
			password: {
				hash_password: mock_hash_password,
				verify_password: mock_verify_password,
				verify_dummy: vi.fn(() => Promise.resolve(false))
			},
			stat: noop,
			read_text_file: noop,
			delete_file: noop,
			audit
		},
		{
			session_options,
			ip_rate_limiter,
			login_account_rate_limiter,
			login_fail_floor_ms: 0,
			connection_closer
		}
	);

	const app = new Hono();
	app.use('*', test_proxy_middleware);

	// inject authenticated request context before route guards
	app.use('/*', async (c, next) => {
		c.set(ACCOUNT_ID_KEY, fake_ctx.account.id);
		c.set(REQUEST_CONTEXT_KEY, fake_ctx);
		c.set(TEST_CONTEXT_PRESET_KEY, true);
		c.set(CREDENTIAL_TYPE_KEY, 'session');
		await next();
	});

	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

	return {
		app,
		mock_verify_password,
		mock_hash_password,
		mock_update_password,
		mock_revoke_all,
		mock_revoke_all_tokens
	};
};

const valid_new_password = 'a'.repeat(PASSWORD_LENGTH_MIN);

const password_change_request = (
	app: Hono,
	body?: Record<string, unknown>,
	headers?: Record<string, string>
): Response | Promise<Response> =>
	app.request('/password', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(
			body ?? { current_password: 'old_password_123', new_password: valid_new_password }
		)
	});

// --- Tests ---

afterEach(() => {
	vi.clearAllMocks();
});

describe('password change handler', () => {
	test('successful change updates password, revokes sessions, clears cookie', async () => {
		const { app, mock_verify_password, mock_hash_password, mock_update_password, mock_revoke_all } =
			create_password_change_app(null);

		mock_verify_password.mockResolvedValueOnce(true);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.deepStrictEqual(body, { ok: true, sessions_revoked: 0, tokens_revoked: 0 });

		// verify current password was checked against account hash
		assert.strictEqual(mock_verify_password.mock.calls.length, 1);
		assert.strictEqual(mock_verify_password.mock.calls[0]![0], 'old_password_123');
		assert.strictEqual(mock_verify_password.mock.calls[0]![1], 'fake_hash');

		// new password was hashed
		assert.strictEqual(mock_hash_password.mock.calls.length, 1);
		assert.strictEqual(mock_hash_password.mock.calls[0]![0], valid_new_password);

		// account was updated with (deps, account_id, password_hash, updated_by, expected_hash)
		// `password_change` is account-grain — `updated_by` stays null per the
		// audit-actor rule (the operation is performed by the account; the
		// actor resolved by middleware is incidental under v1 1:1 and is not
		// required at all under multi-actor). `expected_hash` is the verify-
		// write atomic guard — passes the same hash the verify ran against so
		// the SQL UPDATE refuses to land if a concurrent change already moved
		// the row.
		assert.strictEqual(mock_update_password.mock.calls.length, 1);
		const [_deps, account_id, hash, updated_by, expected_hash] =
			mock_update_password.mock.calls[0]!;
		assert.strictEqual(account_id, 'acc_test');
		assert.strictEqual(hash, 'new_hashed_password');
		assert.strictEqual(updated_by, null);
		assert.strictEqual(expected_hash, 'fake_hash');

		// all sessions revoked with (deps, account_id)
		assert.strictEqual(mock_revoke_all.mock.calls.length, 1);
		const [_revoke_deps, revoke_account_id] = mock_revoke_all.mock.calls[0]!;
		assert.strictEqual(revoke_account_id, 'acc_test');

		// session cookie cleared
		const cookie = res.headers.get('Set-Cookie');
		assert.ok(cookie, 'should set cookie header to clear session');
		assert.ok(cookie.includes('test_session='), 'should reference session cookie name');
	});

	test('sessions_revoked reflects actual count', async () => {
		const { app, mock_verify_password, mock_revoke_all } = create_password_change_app(null);

		mock_verify_password.mockResolvedValueOnce(true);
		mock_revoke_all.mockResolvedValueOnce(3);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.sessions_revoked, 3);
		assert.strictEqual(body.tokens_revoked, 0);
	});

	test('tokens_revoked reflects actual count', async () => {
		const { app, mock_verify_password, mock_revoke_all_tokens } = create_password_change_app(null);

		mock_verify_password.mockResolvedValueOnce(true);
		mock_revoke_all_tokens.mockResolvedValueOnce(5);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.tokens_revoked, 5);
	});

	test('wrong current password returns 401 and does not update', async () => {
		const { app, mock_verify_password, mock_hash_password, mock_update_password, mock_revoke_all } =
			create_password_change_app(null);

		mock_verify_password.mockResolvedValueOnce(false);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 401);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INVALID_CREDENTIALS);

		// password NOT hashed, account NOT updated, sessions NOT revoked
		assert.strictEqual(mock_hash_password.mock.calls.length, 0);
		assert.strictEqual(mock_update_password.mock.calls.length, 0);
		assert.strictEqual(mock_revoke_all.mock.calls.length, 0);
	});

	test('error response contains only error field', async () => {
		const { app, mock_verify_password } = create_password_change_app(null);
		mock_verify_password.mockResolvedValueOnce(false);

		const res = await password_change_request(app);
		const body = await res.json();
		assert.deepStrictEqual(Object.keys(body), ['error']);
	});

	test('failed password change does not set session cookie', async () => {
		const { app } = create_password_change_app(null);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 401);
		assert.strictEqual(
			res.headers.get('Set-Cookie'),
			null,
			'failed password change must not set a cookie'
		);
	});
});

describe('password change input validation', () => {
	test('new password below minimum length returns 400', async () => {
		const { app } = create_password_change_app(null);
		const res = await password_change_request(app, {
			current_password: 'old_password_123',
			new_password: 'a'.repeat(PASSWORD_LENGTH_MIN - 1)
		});
		assert.strictEqual(res.status, 400);
	});

	test('new password at minimum length is accepted', async () => {
		const { app, mock_verify_password } = create_password_change_app(null);
		mock_verify_password.mockResolvedValueOnce(false);

		const res = await password_change_request(app, {
			current_password: 'old_password_123',
			new_password: 'a'.repeat(PASSWORD_LENGTH_MIN)
		});
		// 401 (wrong password), not 400 — schema accepted it
		assert.strictEqual(res.status, 401);
	});

	test('new password exceeding max length returns 400', async () => {
		const { app } = create_password_change_app(null);
		const res = await password_change_request(app, {
			current_password: 'old_password_123',
			new_password: 'a'.repeat(PASSWORD_LENGTH_MAX + 1)
		});
		assert.strictEqual(res.status, 400);
	});

	test('current password exceeding max length returns 400', async () => {
		const { app } = create_password_change_app(null);
		const res = await password_change_request(app, {
			current_password: 'a'.repeat(PASSWORD_LENGTH_MAX + 1),
			new_password: valid_new_password
		});
		assert.strictEqual(res.status, 400);
	});

	test('empty current password returns 400', async () => {
		const { app } = create_password_change_app(null);
		const res = await password_change_request(app, {
			current_password: '',
			new_password: valid_new_password
		});
		assert.strictEqual(res.status, 400);
	});

	test('missing fields returns 400', async () => {
		const { app } = create_password_change_app(null);
		const res = await password_change_request(app, {});
		assert.strictEqual(res.status, 400);
	});

	test('unknown fields rejected (strictObject)', async () => {
		const { app } = create_password_change_app(null);
		const res = await password_change_request(app, {
			current_password: 'old_password_123',
			new_password: valid_new_password,
			extra_field: 'should be rejected'
		});
		assert.strictEqual(res.status, 400);
	});
});

describe('password change rate limiting', () => {
	test('returns 429 when per-IP limit exhausted', async () => {
		const limiter = create_test_limiter();
		const { app, mock_verify_password } = create_password_change_app(limiter);

		// exhaust the limit with wrong-password attempts
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await password_change_request(app);
			assert.strictEqual(res.status, 401);
		}

		// next request should be rate-limited
		const res = await password_change_request(app);
		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		assert.strictEqual(typeof body.retry_after, 'number');
		assert.ok(body.retry_after > 0);

		// verify no password work was done on the blocked request
		assert.strictEqual(mock_verify_password.mock.calls.length, MAX_ATTEMPTS);

		limiter.dispose();
	});

	test('blocked request skips password verification', async () => {
		const limiter = create_test_limiter();
		const { app, mock_verify_password } = create_password_change_app(limiter);

		// exhaust the limit
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await password_change_request(app);
		}

		const pw_calls = mock_verify_password.mock.calls.length;

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 429);
		assert.strictEqual(
			mock_verify_password.mock.calls.length,
			pw_calls,
			'should not verify password when rate-limited'
		);

		limiter.dispose();
	});

	test('failed password change records an attempt', async () => {
		const limiter = create_test_limiter();
		const { app } = create_password_change_app(limiter);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 401);

		// IP is the test connection IP (no X-Forwarded-For) — one attempt consumed
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS - 1);

		limiter.dispose();
	});

	test('successful password change resets rate limit counter', async () => {
		const limiter = create_test_limiter();
		const { app, mock_verify_password } = create_password_change_app(limiter);

		// accumulate failures
		await password_change_request(app);
		await password_change_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, 1);

		// succeed
		mock_verify_password.mockResolvedValueOnce(true);
		const res = await password_change_request(app);
		assert.strictEqual(res.status, 200);

		// rate limit fully reset
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS);

		limiter.dispose();
	});

	test('ip_rate_limiter null allows unlimited failed attempts', async () => {
		const { app } = create_password_change_app(null);

		// well beyond MAX_ATTEMPTS — should never see 429
		for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
			const res = await password_change_request(app);
			assert.strictEqual(res.status, 401, `request ${i + 1} should be 401, not 429`);
		}
	});

	test('429 response contains only error and retry_after', async () => {
		const limiter = create_test_limiter();
		const { app } = create_password_change_app(limiter);

		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await password_change_request(app);
		}

		const res = await password_change_request(app);
		const body = await res.json();
		assert.deepStrictEqual(Object.keys(body).sort(), ['error', 'retry_after']);
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);

		limiter.dispose();
	});

	test('X-Forwarded-For determines rate limit bucket', async () => {
		const limiter = create_test_limiter();
		const { app } = create_password_change_app(limiter);

		// exhaust limit for 10.0.0.1
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await password_change_request(app, undefined, { 'X-Forwarded-For': '10.0.0.1' });
		}

		// 10.0.0.1 blocked
		assert.strictEqual(
			(await password_change_request(app, undefined, { 'X-Forwarded-For': '10.0.0.1' })).status,
			429
		);

		// 10.0.0.2 unaffected
		assert.strictEqual(
			(await password_change_request(app, undefined, { 'X-Forwarded-For': '10.0.0.2' })).status,
			401
		);

		limiter.dispose();
	});
});

describe('password change per-account rate limiting', () => {
	test('returns 429 when per-account limit exhausted', async () => {
		const account_limiter = create_test_limiter();
		const { app } = create_password_change_app(null, account_limiter);

		// exhaust the per-account limit with wrong-password attempts
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await password_change_request(app);
			assert.strictEqual(res.status, 401);
		}

		// next request should be rate-limited by account
		const res = await password_change_request(app);
		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		assert.strictEqual(typeof body.retry_after, 'number');
		assert.ok(body.retry_after > 0);

		account_limiter.dispose();
	});

	test('wrong current password records against per-account limiter', async () => {
		const account_limiter = create_test_limiter();
		const { app } = create_password_change_app(null, account_limiter);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 401);

		// account ID is the rate limit key — one attempt consumed
		assert.strictEqual(account_limiter.check(fake_account.id).remaining, MAX_ATTEMPTS - 1);

		account_limiter.dispose();
	});

	test('successful password change resets per-account limiter', async () => {
		const account_limiter = create_test_limiter();
		const { app, mock_verify_password } = create_password_change_app(null, account_limiter);

		// accumulate failures
		await password_change_request(app);
		await password_change_request(app);
		assert.strictEqual(account_limiter.check(fake_account.id).remaining, 1);

		// succeed
		mock_verify_password.mockResolvedValueOnce(true);
		const res = await password_change_request(app);
		assert.strictEqual(res.status, 200);

		// per-account counter fully reset
		assert.strictEqual(account_limiter.check(fake_account.id).remaining, MAX_ATTEMPTS);

		account_limiter.dispose();
	});

	test('IP and account limiters are independent', async () => {
		const ip_limiter = create_test_limiter();
		const account_limiter = new RateLimiter({
			max_attempts: MAX_ATTEMPTS + 2,
			window_ms: WINDOW_MS,
			cleanup_interval_ms: 0
		});
		const { app } = create_password_change_app(ip_limiter, account_limiter);

		// exhaust IP limiter (3 attempts), account limiter still has capacity (5)
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await password_change_request(app);
		}

		// IP-blocked — short-circuits before account check
		const res = await password_change_request(app);
		assert.strictEqual(res.status, 429);

		// account limiter should have recorded the 3 failures (they passed IP check)
		assert.strictEqual(account_limiter.check(fake_account.id).remaining, 2);

		ip_limiter.dispose();
		account_limiter.dispose();
	});

	test('blocked per-account request skips password verification', async () => {
		const account_limiter = create_test_limiter();
		const { app, mock_verify_password } = create_password_change_app(null, account_limiter);

		// exhaust the limit
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await password_change_request(app);
		}

		const pw_calls = mock_verify_password.mock.calls.length;

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 429);
		assert.strictEqual(
			mock_verify_password.mock.calls.length,
			pw_calls,
			'should not verify password when account rate-limited'
		);

		account_limiter.dispose();
	});

	test('login_account_rate_limiter null allows unlimited failed attempts', async () => {
		const { app } = create_password_change_app(null, null);

		// well beyond MAX_ATTEMPTS — should never see 429
		for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
			const res = await password_change_request(app);
			assert.strictEqual(res.status, 401, `request ${i + 1} should be 401, not 429`);
		}
	});
});

describe('password change connection_closer wiring', () => {
	// These tests pin the contract that the closer fires on the success path
	// only — wrong-password (401) and concurrent-change (401) both early-return
	// BEFORE the close. The DB-backed wrong-password coverage lives in
	// connection_closer.db.test.ts; this block adds the concurrent-change
	// branch, which requires `query_update_account_password` to return false
	// and is not reachable from an integration test without injecting a hook
	// between auth-load and update. Mocking the query at the module boundary
	// is the simplest path.
	//
	// Safety/security framing: a refactor that lifted the eager close above
	// the `if (!updated)` early-return would silently disconnect the caller's
	// live WS sockets on every concurrent-change 401 (a flapping
	// re-authentication path under contention), violating the listener-only
	// invariant the failure-outcome guard is supposed to preserve.

	test('does NOT close on concurrent-change 401 (update returned false)', async () => {
		const calls: Array<{ method: string; id: string }> = [];
		const closer: ConnectionCloser = {
			close_sockets_for_session: (id) => {
				calls.push({ method: 'session', id });
				return 1;
			},
			close_sockets_for_token: (id) => {
				calls.push({ method: 'token', id });
				return 1;
			},
			close_sockets_for_account: (id) => {
				calls.push({ method: 'account', id });
				return 1;
			}
		};
		const audit_events: Array<AuditLogInput> = [];
		const { app, mock_verify_password } = create_password_change_app(
			null,
			null,
			closer,
			audit_events
		);

		// Verify succeeds — caller passed the right current_password —
		// but the conditional UPDATE finds the row's hash has moved
		// (concurrent change committed first).
		mock_verify_password.mockResolvedValueOnce(true);
		mock_update_password.mockReset().mockResolvedValueOnce(false);

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 401);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INVALID_CREDENTIALS);

		assert.strictEqual(
			calls.length,
			0,
			'closer must not fire on concurrent-change 401 — handler early-returns before the close site'
		);

		// Pin the audit row shape: a `password_change` failure with
		// `reason: 'concurrent_change'` is the only signal an admin reading
		// the audit log has to distinguish "user typoed" from "two clients
		// raced." The schema in `audit_log_schema.ts` declares this as a
		// closed `z.enum(['concurrent_change'])` — any other reason value
		// would also trip metadata validation in production. Pin both the
		// handler-to-schema choice and the defense-in-depth credential_type.
		const failure_audits = audit_events.filter(
			(e) => e.event_type === 'password_change' && e.outcome === 'failure'
		);
		assert.strictEqual(failure_audits.length, 1, 'one password_change failure audit row');
		const meta = failure_audits[0]!.metadata as {
			reason?: string;
			credential_type?: string;
		};
		assert.strictEqual(meta.reason, 'concurrent_change');
		assert.strictEqual(meta.credential_type, 'session');
	});

	test('fires close_sockets_for_account on the success path', async () => {
		// Mirror assertion to the negative test above — the same closer
		// stub on a happy-path call DOES record an account-wide close,
		// closing the "is the closer wired at all?" alternative explanation
		// for the no-close result above. Without this, a regression that
		// dropped the success-path close entirely would also pass the
		// concurrent-change test.
		const calls: Array<{ method: string; id: string }> = [];
		const closer: ConnectionCloser = {
			close_sockets_for_session: (id) => {
				calls.push({ method: 'session', id });
				return 1;
			},
			close_sockets_for_token: (id) => {
				calls.push({ method: 'token', id });
				return 1;
			},
			close_sockets_for_account: (id) => {
				calls.push({ method: 'account', id });
				return 1;
			}
		};
		const { app, mock_verify_password } = create_password_change_app(null, null, closer);
		mock_verify_password.mockResolvedValueOnce(true);
		// default mock_update_password resolution is `true` (success)

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 200);

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0], { method: 'account', id: fake_account.id });
	});

	test('does NOT close on per-IP rate-limit 429', async () => {
		// Pins the contract that the closer never fires when the request is
		// rate-limited. A refactor that moved the eager close above the
		// rate-limit gate would silently disconnect the caller's live WS
		// sockets on every blocked request — the opposite of what rate
		// limiting is supposed to do (it would amplify churn under attack).
		const calls: Array<{ method: string; id: string }> = [];
		const closer: ConnectionCloser = {
			close_sockets_for_session: (id) => {
				calls.push({ method: 'session', id });
				return 1;
			},
			close_sockets_for_token: (id) => {
				calls.push({ method: 'token', id });
				return 1;
			},
			close_sockets_for_account: (id) => {
				calls.push({ method: 'account', id });
				return 1;
			}
		};
		const limiter = create_test_limiter();
		const { app } = create_password_change_app(limiter, null, closer);

		// Exhaust the IP limit with wrong-password attempts. Each failure
		// records against the limiter but must NOT fire the eager close
		// (those are 401, not the success path).
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await password_change_request(app);
			assert.strictEqual(res.status, 401);
		}
		assert.strictEqual(calls.length, 0, 'closer must not fire on any 401 in the warmup');

		// The next request hits the limiter — 429 before any auth/password work.
		const res = await password_change_request(app);
		assert.strictEqual(res.status, 429);
		assert.strictEqual(
			calls.length,
			0,
			'closer must not fire on 429 — rate-limited requests skip every side effect'
		);

		limiter.dispose();
	});

	test('does NOT close on per-account rate-limit 429', async () => {
		// Companion to the per-IP test above — the per-account limiter
		// runs after request-context resolution, so it's a separate gate
		// and a separate refactor target. Same contract on both gates.
		const calls: Array<{ method: string; id: string }> = [];
		const closer: ConnectionCloser = {
			close_sockets_for_session: (id) => {
				calls.push({ method: 'session', id });
				return 1;
			},
			close_sockets_for_token: (id) => {
				calls.push({ method: 'token', id });
				return 1;
			},
			close_sockets_for_account: (id) => {
				calls.push({ method: 'account', id });
				return 1;
			}
		};
		const account_limiter = create_test_limiter();
		const { app } = create_password_change_app(null, account_limiter, closer);

		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await password_change_request(app);
			assert.strictEqual(res.status, 401);
		}
		assert.strictEqual(calls.length, 0, 'closer must not fire on any 401 in the warmup');

		const res = await password_change_request(app);
		assert.strictEqual(res.status, 429);
		assert.strictEqual(calls.length, 0, 'closer must not fire on per-account 429');

		account_limiter.dispose();
	});
});
