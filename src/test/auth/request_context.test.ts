/**
 * Tests for request context — permit helpers, auth guards, and context middleware.
 *
 * @module
 */

import {describe, assert, test, vi, afterEach} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {Hono} from 'hono';
import {wait} from '@fuzdev/fuz_util/async.js';

import {
	has_role,
	require_auth,
	require_role,
	create_request_context_middleware,
	REQUEST_CONTEXT_KEY,
} from '$lib/auth/request_context.js';
import {CREDENTIAL_TYPE_KEY} from '$lib/hono_context.js';
import type {Account, Actor, Permit} from '$lib/auth/account_schema.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '$lib/http/error_schemas.js';
import {
	create_test_account,
	create_test_actor,
	create_test_permit,
	create_test_context,
} from '$lib/testing/entities.js';
import type {QueryDeps} from '$lib/db/query_deps.js';
import {query_session_get_valid, session_touch_fire_and_forget} from '$lib/auth/session_queries.js';
import {query_account_by_id, query_actor_by_account} from '$lib/auth/account_queries.js';
import {query_permit_find_active_for_actor} from '$lib/auth/permit_queries.js';

const log = new Logger('test', {level: 'off'});

const mock_deps: QueryDeps = {db: {} as any};

vi.mock('$lib/auth/session_queries.js', async (import_original) => {
	const original = await import_original<typeof import('$lib/auth/session_queries.js')>();
	return {
		...original,
		// Keep hash_session_token real (pure function)
		hash_session_token: original.hash_session_token,
		query_session_get_valid: vi.fn(),
		session_touch_fire_and_forget: vi.fn(),
	};
});

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_account: vi.fn(),
}));

vi.mock('$lib/auth/permit_queries.js', () => ({
	query_permit_find_active_for_actor: vi.fn(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('has_role', () => {
	test('returns true for matching active permit', () => {
		const ctx = create_test_context([{role: 'admin'}]);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('returns false for missing role', () => {
		const ctx = create_test_context([{role: 'admin'}]);
		assert.strictEqual(has_role(ctx, 'keeper'), false);
	});

	test('returns false for revoked permit', () => {
		const ctx = create_test_context([{role: 'admin', revoked_at: '2024-01-02T00:00:00Z'}]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns false for expired permit', () => {
		const past = new Date(Date.now() - 60000).toISOString();
		const ctx = create_test_context([{role: 'admin', expires_at: past}]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns true for non-expired permit', () => {
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = create_test_context([{role: 'admin', expires_at: future}]);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('returns true when one of multiple permits matches', () => {
		const ctx = create_test_context([{role: 'keeper'}, {role: 'admin'}]);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('returns false with empty permits', () => {
		const ctx = create_test_context([]);
		ctx.permits = [];
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('role check is case-sensitive — "Admin" does not match "admin"', () => {
		const ctx = create_test_context([{role: 'admin'}]);
		assert.strictEqual(has_role(ctx, 'Admin'), false);
		assert.strictEqual(has_role(ctx, 'ADMIN'), false);
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('role check is exact — "admin " (trailing space) does not match "admin"', () => {
		const ctx = create_test_context([{role: 'admin'}]);
		assert.strictEqual(has_role(ctx, 'admin '), false);
		assert.strictEqual(has_role(ctx, ' admin'), false);
	});

	test('returns true for permit with null expires_at (no expiry)', () => {
		const ctx = create_test_context([{role: 'keeper', expires_at: null}]);
		assert.strictEqual(has_role(ctx, 'keeper'), true);
	});

	test('rejects permit that expires between context load and role check', () => {
		vi.useFakeTimers();
		try {
			const now = Date.now();
			const soon = new Date(now + 5000).toISOString();
			const ctx = create_test_context([{role: 'admin', expires_at: soon}]);
			assert.strictEqual(has_role(ctx, 'admin'), true);
			vi.advanceTimersByTime(6000);
			assert.strictEqual(has_role(ctx, 'admin'), false);
		} finally {
			vi.useRealTimers();
		}
	});

	test('rejects revoked permit even with future expires_at', () => {
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = create_test_context([
			{role: 'admin', revoked_at: '2024-06-01T00:00:00Z', expires_at: future},
		]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns false when role matches but all permits for that role are revoked', () => {
		const ctx = create_test_context([
			{role: 'admin', revoked_at: '2024-06-01T00:00:00Z'},
			{role: 'admin', revoked_at: '2024-07-01T00:00:00Z'},
		]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('handles permit with expires_at at Unix epoch boundary', () => {
		const ctx = create_test_context([{role: 'admin', expires_at: '1970-01-01T00:00:00Z'}]);
		assert.strictEqual(has_role(ctx, 'admin'), false);
	});

	test('returns true when same role has one revoked and one active permit', () => {
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = create_test_context([
			{role: 'admin', revoked_at: '2024-06-01T00:00:00Z', expires_at: future},
			{role: 'admin', revoked_at: null, expires_at: future},
		]);
		// some() finds the active permit even when another is revoked
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});
});

describe('require_auth', () => {
	test('returns 401 when no request context is set', async () => {
		const app = new Hono();
		app.use('/*', require_auth);
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('passes through when request context is set', async () => {
		const ctx = create_test_context([{role: 'admin'}]);
		const app = new Hono();
		// set context before require_auth
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, ctx);
			await next();
		});
		app.use('/*', require_auth);
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});
});

describe('require_role', () => {
	test('returns 401 when no request context is set', async () => {
		const app = new Hono();
		app.use('/*', require_role('admin'));
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('returns 403 when context lacks required role', async () => {
		const ctx = create_test_context([{role: 'user'}]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, ctx);
			await next();
		});
		app.use('/*', require_role('admin'));
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_role, 'admin');
	});

	test('passes through when context has required role', async () => {
		const ctx = create_test_context([{role: 'admin'}]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, ctx);
			await next();
		});
		app.use('/*', require_role('admin'));
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('403 includes required_role in response body', async () => {
		const ctx = create_test_context([{role: 'user'}]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, ctx);
			await next();
		});
		app.use('/*', require_role('keeper'));
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_role, 'keeper');
	});

	test('expired permit causes 403 even if role matches', async () => {
		const past = new Date(Date.now() - 60000).toISOString();
		const ctx = create_test_context([{role: 'admin', expires_at: past}]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, ctx);
			await next();
		});
		app.use('/*', require_role('admin'));
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_role, 'admin');
	});

	test('revoked permit causes 403 even if role matches', async () => {
		const ctx = create_test_context([{role: 'admin', revoked_at: '2024-01-01T00:00:00Z'}]);
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, ctx);
			await next();
		});
		app.use('/*', require_role('admin'));
		app.get('/test', (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
	});
});

describe('has_role — TOCTOU snapshot behavior', () => {
	test('context snapshot is immune to external permit changes', () => {
		// simulates: permit loaded in middleware, then "revoked" externally before handler checks
		const ctx = create_test_context([{role: 'admin'}]);
		assert.strictEqual(has_role(ctx, 'admin'), true);

		// external mutation: clear permits (simulating DB revoke happening after middleware)
		// the snapshot model means this mutation requires explicit refresh_permits() call
		const snapshot_permits = ctx.permits;
		assert.strictEqual(has_role(ctx, 'admin'), true);
		// only explicit mutation changes the result
		ctx.permits = [];
		assert.strictEqual(has_role(ctx, 'admin'), false);
		// restore to demonstrate the snapshot was independent
		ctx.permits = snapshot_permits;
		assert.strictEqual(has_role(ctx, 'admin'), true);
	});

	test('expiry-based TOCTOU: permit expires between middleware and handler', () => {
		vi.useFakeTimers();
		try {
			const now = Date.now();
			// permit expires in 2 seconds
			const soon = new Date(now + 2000).toISOString();
			const ctx = create_test_context([{role: 'admin', expires_at: soon}]);

			// middleware time: permit is active
			assert.strictEqual(has_role(ctx, 'admin'), true);

			// handler time: 3 seconds later, permit has expired
			vi.advanceTimersByTime(3000);
			assert.strictEqual(has_role(ctx, 'admin'), false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('create_request_context_middleware', () => {
	const account = create_test_account({id: 'acct-1', username: 'alice'});
	const actor = create_test_actor({id: 'actor-1', account_id: 'acct-1', name: 'alice'});
	const permits = [create_test_permit({id: 'permit-1', actor_id: 'actor-1', role: 'admin'})];

	/** Configure the module-level mocks with the given return values. */
	const configure_mocks = (
		overrides: {
			session?: {account_id: string} | undefined;
			account?: Account | undefined;
			actor?: Actor | undefined;
			permits?: Array<Permit>;
		} = {},
	): void => {
		vi.mocked(query_session_get_valid).mockImplementation(async () =>
			'session' in overrides ? overrides.session : ({account_id: account.id} as any),
		);
		vi.mocked(session_touch_fire_and_forget).mockImplementation(async () => {});
		vi.mocked(query_account_by_id).mockImplementation(async () =>
			'account' in overrides ? overrides.account : account,
		);
		vi.mocked(query_actor_by_account).mockImplementation(async () =>
			'actor' in overrides ? overrides.actor : actor,
		);
		vi.mocked(query_permit_find_active_for_actor).mockImplementation(async () =>
			'permits' in overrides ? overrides.permits! : permits,
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
			const ctx = c.get(REQUEST_CONTEXT_KEY);
			const credential_type = c.get(CREDENTIAL_TYPE_KEY);
			return c.json({context: ctx, credential_type: credential_type ?? null});
		});
		return app;
	};

	test('no session token sets request_context to null and credential_type to null', async () => {
		configure_mocks();
		const app = create_ctx_app(null);

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('invalid session sets request_context to null and credential_type to null', async () => {
		configure_mocks({session: undefined});
		const app = create_ctx_app();

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('valid session builds full request context and sets credential_type to session', async () => {
		configure_mocks();
		const app = create_ctx_app();

		const res = await app.request('/test');
		const body = await res.json();
		assert.ok(body.context);
		assert.strictEqual(body.context.account.id, 'acct-1');
		assert.strictEqual(body.context.actor.id, 'actor-1');
		assert.strictEqual(body.context.permits.length, 1);
		assert.strictEqual(body.context.permits[0].role, 'admin');
		assert.strictEqual(body.credential_type, 'session');
	});

	test('account not found sets request_context to null', async () => {
		configure_mocks({account: undefined});
		const app = create_ctx_app();

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('actor not found sets request_context to null', async () => {
		configure_mocks({actor: undefined});
		const app = create_ctx_app();

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('always calls next() regardless of auth state', async () => {
		configure_mocks({session: undefined});

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
		const error_log = new Logger('session_touch', {level: 'error'});
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
			},
		);

		// Use a dedicated app with error-level logging so console.error spy triggers
		const app = new Hono();
		app.use('/*', async (c, next) => {
			c.set('auth_session_id', 'test-token');
			await next();
		});
		app.use('/*', create_request_context_middleware(mock_deps, error_log));
		app.get('/test', (c) => {
			const ctx = c.get(REQUEST_CONTEXT_KEY);
			const credential_type = c.get(CREDENTIAL_TYPE_KEY);
			return c.json({context: ctx, credential_type: credential_type ?? null});
		});

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200, 'request should succeed despite touch failure');

		const body = await res.json();
		assert.ok(body.context, 'request context should still be set');

		// wait for the fire-and-forget promise to settle
		await wait();

		assert.ok(spy_error.mock.calls.length > 0, 'console.error should have been called');
		const first_call = spy_error.mock.calls[0]!;
		assert.ok(
			String(first_call[0]).includes('[session_touch]'),
			'should log with [session_touch] prefix',
		);
	});
});
