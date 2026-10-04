// @vitest-environment jsdom

/**
 * Tests for `AuthState` — SPA auth state management.
 *
 * Mocks `globalThis.fetch` to test each method's request/response handling
 * without a real server.
 *
 * @module
 */

import { describe, test, assert, vi, beforeEach, afterEach } from 'vitest';

import { AuthState } from '$lib/ui/auth_state.svelte.ts';
import type { RoleGrantSummaryJson } from '$lib/auth/account_schema.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

/** Create a mock Response with JSON body. */
const json_response = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});

const SCOPE = '11111111-1111-4111-8111-111111111111' as Uuid;

let next_grant = 0;

/** Create a role grant as `GET /api/account/status` returns it; `scope_id: null` is global. */
const make_grant = (
	role: string,
	scope_id: Uuid | null,
	expires_at: string | null = null
): RoleGrantSummaryJson => ({
	id: `grant-${next_grant++}` as Uuid,
	role,
	scope_kind: scope_id === null ? null : 'classroom',
	scope_id,
	created_at: '2026-01-01T00:00:00Z',
	expires_at,
	granted_by: null
});

let fetch_mock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetch_mock = vi.fn();
	globalThis.fetch = fetch_mock as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('check_session', () => {
	test('success sets verified and account', async () => {
		const account = { id: 'acct-1', username: 'alice' };
		fetch_mock.mockResolvedValueOnce(json_response({ account }));

		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(state.verified, true);
		assert.deepEqual(state.account, account);
		assert.strictEqual(state.needs_bootstrap, false);
		assert.strictEqual(state.verifying, false);
	});

	test('unauthenticated: 401 sets verified to false', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ error: 'authentication_required' }, 401));

		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(state.verified, false);
		assert.strictEqual(state.account, null);
		assert.strictEqual(state.needs_bootstrap, false);
	});

	test('unauthenticated: 401 with bootstrap_available sets needs_bootstrap', async () => {
		fetch_mock.mockResolvedValueOnce(
			json_response({ error: 'authentication_required', bootstrap_available: true }, 401)
		);

		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(state.verified, false);
		assert.strictEqual(state.needs_bootstrap, true);
	});

	test('non-ok status response sets verified to false', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 500 }));

		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(state.verified, false);
		assert.strictEqual(state.verifying, false);
	});

	test('network error sets verified to false', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(state.verified, false);
		assert.strictEqual(state.verifying, false);
	});

	test('fetches status with credentials', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ error: 'authentication_required' }, 401));

		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(fetch_mock.mock.calls.length, 1);
		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/status');
		assert.deepEqual(fetch_mock.mock.calls[0]![1], { credentials: 'include' });
	});

	test('authenticated response clears needs_bootstrap', async () => {
		const state = new AuthState();
		state.needs_bootstrap = true;

		fetch_mock.mockResolvedValueOnce(
			json_response({ account: { id: 'acct-1', username: 'alice' } })
		);
		await state.check_session();

		assert.strictEqual(state.needs_bootstrap, false);
		assert.strictEqual(state.verified, true);
	});
});

describe('login', () => {
	test('success returns true and calls check_session', async () => {
		const account = { id: 'acct-1', username: 'alice' };
		// login response
		fetch_mock.mockResolvedValueOnce(json_response({ ok: true }));
		// check_session: status
		fetch_mock.mockResolvedValueOnce(json_response({ account }));

		const state = new AuthState();
		const result = await state.login('alice', 'password123');

		assert.strictEqual(result, true);
		assert.strictEqual(state.verified, true);
		assert.deepEqual(state.account, account);
		assert.strictEqual(state.verify_error, null);
		assert.strictEqual(state.verifying, false);
	});

	test('401 returns false with Invalid credentials', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 401 }));

		const state = new AuthState();
		const result = await state.login('alice', 'wrong');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Invalid credentials');
		assert.strictEqual(state.verifying, false);
	});

	test('429 returns false with retry message', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ retry_after: 120 }, 429));

		const state = new AuthState();
		const result = await state.login('alice', 'password');

		assert.strictEqual(result, false);
		assert.ok(state.verify_error);
		assert.ok(state.verify_error.includes('2 minutes'));
	});

	test('429 with default retry_after uses 1 minute', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({}, 429));

		const state = new AuthState();
		await state.login('alice', 'password');

		assert.strictEqual(state.verify_error, 'Too many attempts. Try again in 1 minute.');
	});

	test('other error status sets generic error', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 503 }));

		const state = new AuthState();
		const result = await state.login('alice', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Error: 503');
	});

	test('network error sets error from exception', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Connection refused'));

		const state = new AuthState();
		const result = await state.login('alice', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Connection refused');
	});

	test('non-Error throw sets Connection failed', async () => {
		fetch_mock.mockRejectedValueOnce('something weird');

		const state = new AuthState();
		const result = await state.login('alice', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Connection failed');
	});

	test('sends correct request', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 401 }));

		const state = new AuthState();
		await state.login('alice', 'secret');

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/login');
		const opts = fetch_mock.mock.calls[0]![1] as RequestInit;
		assert.strictEqual(opts.method, 'POST');
		assert.strictEqual(opts.credentials, 'include');
		assert.deepEqual(JSON.parse(opts.body as string), { username: 'alice', password: 'secret' });
	});

	test('clears previous verify_error on new attempt', async () => {
		// first login fails
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 401 }));
		const state = new AuthState();
		await state.login('alice', 'wrong');
		assert.ok(state.verify_error);

		// second login succeeds, check_session: status
		fetch_mock.mockResolvedValueOnce(json_response({ ok: true }));
		fetch_mock.mockResolvedValueOnce(json_response({ account: { id: 'acct-1' } }));
		await state.login('alice', 'correct');
		assert.strictEqual(state.verify_error, null);
	});
});

describe('bootstrap', () => {
	test('success returns true and clears needs_bootstrap', async () => {
		// bootstrap response
		fetch_mock.mockResolvedValueOnce(json_response({ ok: true }));
		// check_session: status
		fetch_mock.mockResolvedValueOnce(json_response({ account: { id: 'acct-1' } }));

		const state = new AuthState();
		state.needs_bootstrap = true;
		const result = await state.bootstrap('token123', 'admin', 'password');

		assert.strictEqual(result, true);
		assert.strictEqual(state.verified, true);
		assert.strictEqual(state.needs_bootstrap, false);
		assert.strictEqual(state.verifying, false);
	});

	test('failure returns false with error from response', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ error: 'invalid_token' }, 401));

		const state = new AuthState();
		const result = await state.bootstrap('bad-token', 'admin', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'invalid_token');
	});

	test('failure without error field uses status', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({}, 403));

		const state = new AuthState();
		const result = await state.bootstrap('token', 'admin', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Error: 403');
	});

	test('network error sets error from exception', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Offline'));

		const state = new AuthState();
		const result = await state.bootstrap('token', 'admin', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Offline');
	});

	test('sends correct request', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ error: 'test' }, 400));

		const state = new AuthState();
		await state.bootstrap('my-token', 'admin', 'secret');

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/bootstrap');
		const opts = fetch_mock.mock.calls[0]![1] as RequestInit;
		assert.strictEqual(opts.method, 'POST');
		assert.strictEqual(opts.credentials, 'include');
		assert.deepEqual(JSON.parse(opts.body as string), {
			token: 'my-token',
			username: 'admin',
			password: 'secret'
		});
	});
});

describe('logout', () => {
	test('clears verified and account', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 200 }));

		const state = new AuthState();
		state.verified = true;
		state.account = { id: 'acct-1', username: 'alice' } as any;
		await state.logout();

		assert.strictEqual(state.verified, false);
		assert.strictEqual(state.account, null);
	});

	test('clears state even if fetch fails', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new AuthState();
		state.verified = true;
		state.account = { id: 'acct-1', username: 'alice' } as any;
		await state.logout();

		assert.strictEqual(state.verified, false);
		assert.strictEqual(state.account, null);
	});

	test('sends POST to logout endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 200 }));

		const state = new AuthState();
		await state.logout();

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/logout');
		const opts = fetch_mock.mock.calls[0]![1] as RequestInit;
		assert.strictEqual(opts.method, 'POST');
		assert.strictEqual(opts.credentials, 'include');
	});
});

describe('signup', () => {
	test('success returns true and calls check_session', async () => {
		// signup response
		fetch_mock.mockResolvedValueOnce(json_response({ ok: true }));
		// check_session: status
		fetch_mock.mockResolvedValueOnce(json_response({ account: { id: 'acct-1', username: 'bob' } }));

		const state = new AuthState();
		const result = await state.signup('bob', 'password123', 'bob@example.com');

		assert.strictEqual(result, true);
		assert.strictEqual(state.verified, true);
		assert.strictEqual(state.verify_error, null);
		assert.strictEqual(state.verifying, false);
	});

	test('sends correct request with email', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 403 }));

		const state = new AuthState();
		await state.signup('bob', 'secret', 'bob@example.com');

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/account/signup');
		const opts = fetch_mock.mock.calls[0]![1] as RequestInit;
		assert.strictEqual(opts.method, 'POST');
		assert.strictEqual(opts.credentials, 'include');
		assert.deepEqual(JSON.parse(opts.body as string), {
			username: 'bob',
			password: 'secret',
			email: 'bob@example.com'
		});
	});

	test('sends correct request without email', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 403 }));

		const state = new AuthState();
		await state.signup('bob', 'secret');

		const opts = fetch_mock.mock.calls[0]![1] as RequestInit;
		const body = JSON.parse(opts.body as string);
		assert.ok(!('email' in body));
	});

	test('403 returns false with no invite message', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 403 }));

		const state = new AuthState();
		const result = await state.signup('bob', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'No matching invite found for these credentials.');
	});

	test('409 signup_conflict returns false with unified conflict error', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ error: 'signup_conflict' }, 409));

		const state = new AuthState();
		const result = await state.signup('bob', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Username or email is already in use.');
	});

	test('429 returns false with retry message', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({ retry_after: 180 }, 429));

		const state = new AuthState();
		const result = await state.signup('bob', 'password');

		assert.strictEqual(result, false);
		assert.ok(state.verify_error!.includes('3 minutes'));
	});

	test('other error status sets generic error', async () => {
		fetch_mock.mockResolvedValueOnce(new Response(null, { status: 500 }));

		const state = new AuthState();
		const result = await state.signup('bob', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Error: 500');
	});

	test('network error sets error from exception', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Offline'));

		const state = new AuthState();
		const result = await state.signup('bob', 'password');

		assert.strictEqual(result, false);
		assert.strictEqual(state.verify_error, 'Offline');
	});
});

describe('global roles', () => {
	test('a global admin grant is admin', () => {
		const state = new AuthState();
		state.role_grants = [make_grant('admin', null)];

		assert.strictEqual(state.is_admin, true);
		assert.strictEqual(state.has_global_role('admin'), true);
		assert.deepEqual([...state.global_roles], ['admin']);
	});

	test('a scoped admin grant is not admin', () => {
		const state = new AuthState();
		state.role_grants = [make_grant('admin', SCOPE)];

		// the grant is live, it just isn't global
		assert.strictEqual(state.active_role_grants.length, 1);
		assert.strictEqual(state.is_admin, false);
		assert.strictEqual(state.has_global_role('admin'), false);
		assert.strictEqual(state.global_roles.size, 0);
	});

	test('global_roles holds the globally held roles and no scoped one', () => {
		const state = new AuthState();
		state.role_grants = [
			make_grant('educator', null),
			make_grant('teacher', SCOPE),
			make_grant('admin', SCOPE),
			make_grant('keeper', null)
		];

		assert.deepEqual([...state.global_roles].sort(), ['educator', 'keeper']);
		assert.strictEqual(state.has_global_role('educator'), true);
		assert.strictEqual(state.has_global_role('teacher'), false);
		assert.strictEqual(state.is_admin, false);
	});

	test('an expired global grant is not held', () => {
		const state = new AuthState();
		state.role_grants = [
			make_grant('admin', null, '2000-01-01T00:00:00Z'),
			make_grant('educator', null, '9999-01-01T00:00:00Z')
		];

		assert.strictEqual(state.is_admin, false);
		assert.deepEqual([...state.global_roles], ['educator']);
	});

	test('a grant with no scope_id field is not read as global', async () => {
		// both backends always send `scope_id`; a payload without it fails closed
		fetch_mock.mockResolvedValueOnce(
			json_response({
				account: { id: 'acct-1', username: 'alice' },
				role_grants: [
					{ id: 'grant-x', role: 'admin', created_at: '2026-01-01T00:00:00Z', expires_at: null }
				]
			})
		);
		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(state.active_role_grants.length, 1);
		assert.strictEqual(state.is_admin, false);
		assert.strictEqual(state.global_roles.size, 0);
	});

	test('nothing is held before a session loads', () => {
		const state = new AuthState();

		assert.strictEqual(state.is_admin, false);
		assert.strictEqual(state.has_global_role('admin'), false);
		assert.strictEqual(state.global_roles.size, 0);
	});

	test('follows role_grants as it changes', () => {
		const state = new AuthState();
		state.role_grants = [make_grant('admin', SCOPE)];
		assert.strictEqual(state.is_admin, false);

		state.role_grants = [make_grant('admin', SCOPE), make_grant('admin', null)];
		assert.strictEqual(state.is_admin, true);
		assert.strictEqual(state.has_global_role('admin'), true);

		state.role_grants = [make_grant('admin', SCOPE)];
		assert.strictEqual(state.is_admin, false);
		assert.strictEqual(state.has_global_role('admin'), false);
	});

	test('check_session loads them and logout clears them', async () => {
		fetch_mock.mockResolvedValueOnce(
			json_response({
				account: { id: 'acct-1', username: 'alice' },
				role_grants: [make_grant('admin', null), make_grant('teacher', SCOPE)]
			})
		);
		const state = new AuthState();
		await state.check_session();

		assert.strictEqual(state.is_admin, true);
		assert.deepEqual([...state.global_roles], ['admin']);

		fetch_mock.mockResolvedValueOnce(json_response({ ok: true }));
		await state.logout();

		assert.strictEqual(state.is_admin, false);
		assert.strictEqual(state.global_roles.size, 0);
	});
});
