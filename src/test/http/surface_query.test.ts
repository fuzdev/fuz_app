/**
 * Tests for surface query functions.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {
	filter_protected_routes,
	filter_public_routes,
	filter_role_routes,
	filter_authenticated_routes,
	filter_keeper_routes,
	filter_routes_for_role,
	routes_by_auth_type,
	filter_routes_by_prefix,
	filter_routes_with_input,
	filter_routes_with_params,
	filter_routes_with_query,
	filter_mutation_routes,
	filter_rate_limited_routes,
	format_route_key,
	surface_auth_summary,
} from '$lib/http/surface_query.js';
import {generate_app_surface, type AppSurface} from '$lib/http/surface.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import {stub_handler, stub_mw} from '$lib/testing/stubs.js';

const test_middleware: Array<MiddlewareSpec> = [{name: 'origin', path: '/api/*', handler: stub_mw}];

const test_specs: Array<RouteSpec> = [
	{
		method: 'GET',
		path: '/health',
		auth: {type: 'none'},
		handler: stub_handler,
		description: 'Health check',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/api/login',
		auth: {type: 'none'},
		handler: stub_handler,
		description: 'Login',
		input: z.strictObject({username: z.string()}),
		output: z.null(),
	},
	{
		method: 'GET',
		path: '/api/me',
		auth: {type: 'authenticated'},
		handler: stub_handler,
		description: 'Current user',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/api/admin/grant',
		auth: {type: 'role', role: 'admin'},
		handler: stub_handler,
		description: 'Grant role',
		input: z.strictObject({role: z.string()}),
		output: z.null(),
	},
	{
		method: 'DELETE',
		path: '/api/admin/revoke',
		auth: {type: 'role', role: 'admin'},
		handler: stub_handler,
		description: 'Revoke role',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/api/keeper/sync',
		auth: {type: 'keeper'},
		handler: stub_handler,
		description: 'Keeper sync',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'GET',
		path: '/api/accounts/:id',
		auth: {type: 'role', role: 'admin'},
		handler: stub_handler,
		description: 'Get account by id',
		input: z.null(),
		output: z.null(),
		params: z.strictObject({id: z.string()}),
	},
	{
		method: 'GET',
		path: '/api/audit-log',
		auth: {type: 'role', role: 'admin'},
		handler: stub_handler,
		description: 'Audit log',
		input: z.null(),
		output: z.null(),
		query: z.strictObject({limit: z.number().optional()}),
	},
	{
		method: 'POST',
		path: '/api/account/login',
		auth: {type: 'none'},
		handler: stub_handler,
		description: 'Login with rate limit',
		input: z.strictObject({username: z.string()}),
		output: z.null(),
		rate_limit: 'ip',
	},
];

const build_surface = (): AppSurface =>
	generate_app_surface({middleware_specs: test_middleware, route_specs: test_specs});

describe('filter_protected_routes', () => {
	test('excludes public routes', () => {
		const result = filter_protected_routes(build_surface());
		assert.strictEqual(result.length, 6);
		assert.ok(result.every((r) => r.auth.type !== 'none'));
	});
});

describe('filter_public_routes', () => {
	test('includes only public routes', () => {
		const result = filter_public_routes(build_surface());
		assert.strictEqual(result.length, 3);
		assert.ok(result.every((r) => r.auth.type === 'none'));
	});
});

describe('filter_role_routes', () => {
	test('includes only role routes with narrowed type', () => {
		const result = filter_role_routes(build_surface());
		assert.strictEqual(result.length, 4);
		assert.ok(result.every((r) => r.auth.role === 'admin'));
	});
});

describe('filter_keeper_routes', () => {
	test('includes only keeper routes', () => {
		const result = filter_keeper_routes(build_surface());
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.path, '/api/keeper/sync');
	});
});

describe('filter_routes_by_prefix', () => {
	test('filters by path prefix', () => {
		const result = filter_routes_by_prefix(build_surface(), '/api/admin');
		assert.strictEqual(result.length, 2);
	});

	test('returns empty for non-matching prefix', () => {
		const result = filter_routes_by_prefix(build_surface(), '/nonexistent');
		assert.strictEqual(result.length, 0);
	});
});

describe('filter_authenticated_routes', () => {
	test('includes only authenticated (no specific role) routes', () => {
		const result = filter_authenticated_routes(build_surface());
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.path, '/api/me');
	});
});

describe('filter_routes_for_role', () => {
	test('filters by specific role name', () => {
		const result = filter_routes_for_role(build_surface(), 'admin');
		assert.strictEqual(result.length, 4);
		assert.ok(result.every((r) => r.auth.role === 'admin'));
	});

	test('returns empty for non-existent role', () => {
		const result = filter_routes_for_role(build_surface(), 'viewer');
		assert.strictEqual(result.length, 0);
	});
});

describe('routes_by_auth_type', () => {
	test('groups routes by auth type with role:name keys', () => {
		const groups = routes_by_auth_type(build_surface());
		assert.strictEqual(groups.get('none')!.length, 3);
		assert.strictEqual(groups.get('authenticated')!.length, 1);
		assert.strictEqual(groups.get('role:admin')!.length, 4);
		assert.strictEqual(groups.get('keeper')!.length, 1);
		assert.strictEqual(groups.size, 4);
	});
});

describe('filter_routes_with_input', () => {
	test('includes only routes with non-null input schema', () => {
		const result = filter_routes_with_input(build_surface());
		assert.strictEqual(result.length, 3);
		assert.ok(result.every((r) => r.input_schema !== null));
	});
});

describe('filter_routes_with_params', () => {
	test('includes only routes with non-null params schema', () => {
		const result = filter_routes_with_params(build_surface());
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.path, '/api/accounts/:id');
	});
});

describe('filter_routes_with_query', () => {
	test('includes only routes with non-null query schema', () => {
		const result = filter_routes_with_query(build_surface());
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.path, '/api/audit-log');
	});
});

describe('filter_mutation_routes', () => {
	test('includes POST, DELETE but not GET routes', () => {
		const result = filter_mutation_routes(build_surface());
		assert.ok(result.every((r) => r.is_mutation));
		assert.ok(result.every((r) => r.method !== 'GET'));
		assert.ok(result.length > 0);
	});
});

describe('filter_rate_limited_routes', () => {
	test('includes only routes with rate_limit_key', () => {
		const result = filter_rate_limited_routes(build_surface());
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.path, '/api/account/login');
		assert.strictEqual(result[0]!.rate_limit_key, 'ip');
	});
});

describe('format_route_key', () => {
	test('formats as METHOD /path', () => {
		const surface = build_surface();
		assert.strictEqual(format_route_key(surface.routes[0]!), 'GET /health');
		assert.strictEqual(format_route_key(surface.routes[1]!), 'POST /api/login');
	});
});

describe('surface_auth_summary', () => {
	test('counts all auth types', () => {
		const summary = surface_auth_summary(build_surface());
		assert.strictEqual(summary.none, 3);
		assert.strictEqual(summary.authenticated, 1);
		assert.strictEqual(summary.role.get('admin'), 4);
		assert.strictEqual(summary.keeper, 1);
	});

	test('role map has correct entries', () => {
		const summary = surface_auth_summary(build_surface());
		assert.strictEqual(summary.role.size, 1);
		assert.ok(summary.role.has('admin'));
	});
});
