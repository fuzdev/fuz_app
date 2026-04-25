/**
 * Integration tests for audit log instrumentation and admin observability routes.
 *
 * Verifies that auth mutation handlers create correct audit log entries via
 * `audit_log_fire_and_forget`, and that the admin read routes return expected data.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach, beforeEach} from 'vitest';
import {Hono} from 'hono';

import {REQUEST_CONTEXT_KEY, type RequestContext} from '$lib/auth/request_context.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {RateLimiter} from '$lib/rate_limiter.js';
import {create_proxy_middleware} from '$lib/http/proxy.js';
import type {AuditLogInput} from '$lib/auth/audit_log_schema.js';
import type {Uuid} from '$lib/uuid.js';
import {create_stub_db, create_noop_stub} from '$lib/testing/stubs.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

const log = new Logger('test', {level: 'off'});

// --- Mock module-level query functions ---
const {
	mock_find_by_username_or_email,
	mock_update_password,
	mock_session_create,
	mock_session_enforce_limit,
	mock_session_revoke,
	mock_session_revoke_all,
	mock_session_revoke_for_account,
	mock_session_list_for_account,
	mock_session_list_all_active,
	mock_api_token_create,
	mock_api_token_enforce_limit,
	mock_api_token_revoke_for_account,
	mock_api_token_list_for_account,
	mock_audit_log,
	mock_audit_log_list,
	mock_audit_log_list_with_usernames,
	mock_audit_log_list_permit_history,
	mock_audit_log_fire_and_forget,
} = vi.hoisted(() => ({
	mock_find_by_username_or_email: vi.fn(
		(..._args: Array<any>): Promise<any> => Promise.resolve(undefined),
	),
	mock_update_password: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_session_create: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_session_enforce_limit: vi.fn((..._args: Array<any>) => Promise.resolve(0)),
	mock_session_revoke: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_session_revoke_all: vi.fn((..._args: Array<any>) => Promise.resolve(2)),
	mock_session_revoke_for_account: vi.fn((..._args: Array<any>) => Promise.resolve(true)),
	mock_session_list_for_account: vi.fn((..._args: Array<any>) => Promise.resolve([] as Array<any>)),
	mock_session_list_all_active: vi.fn((..._args: Array<any>) => Promise.resolve([] as Array<any>)),
	mock_api_token_create: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_api_token_enforce_limit: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_api_token_revoke_for_account: vi.fn((..._args: Array<any>) => Promise.resolve(true)),
	mock_api_token_list_for_account: vi.fn((..._args: Array<any>) =>
		Promise.resolve([] as Array<any>),
	),
	mock_audit_log: vi.fn((..._args: Array<any>) => Promise.resolve()),
	mock_audit_log_list: vi.fn((..._args: Array<any>) => Promise.resolve([] as Array<any>)),
	mock_audit_log_list_with_usernames: vi.fn((..._args: Array<any>) =>
		Promise.resolve([] as Array<any>),
	),
	mock_audit_log_list_permit_history: vi.fn((..._args: Array<any>) =>
		Promise.resolve([] as Array<any>),
	),
	mock_audit_log_fire_and_forget: vi.fn((..._args: Array<any>) => Promise.resolve()),
}));

// Collect audit_log_fire_and_forget calls
let audit_log_calls: Array<AuditLogInput> = [];
mock_audit_log_fire_and_forget.mockImplementation((_deps: any, input: AuditLogInput) => {
	audit_log_calls.push(input);
	return Promise.resolve();
});

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_username_or_email: mock_find_by_username_or_email,
	query_update_account_password: mock_update_password,
	query_admin_account_list: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/auth/session_queries.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/auth/session_queries.js')>();
	return {
		...actual,
		query_create_session: mock_session_create,
		query_session_enforce_limit: mock_session_enforce_limit,
		query_session_revoke_by_hash_unscoped: mock_session_revoke,
		query_session_revoke_all_for_account: mock_session_revoke_all,
		query_session_revoke_for_account: mock_session_revoke_for_account,
		query_session_list_for_account: mock_session_list_for_account,
		query_session_list_all_active: mock_session_list_all_active,
	};
});

vi.mock('$lib/auth/api_token_queries.js', () => ({
	query_create_api_token: mock_api_token_create,
	query_api_token_enforce_limit: mock_api_token_enforce_limit,
	query_api_token_list_for_account: mock_api_token_list_for_account,
	query_revoke_api_token_for_account: mock_api_token_revoke_for_account,
	query_revoke_all_api_tokens_for_account: vi.fn(() => Promise.resolve(0)),
	query_validate_api_token: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('$lib/auth/audit_log_queries.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/auth/audit_log_queries.js')>();
	return {
		...actual,
		query_audit_log: mock_audit_log,
		query_audit_log_list: mock_audit_log_list,
		query_audit_log_list_with_usernames: mock_audit_log_list_with_usernames,
		query_audit_log_list_permit_history: mock_audit_log_list_permit_history,
		audit_log_fire_and_forget: mock_audit_log_fire_and_forget,
	};
});

// --- Shared fixtures ---

const ACC_TEST = '00000000-0000-4000-8000-000000000001' as Uuid;
const ACT_TEST = '00000000-0000-4000-8000-000000000002' as Uuid;

const keyring = create_keyring('audit_integration_test_key')!;
const session_options = create_session_config('test_session');

/** Simulated connection IP for test requests. */
const TEST_CONNECTION_IP = '127.0.0.1';

const db = create_stub_db();
const noop = create_noop_stub('deps');

const fake_account = {
	id: ACC_TEST,
	username: 'testuser',
	email: null,
	email_verified: false,
	password_hash: 'fake_hash',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: '2025-01-01T00:00:00.000Z',
	created_by: null,
	updated_by: null,
};

const fake_actor = {
	id: ACT_TEST,
	account_id: ACC_TEST,
	name: 'testuser',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: null,
	updated_by: null,
};

const fake_ctx: RequestContext = {
	account: fake_account,
	actor: fake_actor,
	permits: [],
};

/**
 * Proxy middleware for tests: trusts the simulated connection IP
 * so that `get_client_ip(c)` returns a real value.
 */
const test_proxy_middleware = create_proxy_middleware({
	trusted_proxies: [TEST_CONNECTION_IP],
	get_connection_ip: () => TEST_CONNECTION_IP,
});

// --- Tests ---

beforeEach(() => {
	mock_audit_log_fire_and_forget.mockImplementation((_deps: any, input: AuditLogInput) => {
		audit_log_calls.push(input);
		return Promise.resolve();
	});
});

afterEach(() => {
	vi.clearAllMocks();
	audit_log_calls = [];
});

describe('account route audit logging', () => {
	beforeEach(() => {
		mock_find_by_username_or_email.mockImplementation(() => Promise.resolve(fake_account));
		mock_session_revoke_for_account.mockImplementation(() => Promise.resolve(true));
		mock_session_revoke_all.mockImplementation(() => Promise.resolve(2));
		audit_log_calls = [];
	});

	const create_account_test_app = (options?: {
		find_account?: ReturnType<typeof vi.fn>;
		verify_password?: ReturnType<typeof vi.fn>;
		inject_ctx?: RequestContext;
		ip_rate_limiter?: RateLimiter | null;
	}): Hono => {
		if (options?.find_account) {
			mock_find_by_username_or_email.mockImplementation(options.find_account as any);
		}
		const verify_password = options?.verify_password ?? vi.fn(() => Promise.resolve(true));

		const route_specs = create_account_route_specs(
			{
				log,
				keyring,
				password: {
					hash_password: vi.fn(() => Promise.resolve('new_hash')),
					verify_password,
					verify_dummy: vi.fn(() => Promise.resolve(false)),
				} as any,
				stat: noop,
				read_text_file: noop,
				delete_file: noop,
				on_audit_event: () => {},
			},
			{
				session_options,
				ip_rate_limiter: options?.ip_rate_limiter ?? null,
				login_account_rate_limiter: null,
				login_fail_floor_ms: 0,
			},
		);

		const app = new Hono();
		app.use('*', test_proxy_middleware);
		if (options?.inject_ctx) {
			app.use('/*', async (c, next) => {
				c.set(REQUEST_CONTEXT_KEY, options.inject_ctx!);
				await next();
			});
		}
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);
		return app;
	};

	test('successful login creates audit entry', async () => {
		const app = create_account_test_app();
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'testuser', password: 'password123'}),
		});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'login');
		assert.strictEqual(audit_log_calls[0]!.outcome, undefined); // defaults to 'success'
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual(audit_log_calls[0]!.actor_id, undefined); // login has no actor context yet
		assert.strictEqual(audit_log_calls[0]!.ip, TEST_CONNECTION_IP);
	});

	test('failed login (wrong password) creates failure audit entry with account_id', async () => {
		const app = create_account_test_app({
			verify_password: vi.fn(() => Promise.resolve(false)),
		});
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'testuser', password: 'wrongpw'}),
		});
		assert.strictEqual(res.status, 401);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'login');
		assert.strictEqual(audit_log_calls[0]!.outcome, 'failure');
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual(audit_log_calls[0]!.actor_id, undefined); // no actor on failed login
		assert.strictEqual(audit_log_calls[0]!.ip, TEST_CONNECTION_IP);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).username, 'testuser');
	});

	test('failed login (nonexistent user) creates failure entry without account_id', async () => {
		const app = create_account_test_app({
			find_account: vi.fn(() => Promise.resolve(undefined)),
		});
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'noone', password: 'password123'}),
		});
		assert.strictEqual(res.status, 401);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'login');
		assert.strictEqual(audit_log_calls[0]!.outcome, 'failure');
		assert.strictEqual(audit_log_calls[0]!.account_id, undefined);
		assert.strictEqual(audit_log_calls[0]!.actor_id, undefined);
		assert.strictEqual(audit_log_calls[0]!.ip, TEST_CONNECTION_IP);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).username, 'noone');
	});

	test('logout creates audit entry', async () => {
		const app = create_account_test_app({inject_ctx: fake_ctx});
		const res = await app.request('/logout', {method: 'POST'});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'logout');
		assert.strictEqual(audit_log_calls[0]!.outcome, undefined); // defaults to 'success'
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual(audit_log_calls[0]!.ip, TEST_CONNECTION_IP);
	});

	// NOTE: session_revoke / session_revoke_all / token_create / token_revoke
	// moved from REST handlers in `account_routes.ts` to RPC handlers in
	// `account_actions.ts` (2026-04-23 migration). End-to-end audit coverage
	// for the RPC path lives in `audit_log_completeness.db.test.ts`, which
	// drives the same five events through the real JSON-RPC endpoint.

	test('password change success creates audit entry with sessions_revoked', async () => {
		const app = create_account_test_app({
			inject_ctx: fake_ctx,
			verify_password: vi.fn(() => Promise.resolve(true)),
		});
		const res = await app.request('/password', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({current_password: 'oldpw12345678', new_password: 'newpw12345678'}),
		});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'password_change');
		assert.strictEqual(audit_log_calls[0]!.outcome, undefined); // defaults to 'success'
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).sessions_revoked, 2);
	});

	test('password change failure creates failure audit entry', async () => {
		const app = create_account_test_app({
			inject_ctx: fake_ctx,
			verify_password: vi.fn(() => Promise.resolve(false)),
		});
		const res = await app.request('/password', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({current_password: 'wrongpw12345678', new_password: 'newpw12345678'}),
		});
		assert.strictEqual(res.status, 401);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'password_change');
		assert.strictEqual(audit_log_calls[0]!.outcome, 'failure');
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
	});

	test('audit log error does not break handler (fire-and-forget)', async () => {
		mock_audit_log_fire_and_forget.mockImplementation(() => Promise.reject(new Error('db down')));

		const route_specs = create_account_route_specs(
			{
				log,
				keyring,
				password: {
					hash_password: vi.fn(() => Promise.resolve('h')),
					verify_password: vi.fn(() => Promise.resolve(true)),
					verify_dummy: vi.fn(() => Promise.resolve(false)),
				} as any,
				stat: noop,
				read_text_file: noop,
				delete_file: noop,
				on_audit_event: () => {},
			},
			{
				session_options,
				ip_rate_limiter: null,
				login_account_rate_limiter: null,
				login_fail_floor_ms: 0,
			},
		);

		const app = new Hono();
		app.use('*', test_proxy_middleware);
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'testuser', password: 'password123'}),
		});

		// handler succeeds despite audit log failure
		assert.strictEqual(res.status, 200);
		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 1);
	});

	test('validation error (malformed input) creates no audit entry', async () => {
		const app = create_account_test_app();
		const res = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({}), // missing username and password
		});
		assert.strictEqual(res.status, 400);

		// no audit log call — validation rejected before handler
		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 0);
	});

	test('rate-limited request creates no audit entry', async () => {
		const limiter = new RateLimiter({max_attempts: 1, window_ms: 60_000, cleanup_interval_ms: 0});
		const app = create_account_test_app({
			verify_password: vi.fn(() => Promise.resolve(false)),
			ip_rate_limiter: limiter,
		});

		// first request: 401 (wrong password), creates audit entry
		const res1 = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'testuser', password: 'wrongpw'}),
		});
		assert.strictEqual(res1.status, 401);
		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 1);

		// second request: 429 (rate-limited), no additional audit entry
		const res2 = await app.request('/login', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username: 'testuser', password: 'wrongpw'}),
		});
		assert.strictEqual(res2.status, 429);
		assert.strictEqual(
			mock_audit_log_fire_and_forget.mock.calls.length,
			1,
			'rate-limited request should not create audit entry',
		);

		limiter.dispose();
	});
});

// Audit log list + permit history reads moved to RPC in Phase 6b
// (2026-04-22); covered by admin_actions.rpc_suites.db.test.ts and the
// attack-surface suites. The remaining REST route (/sessions + SSE stream)
// has coverage in the consumer-facing integration suites.
