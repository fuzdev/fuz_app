/**
 * Tests for `create_surface_route_spec` — metadata and handler behavior.
 *
 * The assembled gate (opt-in mount, 401/403, rule 3 for a narrowed token) is
 * covered end to end in `create_app_server.surface_route.db.test.ts`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_surface_route_spec } from '$lib/server/surface_route.ts';
import { apply_route_specs } from '$lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '$lib/auth/auth_guard_resolver.ts';
import type { AppSurface } from '$lib/http/surface.ts';
import { REQUEST_CONTEXT_KEY, type RequestContext } from '$lib/auth/request_context.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { ACCOUNT_ID_KEY, TEST_CONTEXT_PRESET_KEY } from '$lib/hono_context.ts';
import { create_stub_db } from '$lib/testing/stubs.ts';
import { create_test_context } from '$lib/testing/entities.ts';

const log = new Logger('test', { level: 'off' });
const db = create_stub_db();

/** Create a test request context for an admin. */
const create_test_ctx = (): RequestContext => create_test_context([{ role: ROLE_ADMIN }]);

/** Create a test Hono app with route specs and a preset auth context. */
const create_test_app = (
	specs: Parameters<typeof apply_route_specs>[1],
	auth_ctx: RequestContext
): Hono => {
	const app = new Hono();
	app.use('/*', async (c, next) => {
		(c as any).set(ACCOUNT_ID_KEY, auth_ctx.account.id);
		(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
		(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
		await next();
	});
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return app;
};

const test_surface: AppSurface = {
	middleware: [{ name: 'origin', path: '/api/*', error_schemas: null }],
	routes: [
		{
			method: 'GET',
			path: '/health',
			auth: { account: 'none', actor: 'none' },
			applicable_middleware: [],
			description: 'Health check',
			is_mutation: false,
			transaction: false,
			raw_body: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: { type: 'object', properties: { status: { type: 'string' } } },
			error_schemas: null
		},
		{
			method: 'POST',
			path: '/api/login',
			auth: { account: 'required', actor: 'none' },
			applicable_middleware: ['origin'],
			description: 'Login',
			is_mutation: true,
			transaction: true,
			raw_body: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			error_schemas: { '401': { type: 'object' } }
		}
	],
	rpc_endpoints: [],
	ws_endpoints: [],
	env: [],
	events: [],
	diagnostics: []
};

describe('surface route spec metadata', () => {
	test('method is GET, path is /api/surface, auth is admin + surface:app_surface', () => {
		const spec = create_surface_route_spec({ surface: test_surface });
		assert.strictEqual(spec.method, 'GET');
		assert.strictEqual(spec.path, '/api/surface');
		assert.deepStrictEqual(spec.auth, {
			account: 'required',
			actor: 'required',
			roles: [ROLE_ADMIN],
			required_scope: 'surface:app_surface'
		});
		assert.strictEqual(
			spec.description,
			'Application surface (routes, middleware, schemas) — admin only'
		);
	});
});

describe('surface route handler', () => {
	test('returns the surface data as JSON', async () => {
		const spec = create_surface_route_spec({ surface: test_surface });
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
			rpc_endpoints: [],
			ws_endpoints: [],
			env: [],
			events: [],
			diagnostics: []
		};
		const spec = create_surface_route_spec({ surface: mutable_surface });
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
