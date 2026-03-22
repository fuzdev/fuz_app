/**
 * Adversarial auth attack surface tests.
 *
 * Tests the route spec system's auth enforcement by creating a test app
 * from specs and hitting every route with adversarial inputs.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {apply_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import {generate_app_surface} from '$lib/http/surface.js';
import {
	REQUEST_CONTEXT_KEY,
	require_auth,
	require_role,
	type RequestContext,
} from '$lib/auth/request_context.js';
import {SESSION_COOKIE_OPTIONS} from '$lib/auth/session_cookie.js';
import {API_TOKEN_PREFIX} from '$lib/auth/api_token.js';
import {PASSWORD_LENGTH_MIN} from '$lib/auth/password.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '$lib/http/error_schemas.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});
const stub_db = create_stub_db();

/** Create a test request context with optional role. */
const create_test_ctx = (role?: string): RequestContext => ({
	account: {
		id: 'acc_1',
		username: 'alice',
		password_hash: 'hash',
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		created_by: null,
		updated_by: null,
		email: null,
		email_verified: false,
	},
	actor: {
		id: 'act_1',
		account_id: 'acc_1',
		name: 'alice',
		created_at: new Date().toISOString(),
		updated_at: null,
		updated_by: null,
	},
	permits: role
		? [
				{
					id: 'perm_1',
					actor_id: 'act_1',
					role,
					created_at: new Date().toISOString(),
					expires_at: null,
					revoked_at: null,
					revoked_by: null,
					granted_by: null,
				},
			]
		: [],
});

/** Create a test Hono app with auth middleware simulation and route specs. */
const create_test_app = (specs: Array<RouteSpec>, auth_ctx?: RequestContext): Hono => {
	const app = new Hono();
	// Simulate request context middleware — sets context if provided
	if (auth_ctx) {
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
			await next();
		});
	}
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, stub_db);
	return app;
};

/** Example route specs covering all auth types for testing. */
const test_route_specs: Array<RouteSpec> = [
	{
		method: 'GET',
		path: '/public',
		auth: {type: 'none'},
		handler: (c) => c.json({ok: true}),
		description: 'Public endpoint',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'GET',
		path: '/authed',
		auth: {type: 'authenticated'},
		handler: (c) => c.json({ok: true}),
		description: 'Requires authentication',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/admin',
		auth: {type: 'role', role: 'admin'},
		handler: (c) => c.json({ok: true}),
		description: 'Requires admin role',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/keeper',
		auth: {type: 'keeper'},
		handler: (c) => c.json({ok: true}),
		description: 'Requires keeper credentials',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'DELETE',
		path: '/keeper-delete',
		auth: {type: 'keeper'},
		handler: (c) => c.json({ok: true}),
		description: 'Requires keeper credentials (DELETE)',
		input: z.null(),
		output: z.null(),
	},
];

describe('per-route automated auth tests', () => {
	const protected_routes = test_route_specs.filter((r) => r.auth.type !== 'none');

	for (const route of protected_routes) {
		test(`${route.method} ${route.path} — unauthenticated → 401`, async () => {
			const app = create_test_app(test_route_specs); // no auth context
			const res = await app.request(route.path, {method: route.method});
			assert.strictEqual(
				res.status,
				401,
				`Expected 401 for unauthenticated ${route.method} ${route.path}`,
			);
		});
	}

	const role_routes = test_route_specs.filter(
		(r): r is RouteSpec & {auth: {type: 'role'; role: string}} => r.auth.type === 'role',
	);

	for (const route of role_routes) {
		test(`${route.method} ${route.path} — wrong role → 403`, async () => {
			// Use a role that doesn't match
			const wrong_role = route.auth.role === 'admin' ? 'viewer' : 'admin';
			const app = create_test_app(test_route_specs, create_test_ctx(wrong_role));
			const res = await app.request(route.path, {method: route.method});
			assert.strictEqual(
				res.status,
				403,
				`Expected 403 for wrong role on ${route.method} ${route.path}`,
			);
		});

		test(`${route.method} ${route.path} — no role → 403`, async () => {
			const app = create_test_app(test_route_specs, create_test_ctx()); // authed but no role
			const res = await app.request(route.path, {method: route.method});
			assert.strictEqual(
				res.status,
				403,
				`Expected 403 for no role on ${route.method} ${route.path}`,
			);
		});

		test(`${route.method} ${route.path} — correct role → 200`, async () => {
			const app = create_test_app(test_route_specs, create_test_ctx(route.auth.role));
			const res = await app.request(route.path, {method: route.method});
			assert.strictEqual(
				res.status,
				200,
				`Expected 200 for correct role on ${route.method} ${route.path}`,
			);
		});
	}
});

describe('targeted adversarial tests', () => {
	test('expired permit does not grant access', async () => {
		const ctx = create_test_ctx();
		ctx.permits = [
			{
				id: 'perm_expired',
				actor_id: 'act_1',
				role: 'admin',
				created_at: new Date().toISOString(),
				expires_at: new Date(Date.now() - 86400_000).toISOString(), // expired yesterday
				revoked_at: null,
				revoked_by: null,
				granted_by: null,
			},
		];
		const app = create_test_app(test_route_specs, ctx);
		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('revoked permit does not grant access', async () => {
		const ctx = create_test_ctx();
		ctx.permits = [
			{
				id: 'perm_revoked',
				actor_id: 'act_1',
				role: 'admin',
				created_at: new Date().toISOString(),
				expires_at: null,
				revoked_at: new Date().toISOString(),
				revoked_by: 'someone',
				granted_by: null,
			},
		];
		const app = create_test_app(test_route_specs, ctx);
		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('admin cannot access keeper routes', async () => {
		const app = create_test_app(test_route_specs, create_test_ctx('admin'));
		const res = await app.request('/keeper', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('keeper cannot access admin routes', async () => {
		const app = create_test_app(test_route_specs, create_test_ctx('keeper'));
		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('require_auth returns 401 with JSON body', async () => {
		const app = new Hono();
		app.get('/test', require_auth, (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('require_role returns 403 with role info', async () => {
		const app = new Hono();
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, create_test_ctx('viewer'));
			await next();
		});
		app.get('/test', require_role('admin'), (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_role, 'admin');
	});
});

describe('static property assertions', () => {
	test('session cookie uses httpOnly', () => {
		assert.strictEqual(SESSION_COOKIE_OPTIONS.httpOnly, true);
	});

	test('session cookie uses secure', () => {
		assert.strictEqual(SESSION_COOKIE_OPTIONS.secure, true);
	});

	test('session cookie uses sameSite strict', () => {
		assert.strictEqual(SESSION_COOKIE_OPTIONS.sameSite, 'strict');
	});

	test('API token prefix is scannable', () => {
		assert.strictEqual(API_TOKEN_PREFIX, 'secret_fuz_token_');
	});

	test('minimum password length is 12', () => {
		assert.strictEqual(PASSWORD_LENGTH_MIN, 12);
	});
});

describe('surface generation integrity', () => {
	test('every auth type appears in surface', () => {
		const middleware: Array<MiddlewareSpec> = [];
		const surface = generate_app_surface({
			middleware_specs: middleware,
			route_specs: test_route_specs,
		});

		const auth_types = new Set(surface.routes.map((r) => r.auth.type));
		assert.ok(auth_types.has('none'));
		assert.ok(auth_types.has('authenticated'));
		assert.ok(auth_types.has('role'));
		assert.ok(auth_types.has('keeper'));
	});

	test('surface route count matches spec count', () => {
		const surface = generate_app_surface({middleware_specs: [], route_specs: test_route_specs});
		assert.strictEqual(surface.routes.length, test_route_specs.length);
	});

	test('surface is deterministic', () => {
		const surface1 = generate_app_surface({middleware_specs: [], route_specs: test_route_specs});
		const surface2 = generate_app_surface({middleware_specs: [], route_specs: test_route_specs});
		assert.strictEqual(JSON.stringify(surface1), JSON.stringify(surface2));
	});
});
