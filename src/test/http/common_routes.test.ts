/**
 * Tests for the common route spec factories (health check, account status, surface).
 *
 * Creates test Hono apps from route specs and exercises both metadata
 * and HTTP behavior for authenticated and unauthenticated requests.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_health_route_spec, create_surface_route_spec} from '$lib/http/common_routes.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import type {AppSurface} from '$lib/http/surface.js';
import {REQUEST_CONTEXT_KEY, type RequestContext} from '$lib/auth/request_context.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});
const db = create_stub_db();

/** Create a test request context for an authenticated user. */
const create_test_ctx = (): RequestContext => ({
	account: {
		id: 'acc_1',
		username: 'alice',
		email: 'alice@example.com',
		email_verified: false,
		password_hash: 'hash',
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: '2025-01-01T00:00:00.000Z',
		created_by: null,
		updated_by: null,
	},
	actor: {
		id: 'act_1',
		account_id: 'acc_1',
		name: 'alice',
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: null,
		updated_by: null,
	},
	permits: [],
});

/** Create a test Hono app with route specs and optional auth context. */
const create_test_app = (
	specs: Parameters<typeof apply_route_specs>[1],
	auth_ctx?: RequestContext,
): Hono => {
	const app = new Hono();
	if (auth_ctx) {
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
			await next();
		});
	}
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return app;
};

describe('health route spec metadata', () => {
	test('method is GET, path is /health, auth is none', () => {
		const spec = create_health_route_spec();
		assert.strictEqual(spec.method, 'GET');
		assert.strictEqual(spec.path, '/health');
		assert.deepStrictEqual(spec.auth, {type: 'none'});
		assert.strictEqual(spec.description, 'Health check');
	});
});

describe('health route handler', () => {
	test('returns {status: ok}', async () => {
		const spec = create_health_route_spec();
		const app = create_test_app([spec]);
		const res = await app.request('/health');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.status, 'ok');
		assert.deepStrictEqual(Object.keys(body), ['status']);
	});

	test('responds 200 regardless of auth headers', async () => {
		const spec = create_health_route_spec();
		const app = create_test_app([spec]);

		// With cookie header
		const res_cookie = await app.request('/health', {
			headers: {cookie: 'test_session=some_value'},
		});
		assert.strictEqual(res_cookie.status, 200);

		// With bearer header
		const res_bearer = await app.request('/health', {
			headers: {authorization: 'Bearer some_token'},
		});
		assert.strictEqual(res_bearer.status, 200);

		// With both
		const res_both = await app.request('/health', {
			headers: {cookie: 'test_session=some_value', authorization: 'Bearer some_token'},
		});
		assert.strictEqual(res_both.status, 200);
	});
});

const test_surface: AppSurface = {
	middleware: [{name: 'origin', path: '/api/*', error_schemas: null}],
	routes: [
		{
			method: 'GET',
			path: '/health',
			auth: {type: 'none'},
			applicable_middleware: [],
			description: 'Health check',
			is_mutation: false,
			transaction: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: {type: 'object', properties: {status: {type: 'string'}}},
			error_schemas: null,
		},
		{
			method: 'POST',
			path: '/api/login',
			auth: {type: 'authenticated'},
			applicable_middleware: ['origin'],
			description: 'Login',
			is_mutation: true,
			transaction: true,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: {type: 'object'},
			output_schema: {type: 'object'},
			error_schemas: {'401': {type: 'object'}},
		},
	],
	env: [],
	events: [],
	diagnostics: [],
};

describe('surface route spec metadata', () => {
	test('method is GET, path is /api/surface, auth is authenticated', () => {
		const spec = create_surface_route_spec({surface: test_surface});
		assert.strictEqual(spec.method, 'GET');
		assert.strictEqual(spec.path, '/api/surface');
		assert.deepStrictEqual(spec.auth, {type: 'authenticated'});
		assert.strictEqual(spec.description, 'Application surface (routes, middleware, schemas)');
	});
});

describe('surface route handler', () => {
	test('returns the surface data as JSON', async () => {
		const spec = create_surface_route_spec({surface: test_surface});
		const ctx = create_test_ctx();
		const app = create_test_app([spec], ctx);
		const res = await app.request('/api/surface');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.routes.length, 2);
		assert.strictEqual(body.middleware.length, 1);
		assert.strictEqual(body.routes[0].method, 'GET');
		assert.strictEqual(body.routes[0].path, '/health');
		assert.strictEqual(body.middleware[0].name, 'origin');
	});

	test('reflects the surface reference (not a snapshot)', async () => {
		const mutable_surface: AppSurface = {
			middleware: [],
			routes: [],
			env: [],
			events: [],
			diagnostics: [],
		};
		const spec = create_surface_route_spec({surface: mutable_surface});
		const ctx = create_test_ctx();
		const app = create_test_app([spec], ctx);

		const res1 = await app.request('/api/surface');
		const body1 = await res1.json();
		assert.strictEqual(body1.routes.length, 0);

		// mutate the surface
		mutable_surface.routes.push(test_surface.routes[0]!);

		const res2 = await app.request('/api/surface');
		const body2 = await res2.json();
		assert.strictEqual(body2.routes.length, 1);
	});
});
