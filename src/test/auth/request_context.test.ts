/**
 * Tests for request context — role_grant helpers, auth guards, and context middleware.
 *
 * @module
 */

import { describe, assert, test, vi, afterEach } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { Hono } from 'hono';
import { wait } from '@fuzdev/fuz_util/async.ts';

import {
	has_role,
	has_scoped_role,
	has_any_scoped_role,
	require_auth,
	require_role,
	create_request_context_middleware,
	REQUEST_CONTEXT_KEY
} from '$lib/auth/request_context.ts';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY
} from '$lib/hono_context.ts';
import type { Account, Actor, RoleGrant } from '$lib/auth/account_schema.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS
} from '$lib/http/error_schemas.ts';
import {
	create_test_account,
	create_test_actor,
	create_test_role_grant,
	create_test_context
} from '$lib/testing/entities.ts';
import type { QueryDeps } from '$lib/db/query_deps.ts';
import {
	query_session_get_valid,
	session_touch_fire_and_forget
} from '$lib/auth/session_queries.ts';
import {
	query_account_by_id,
	query_actor_by_id,
	query_active_actors_by_account
} from '$lib/auth/account_queries.ts';
import { query_role_grant_find_active_for_actor } from '$lib/auth/role_grant_queries.ts';

const log = new Logger('test', { level: 'off' });

const mock_deps: QueryDeps = { db: {} as any };

vi.mock('$lib/auth/session_queries.js', async (import_original) => {
	const original = await import_original<typeof import('$lib/auth/session_queries.ts')>();
	return {
		...original,
		// Keep hash_session_token real (pure function)
		hash_session_token: original.hash_session_token,
		query_session_get_valid: vi.fn(),
		session_touch_fire_and_forget: vi.fn()
	};
});

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_id: vi.fn(),
	query_active_actors_by_account: vi.fn()
}));

vi.mock('$lib/auth/role_grant_queries.js', () => ({
	query_role_grant_find_active_for_actor: vi.fn()
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('has_role', () => {
	test('null ctx returns false', () => {
		assert.strictEqual(has_role(null, 'admin'), false);
		assert.strictEqual(has_role(null, 'keeper'), false);
	});

	test('returns true for matching active role_grant', () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('returns false for missing role', () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		assert.strictEqual(has_role(ctx, 'keeper'), false);
	});

	test('returns false for revoked role_grant', () => {
		const ctx = create_test_context([{ role: 'admin', revoked_at: '2024-01-02T00:00:00Z' }]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns false for expired role_grant', () => {
		const past = new Date(Date.now() - 60000).toISOString();
		const ctx = create_test_context([{ role: 'admin', expires_at: past }]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns true for non-expired role_grant', () => {
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = create_test_context([{ role: 'admin', expires_at: future }]);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('returns true when one of multiple role_grants matches', () => {
		const ctx = create_test_context([{ role: 'keeper' }, { role: 'admin' }]);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('returns false with empty role_grants', () => {
		const ctx = create_test_context([]);
		ctx.role_grants = [];
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('role check is case-sensitive — "Admin" does not match "admin"', () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		assert.strictEqual(has_role(ctx, 'Admin'), false);
		assert.strictEqual(has_role(ctx, 'ADMIN'), false);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('role check is exact — "admin " (trailing space) does not match "admin"', () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		assert.strictEqual(has_role(ctx, 'admin '), false);
		assert.strictEqual(has_role(ctx, ' admin'), false);
	});

	test('returns true for role_grant with null expires_at (no expiry)', () => {
		const ctx = create_test_context([{ role: 'keeper', expires_at: null }]);
		assert.strictEqual(has_role(ctx, 'keeper'), true);
	});

	test('rejects role_grant that expires between context load and role check', () => {
		vi.useFakeTimers();
		try {
			const now = Date.now();
			const soon = new Date(now + 5000).toISOString();
			const ctx = create_test_context([{ role: 'admin', expires_at: soon }]);
			assert.strictEqual(has_role(ctx, 'admin'), true);
			vi.advanceTimersByTime(6000);
			assert.strictEqual(has_role(ctx, 'admin'), false);
		} finally {
			vi.useRealTimers();
		}
	});

	test('rejects revoked role_grant even with future expires_at', () => {
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = create_test_context([
			{ role: 'admin', revoked_at: '2024-06-01T00:00:00Z', expires_at: future }
		]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns false when role matches but all role_grants for that role are revoked', () => {
		const ctx = create_test_context([
			{ role: 'admin', revoked_at: '2024-06-01T00:00:00Z' },
			{ role: 'admin', revoked_at: '2024-07-01T00:00:00Z' }
		]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('handles role_grant with expires_at at Unix epoch boundary', () => {
		const ctx = create_test_context([{ role: 'admin', expires_at: '1970-01-01T00:00:00Z' }]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns true when same role has one revoked and one active role_grant', () => {
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = create_test_context([
			{ role: 'admin', revoked_at: '2024-06-01T00:00:00Z', expires_at: future },
			{ role: 'admin', revoked_at: null, expires_at: future }
		]);
		// some() finds the active role_grant even when another is revoked
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});
});

describe('has_scoped_role', () => {
	test('null ctx returns false', () => {
		assert.strictEqual(has_scoped_role(null, 'classroom_teacher', 'scope-X'), false);
		assert.strictEqual(has_scoped_role(null, 'admin', null), false);
	});

	test('matching scope admits', () => {
		const ctx = create_test_context([{ role: 'classroom_teacher', scope_id: 'scope-X' }]);
		assert.strictEqual(has_scoped_role(ctx, 'classroom_teacher', 'scope-X'), true);
	});

	test('sibling scope does not admit', () => {
		const ctx = create_test_context([{ role: 'classroom_teacher', scope_id: 'scope-X' }]);
		assert.strictEqual(has_scoped_role(ctx, 'classroom_teacher', 'scope-Y'), false);
	});

	test('global role_grant does not admit a scoped check', () => {
		const ctx = create_test_context([{ role: 'classroom_teacher', scope_id: null }]);
		assert.strictEqual(has_scoped_role(ctx, 'classroom_teacher', 'scope-X'), false);
	});

	test('scoped role_grant does not admit a global check', () => {
		const ctx = create_test_context([{ role: 'classroom_teacher', scope_id: 'scope-X' }]);
		assert.strictEqual(has_scoped_role(ctx, 'classroom_teacher', null), false);
	});

	test('null scope_id matches a NULL-scope role_grant', () => {
		const ctx = create_test_context([{ role: 'admin', scope_id: null }]);
		assert.strictEqual(has_scoped_role(ctx, 'admin', null), true);
	});

	test('revoked role_grant excluded', () => {
		const ctx = create_test_context([
			{ role: 'classroom_teacher', scope_id: 'scope-X', revoked_at: '2024-01-02T00:00:00Z' }
		]);
		assert.strictEqual(has_scoped_role(ctx, 'classroom_teacher', 'scope-X'), false);
	});

	test('expired role_grant excluded', () => {
		const past = new Date(Date.now() - 1000).toISOString();
		const ctx = create_test_context([
			{ role: 'classroom_teacher', scope_id: 'scope-X', expires_at: past }
		]);
		assert.strictEqual(has_scoped_role(ctx, 'classroom_teacher', 'scope-X'), false);
	});

	test('role mismatch on matching scope does not admit', () => {
		const ctx = create_test_context([{ role: 'classroom_student', scope_id: 'scope-X' }]);
		assert.strictEqual(has_scoped_role(ctx, 'classroom_teacher', 'scope-X'), false);
	});
});

describe('has_any_scoped_role', () => {
	const ROLE_PAIR = ['classroom_teacher', 'classroom_student'] as const;

	test('null ctx returns false', () => {
		assert.strictEqual(has_any_scoped_role(null, ROLE_PAIR, 'scope-X'), false);
	});

	test('empty roles short-circuits to false', () => {
		const ctx = create_test_context([{ role: 'classroom_teacher', scope_id: 'scope-X' }]);
		assert.strictEqual(has_any_scoped_role(ctx, [], 'scope-X'), false);
		assert.strictEqual(has_any_scoped_role(ctx, [], null), false);
	});

	test('admits when actor holds one of the roles', () => {
		const ctx = create_test_context([{ role: 'classroom_student', scope_id: 'scope-X' }]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, 'scope-X'), true);
	});

	test('admits the other role in the tuple', () => {
		const ctx = create_test_context([{ role: 'classroom_teacher', scope_id: 'scope-X' }]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, 'scope-X'), true);
	});

	test('denies when actor holds none of the roles', () => {
		const ctx = create_test_context([{ role: 'educator', scope_id: 'scope-X' }]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, 'scope-X'), false);
	});

	test('sibling-scope role_grant does not admit', () => {
		const ctx = create_test_context([{ role: 'classroom_student', scope_id: 'scope-Y' }]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, 'scope-X'), false);
	});

	test('global role_grant does not admit a scoped check', () => {
		const ctx = create_test_context([{ role: 'classroom_teacher', scope_id: null }]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, 'scope-X'), false);
	});

	test('null scope_id matches global role_grants only', () => {
		const ctx = create_test_context([
			{ role: 'classroom_student', scope_id: null },
			{ role: 'classroom_teacher', scope_id: 'scope-X' }
		]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, null), true);
	});

	test('revoked role_grant excluded', () => {
		const ctx = create_test_context([
			{ role: 'classroom_teacher', scope_id: 'scope-X', revoked_at: '2024-01-02T00:00:00Z' }
		]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, 'scope-X'), false);
	});

	test('expired role_grant excluded', () => {
		const past = new Date(Date.now() - 1000).toISOString();
		const ctx = create_test_context([
			{ role: 'classroom_student', scope_id: 'scope-X', expires_at: past }
		]);
		assert.strictEqual(has_any_scoped_role(ctx, ROLE_PAIR, 'scope-X'), false);
	});
});

describe('require_auth', () => {
	test('returns 401 when no request context is set', async () => {
		const app = new Hono();
		app.use('/*', require_auth);
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('passes through when request context is set', async () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		const app = new Hono();
		// set context before require_auth
		app.use('/*', async (c, next) => {
			c.set(ACCOUNT_ID_KEY, ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		app.use('/*', require_auth);
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});
});

describe('require_role', () => {
	test('returns 401 when no request context is set', async () => {
		const app = new Hono();
		app.use('/*', require_role(['admin']));
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('returns 403 when context lacks required role', async () => {
		const ctx = create_test_context([{ role: 'user' }]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(ACCOUNT_ID_KEY, ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		app.use('/*', require_role(['admin']));
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_roles?.[0], 'admin');
	});

	test('passes through when context has required role', async () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(ACCOUNT_ID_KEY, ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		app.use('/*', require_role(['admin']));
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('403 includes required_role in response body', async () => {
		const ctx = create_test_context([{ role: 'user' }]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(ACCOUNT_ID_KEY, ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		app.use('/*', require_role(['keeper']));
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_roles?.[0], 'keeper');
	});

	test('expired role_grant causes 403 even if role matches', async () => {
		const past = new Date(Date.now() - 60000).toISOString();
		const ctx = create_test_context([{ role: 'admin', expires_at: past }]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(ACCOUNT_ID_KEY, ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		app.use('/*', require_role(['admin']));
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_roles?.[0], 'admin');
	});

	test('revoked role_grant causes 403 even if role matches', async () => {
		const ctx = create_test_context([{ role: 'admin', revoked_at: '2024-01-01T00:00:00Z' }]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(ACCOUNT_ID_KEY, ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		app.use('/*', require_role(['admin']));
		app.get('/test', (c) => c.json({ ok: true }));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
	});
});

describe('has_role — TOCTOU snapshot behavior', () => {
	test('context snapshot is immune to external role_grant changes', () => {
		// simulates: role_grant loaded in middleware, then "revoked" externally before handler checks
		const ctx = create_test_context([{ role: 'admin' }]);
		assert.strictEqual(has_role(ctx, 'admin'), true);

		// external mutation: clear role_grants (simulating DB revoke happening after middleware)
		// the snapshot model means this mutation requires explicit refresh_role_grants() call
		const snapshot_role_grants = ctx.role_grants;
		assert.strictEqual(has_role(ctx, 'admin'), true);
		// only explicit mutation changes the result
		ctx.role_grants = [];
		assert.strictEqual(has_role(ctx, 'admin'), false);
		// restore to demonstrate the snapshot was independent
		ctx.role_grants = snapshot_role_grants;
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('expiry-based TOCTOU: role_grant expires between middleware and handler', () => {
		vi.useFakeTimers();
		try {
			const now = Date.now();
			// role_grant expires in 2 seconds
			const soon = new Date(now + 2000).toISOString();
			const ctx = create_test_context([{ role: 'admin', expires_at: soon }]);

			// middleware time: role_grant is active
			assert.strictEqual(has_role(ctx, 'admin'), true);

			// handler time: 3 seconds later, role_grant has expired
			vi.advanceTimersByTime(3000);
			assert.strictEqual(has_role(ctx, 'admin'), false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('create_request_context_middleware', () => {
	const account = create_test_account({ id: 'acct-1', username: 'alice' });
	const actor = create_test_actor({ id: 'actor-1', account_id: 'acct-1', name: 'alice' });
	const role_grants = [
		create_test_role_grant({ id: 'role_grant-1', actor_id: 'actor-1', role: 'admin' })
	];

	/** Configure the module-level mocks with the given return values. */
	const configure_mocks = (
		overrides: {
			session?: { account_id: string } | undefined;
			account?: Account | undefined;
			actor?: Actor | undefined;
			role_grants?: Array<RoleGrant>;
		} = {}
	): void => {
		vi.mocked(query_session_get_valid).mockImplementation(async () =>
			'session' in overrides ? overrides.session : ({ account_id: account.id } as any)
		);
		vi.mocked(session_touch_fire_and_forget).mockImplementation(async () => {});
		vi.mocked(query_account_by_id).mockImplementation(async () =>
			'account' in overrides ? overrides.account : account
		);
		vi.mocked(query_actor_by_id).mockImplementation(async () =>
			'actor' in overrides ? overrides.actor : actor
		);
		// `resolve_acting_actor` enumerates actors. Mirror the actor mock —
		// when an actor is supplied (or default), return it as the unique
		// account actor; when not, return empty.
		vi.mocked(query_active_actors_by_account).mockImplementation(async () => {
			const a = 'actor' in overrides ? overrides.actor : actor;
			return a ? [a] : [];
		});
		vi.mocked(query_role_grant_find_active_for_actor).mockImplementation(async () =>
			'role_grants' in overrides ? overrides.role_grants! : role_grants
		);
	};

	/** Create a Hono app with session token pre-set and request context middleware. */
	const create_ctx_app = (session_token: string | null = 'test-token'): Hono => {
		const app = new Hono();
		// simulate session middleware setting the token
		app.use('/*', async (c, next) => {
			if (session_token) {
				c.set('auth_session_id', session_token);
			}
			await next();
		});
		app.use('/*', create_request_context_middleware(mock_deps, log));
		app.get('/test', (c) => {
			const account_id = c.get(ACCOUNT_ID_KEY);
			const credential_type = c.get(CREDENTIAL_TYPE_KEY);
			const api_token_id = c.get(AUTH_API_TOKEN_ID_KEY);
			const context = c.get(REQUEST_CONTEXT_KEY);
			return c.json({
				account_id: account_id ?? null,
				credential_type: credential_type ?? null,
				api_token_id: api_token_id ?? null,
				context: context ?? null
			});
		});
		return app;
	};

	test('no session token leaves account_id and credential_type null', async () => {
		configure_mocks();
		const app = create_ctx_app(null);

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.account_id, null);
		assert.strictEqual(body.credential_type, null);
		assert.strictEqual(body.api_token_id, null);
		assert.strictEqual(body.context, null);
	});

	test('invalid session leaves account_id and credential_type null', async () => {
		configure_mocks({ session: undefined });
		const app = create_ctx_app();

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.account_id, null);
		assert.strictEqual(body.credential_type, null);
		assert.strictEqual(body.api_token_id, null);
		assert.strictEqual(body.context, null);
	});

	test('valid session sets account_id and credential_type to session', async () => {
		configure_mocks();
		const app = create_ctx_app();

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.account_id, 'acct-1');
		assert.strictEqual(body.credential_type, 'session');
		assert.strictEqual(body.api_token_id, null);
		// Middleware does not build the request context — that is the
		// dispatcher's authorization phase. `REQUEST_CONTEXT_KEY` stays null
		// after authentication.
		assert.strictEqual(body.context, null);
	});

	test('always calls next() regardless of auth state', async () => {
		configure_mocks({ session: undefined });

		let downstream_called = false;
		const app = new Hono();
		app.use('/*', create_request_context_middleware(mock_deps, log));
		app.get('/test', () => {
			downstream_called = true;
			return new Response('ok');
		});

		await app.request('/test');
		assert.strictEqual(downstream_called, true);
	});

	test('touch failure logs error without blocking the request', async () => {
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const error_log = new Logger('session_touch', { level: 'error' });
		configure_mocks();
		// Simulate the real session_touch_fire_and_forget behavior:
		// it catches the DB error internally and logs it
		vi.mocked(session_touch_fire_and_forget).mockImplementation(
			async (_deps, _token_hash, _pending_effects, mock_log) => {
				try {
					throw new Error('simulated DB failure');
				} catch (err) {
					mock_log.error('Session touch failed:', err);
				}
			}
		);

		// Use a dedicated app with error-level logging so console.error spy triggers
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set('auth_session_id', 'test-token');
			await next();
		});
		app.use('/*', create_request_context_middleware(mock_deps, error_log));
		app.get('/test', (c) => {
			const account_id = c.get(ACCOUNT_ID_KEY);
			const credential_type = c.get(CREDENTIAL_TYPE_KEY);
			return c.json({ account_id: account_id ?? null, credential_type: credential_type ?? null });
		});

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200, 'request should succeed despite touch failure');

		const body = await res.json();
		assert.strictEqual(body.account_id, 'acct-1', 'account_id should still be set');

		// wait for the fire-and-forget promise to settle
		await wait();

		assert.ok(spy_error.mock.calls.length > 0, 'console.error should have been called');
		const first_call = spy_error.mock.calls[0]!;
		assert.ok(
			String(first_call[0]).includes('[session_touch]'),
			'should log with [session_touch] prefix'
		);
	});
});
