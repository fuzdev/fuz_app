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
import {create_admin_account_route_specs} from '$lib/auth/admin_routes.js';
import {create_audit_log_route_specs} from '$lib/auth/audit_log_routes.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {AUDIT_LOG_DEFAULT_LIMIT} from '$lib/auth/audit_log_queries.js';
import {RateLimiter} from '$lib/rate_limiter.js';
import {create_proxy_middleware} from '$lib/http/proxy.js';
import type {AuditLogInput} from '$lib/auth/audit_log_schema.js';
import {ERROR_INVALID_EVENT_TYPE} from '$lib/http/error_schemas.js';
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
	mock_actor_by_account,
	mock_grant_permit,
	mock_revoke_permit,
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
	mock_actor_by_account: vi.fn((..._args: Array<any>): Promise<any> => Promise.resolve(undefined)),
	mock_grant_permit: vi.fn((..._args: Array<any>): Promise<any> => Promise.resolve(undefined)),
	mock_revoke_permit: vi.fn((..._args: Array<any>): Promise<any> => Promise.resolve(undefined)),
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
	query_account_by_id: vi.fn(),
	query_actor_by_account: mock_actor_by_account,
	query_admin_account_list: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/auth/session_queries.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/auth/session_queries.js')>();
	return {
		...actual,
		query_create_session: mock_session_create,
		query_session_enforce_limit: mock_session_enforce_limit,
		query_session_revoke_by_hash: mock_session_revoke,
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

vi.mock('$lib/auth/permit_queries.js', () => ({
	query_grant_permit: mock_grant_permit,
	query_revoke_permit: mock_revoke_permit,
	query_permit_find_active_for_actor: vi.fn(() => Promise.resolve([])),
}));

// --- Shared fixtures ---

const ACC_TEST = '00000000-0000-4000-8000-000000000001';
const ACT_TEST = '00000000-0000-4000-8000-000000000002';
const ACC_ADMIN = '00000000-0000-4000-8000-000000000010';
const ACT_ADMIN = '00000000-0000-4000-8000-000000000011';
const ACC_TARGET = '00000000-0000-4000-8000-000000000020';
const ACT_TARGET = '00000000-0000-4000-8000-000000000021';
const PERMIT_NEW = '00000000-0000-4000-8000-000000000030';
const PERMIT_OLD = '00000000-0000-4000-8000-000000000031';
const SESS_123 = '00000000000040008000000000000040000000000000400080000000000000ff';
const TOK_123 = 'tok_test12345678';

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

const admin_ctx: RequestContext = {
	account: {...fake_account, id: ACC_ADMIN, username: 'admin'},
	actor: {...fake_actor, id: ACT_ADMIN, account_id: ACC_ADMIN, name: 'admin'},
	permits: [
		{
			id: 'p1',
			actor_id: ACT_ADMIN,
			role: 'admin',
			created_at: '2025-01-01T00:00:00.000Z',
			expires_at: null,
			revoked_at: null,
			revoked_by: null,
			granted_by: null,
		},
	],
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
				read_file: noop,
				delete_file: noop,
				on_audit_event: () => {},
			},
			{
				session_options,
				ip_rate_limiter: options?.ip_rate_limiter ?? null,
				login_account_rate_limiter: null,
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

	test('session revoke creates audit entry with session_id metadata', async () => {
		const app = create_account_test_app({inject_ctx: fake_ctx});
		const res = await app.request(`/sessions/${SESS_123}/revoke`, {method: 'POST'});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'session_revoke');
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).session_id, SESS_123);
	});

	test('session revoke for non-owned session records failure outcome', async () => {
		mock_session_revoke_for_account.mockImplementation(() => Promise.resolve(false));

		const route_specs = create_account_route_specs(
			{
				log,
				keyring,
				password: noop,
				stat: noop,
				read_file: noop,
				delete_file: noop,
				on_audit_event: () => {},
			},
			{session_options, ip_rate_limiter: null, login_account_rate_limiter: null},
		);

		const app2 = new Hono();
		app2.use('*', test_proxy_middleware);
		app2.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, fake_ctx);
			await next();
		});
		apply_route_specs(app2, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app2.request(`/sessions/${SESS_123}/revoke`, {method: 'POST'});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.revoked, false);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'session_revoke');
		assert.strictEqual(audit_log_calls[0]!.outcome, 'failure');
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).session_id, SESS_123);
	});

	test('revoke-all creates audit entry with count metadata', async () => {
		const app = create_account_test_app({inject_ctx: fake_ctx});
		const res = await app.request('/sessions/revoke-all', {method: 'POST'});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'session_revoke_all');
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).count, 2);
	});

	test('token create creates audit entry with token metadata', async () => {
		const app = create_account_test_app({inject_ctx: fake_ctx});
		const res = await app.request('/tokens/create', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({name: 'My Token'}),
		});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'token_create');
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.ok((audit_log_calls[0]!.metadata as any).token_id);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).name, 'My Token');
	});

	test('token revoke creates audit entry', async () => {
		const app = create_account_test_app({inject_ctx: fake_ctx});
		const res = await app.request(`/tokens/${TOK_123}/revoke`, {method: 'POST'});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'token_revoke');
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_TEST);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_TEST);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).token_id, TOK_123);
	});

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
				read_file: noop,
				delete_file: noop,
				on_audit_event: () => {},
			},
			{session_options, ip_rate_limiter: null, login_account_rate_limiter: null},
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

describe('admin route audit logging', () => {
	beforeEach(() => {
		audit_log_calls = [];
		mock_actor_by_account.mockImplementation(() =>
			Promise.resolve({
				id: ACT_TARGET,
				account_id: ACC_TARGET,
				name: 'target',
				created_at: '2025-01-01T00:00:00.000Z',
				updated_at: null,
				updated_by: null,
			}),
		);
		mock_grant_permit.mockImplementation(() =>
			Promise.resolve({
				id: PERMIT_NEW,
				actor_id: ACT_TARGET,
				role: 'admin',
				created_at: '2025-01-01T00:00:00.000Z',
				expires_at: null,
				revoked_at: null,
				revoked_by: null,
				granted_by: ACT_ADMIN,
			}),
		);
		mock_revoke_permit.mockImplementation(() => Promise.resolve({id: PERMIT_OLD, role: 'admin'}));
	});

	const create_admin_test_app = (): Hono => {
		const route_specs = create_admin_account_route_specs(
			{log, on_audit_event: () => {}},
			undefined,
		);

		const app = new Hono();
		app.use('*', test_proxy_middleware);
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, admin_ctx);
			await next();
		});
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);
		return app;
	};

	test('permit grant creates audit entry with target_account_id', async () => {
		const app = create_admin_test_app();
		const res = await app.request(`/accounts/${ACC_TARGET}/permits/grant`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({role: 'admin'}),
		});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'permit_grant');
		assert.strictEqual(audit_log_calls[0]!.outcome, undefined); // defaults to 'success'
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_ADMIN);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_ADMIN);
		assert.strictEqual(audit_log_calls[0]!.target_account_id, ACC_TARGET);
		assert.strictEqual(audit_log_calls[0]!.ip, TEST_CONNECTION_IP);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).role, 'admin');
		assert.strictEqual((audit_log_calls[0]!.metadata as any).permit_id, PERMIT_NEW);
	});

	test('permit revoke creates audit entry with target_account_id', async () => {
		const app = create_admin_test_app();
		const res = await app.request(`/accounts/${ACC_TARGET}/permits/${PERMIT_OLD}/revoke`, {
			method: 'POST',
		});
		assert.strictEqual(res.status, 200);

		assert.strictEqual(audit_log_calls.length, 1);
		assert.strictEqual(audit_log_calls[0]!.event_type, 'permit_revoke');
		assert.strictEqual(audit_log_calls[0]!.outcome, undefined); // defaults to 'success'
		assert.strictEqual(audit_log_calls[0]!.actor_id, ACT_ADMIN);
		assert.strictEqual(audit_log_calls[0]!.account_id, ACC_ADMIN);
		assert.strictEqual(audit_log_calls[0]!.target_account_id, ACC_TARGET);
		assert.strictEqual(audit_log_calls[0]!.ip, TEST_CONNECTION_IP);
		assert.strictEqual((audit_log_calls[0]!.metadata as any).role, 'admin');
		assert.strictEqual((audit_log_calls[0]!.metadata as any).permit_id, PERMIT_OLD);
	});
});

describe('audit log read routes', () => {
	const fake_events = [
		{
			id: 'evt_1',
			seq: 1,
			event_type: 'login',
			outcome: 'success',
			actor_id: null,
			account_id: ACC_TEST,
			target_account_id: null,
			ip: '127.0.0.1',
			created_at: '2025-06-01T00:00:00.000Z',
			metadata: null,
			username: 'testuser',
			target_username: null,
		},
		{
			id: 'evt_2',
			seq: 2,
			event_type: 'permit_grant',
			outcome: 'success',
			actor_id: ACT_ADMIN,
			account_id: ACC_ADMIN,
			target_account_id: ACC_TEST,
			ip: '127.0.0.1',
			created_at: '2025-06-01T01:00:00.000Z',
			metadata: {role: 'admin'},
			username: 'admin',
			target_username: 'testuser',
		},
	];

	const fake_permit_history_events = [
		{
			...fake_events[1],
			username: 'admin',
			target_username: 'testuser',
		},
	];

	beforeEach(() => {
		mock_audit_log_list_with_usernames.mockImplementation(
			() => Promise.resolve(fake_events) as any,
		);
		mock_audit_log_list_permit_history.mockImplementation(
			() => Promise.resolve(fake_permit_history_events) as any,
		);
		mock_session_list_all_active.mockImplementation(() =>
			Promise.resolve([
				{
					id: 'sess_1',
					account_id: ACC_TEST,
					created_at: '2025-06-01T00:00:00.000Z',
					expires_at: '2025-07-01T00:00:00.000Z',
					last_seen_at: '2025-06-15T00:00:00.000Z',
					username: 'testuser',
				},
			]),
		);
	});

	const create_audit_read_app = (inject_ctx?: RequestContext): Hono => {
		const route_specs = create_audit_log_route_specs();

		const app = new Hono();
		if (inject_ctx) {
			app.use('/*', async (c, next) => {
				c.set(REQUEST_CONTEXT_KEY, inject_ctx);
				await next();
			});
		}
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);
		return app;
	};

	afterEach(() => {
		vi.clearAllMocks();
	});

	test('GET /audit-log returns events with resolved usernames', async () => {
		const app = create_audit_read_app(admin_ctx);
		const res = await app.request('/audit-log');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.events.length, 2);
		assert.strictEqual(body.events[0].event_type, 'login');
		assert.strictEqual(body.events[0].username, 'testuser');
		assert.strictEqual(body.events[0].target_username, null);
		assert.strictEqual(body.events[1].event_type, 'permit_grant');
		assert.strictEqual(body.events[1].username, 'admin');
		assert.strictEqual(body.events[1].target_username, 'testuser');
	});

	test('GET /audit-log passes query params to list()', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log?event_type=login&limit=10&offset=5');

		assert.strictEqual(mock_audit_log_list_with_usernames.mock.calls.length, 1);
		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.event_type, 'login');
		assert.strictEqual(opts.limit, 10);
		assert.strictEqual(opts.offset, 5);
	});

	test('GET /audit-log passes account_id filter', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log?account_id=acc_123');

		assert.strictEqual(mock_audit_log_list_with_usernames.mock.calls.length, 1);
		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.account_id, 'acc_123');
	});

	test('GET /audit-log rejects invalid event_type with 400', async () => {
		const app = create_audit_read_app(admin_ctx);
		const res = await app.request('/audit-log?event_type=not_a_real_event');
		assert.strictEqual(res.status, 400);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INVALID_EVENT_TYPE);
		assert.strictEqual(mock_audit_log_list_with_usernames.mock.calls.length, 0);
	});

	test('GET /audit-log uses default limit and offset when omitted', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log');

		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.limit, AUDIT_LOG_DEFAULT_LIMIT);
		assert.strictEqual(opts.offset, 0);
	});

	test('GET /audit-log clamps limit to [1, 200]', async () => {
		const app = create_audit_read_app(admin_ctx);

		// limit=0 → clamped to default (via || fallback), then max(1, ...) = default
		await app.request('/audit-log?limit=0');
		let opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.ok(opts.limit >= 1, 'limit should be at least 1');

		vi.clearAllMocks();
		mock_audit_log_list_with_usernames.mockImplementation(() => Promise.resolve(fake_events));

		// limit=999 → clamped to 200
		await app.request('/audit-log?limit=999');
		opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.limit, 200);
	});

	test('GET /audit-log clamps negative offset to 0', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log?offset=-5');

		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.offset, 0);
	});

	test('GET /audit-log passes since_seq filter', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log?since_seq=42');

		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.since_seq, 42);
	});

	test('GET /audit-log ignores non-numeric since_seq', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log?since_seq=abc');

		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.since_seq, undefined);
	});

	test('GET /audit-log passes since_seq=0', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log?since_seq=0');

		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.since_seq, 0);
	});

	test('GET /audit-log omits since_seq when param absent', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log');

		const opts = mock_audit_log_list_with_usernames.mock.calls[0]![1];
		assert.strictEqual(opts.since_seq, undefined);
	});

	test('GET /audit-log/permit-history returns events with usernames', async () => {
		const app = create_audit_read_app(admin_ctx);
		const res = await app.request('/audit-log/permit-history');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.events.length, 1);
		assert.strictEqual(body.events[0].username, 'admin');
		assert.strictEqual(body.events[0].target_username, 'testuser');

		assert.strictEqual(mock_audit_log_list_permit_history.mock.calls.length, 1);
		// args: deps, limit, offset
		assert.strictEqual(mock_audit_log_list_permit_history.mock.calls[0]![1], 50); // default limit
		assert.strictEqual(mock_audit_log_list_permit_history.mock.calls[0]![2], 0); // default offset
	});

	test('GET /audit-log/permit-history passes limit and offset', async () => {
		const app = create_audit_read_app(admin_ctx);
		await app.request('/audit-log/permit-history?limit=25&offset=10');

		assert.strictEqual(mock_audit_log_list_permit_history.mock.calls[0]![1], 25);
		assert.strictEqual(mock_audit_log_list_permit_history.mock.calls[0]![2], 10);
	});

	test('GET /sessions returns active sessions with usernames', async () => {
		const app = create_audit_read_app(admin_ctx);
		const res = await app.request('/sessions');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.sessions.length, 1);
		assert.strictEqual(body.sessions[0].username, 'testuser');
		assert.strictEqual(body.sessions[0].account_id, ACC_TEST);
		assert.strictEqual(body.sessions[0].id, 'sess_1');
	});

	test('admin routes require admin role (unauthenticated → 401)', async () => {
		const app = create_audit_read_app(); // no context injected
		const audit_res = await app.request('/audit-log');
		assert.strictEqual(audit_res.status, 401);

		const permit_res = await app.request('/audit-log/permit-history');
		assert.strictEqual(permit_res.status, 401);

		const sessions_res = await app.request('/sessions');
		assert.strictEqual(sessions_res.status, 401);
	});

	test('admin routes require admin role (wrong role → 403)', async () => {
		const non_admin_ctx: RequestContext = {
			...fake_ctx,
			permits: [
				{
					id: 'p2',
					actor_id: ACT_TEST,
					role: 'viewer',
					created_at: '2025-01-01T00:00:00.000Z',
					expires_at: null,
					revoked_at: null,
					revoked_by: null,
					granted_by: null,
				},
			],
		};
		const app = create_audit_read_app(non_admin_ctx);

		const audit_res = await app.request('/audit-log');
		assert.strictEqual(audit_res.status, 403);

		const permit_res = await app.request('/audit-log/permit-history');
		assert.strictEqual(permit_res.status, 403);

		const sessions_res = await app.request('/sessions');
		assert.strictEqual(sessions_res.status, 403);
	});
});
