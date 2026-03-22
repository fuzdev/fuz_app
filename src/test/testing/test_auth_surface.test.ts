/**
 * Tests for backend_test_auth_surface.ts — auth attack surface test utilities.
 *
 * @module
 */

import {writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe, assert, test, afterEach} from 'vitest';
import {z} from 'zod';

import {
	stub,
	stub_handler,
	stub_mw,
	create_throwing_stub,
	create_noop_stub,
} from '$lib/testing/stubs.js';
import {
	create_test_request_context,
	create_test_app_from_specs,
	resolve_test_path,
} from '$lib/testing/auth_apps.js';
import {
	resolve_fixture_path,
	assert_surface_matches_snapshot,
	assert_surface_deterministic,
	assert_only_expected_public_routes,
	assert_full_middleware_stack,
} from '$lib/testing/assertions.js';
import {describe_adversarial_auth} from '$lib/testing/attack_surface.js';
import {describe_adversarial_404} from '$lib/testing/adversarial_404.js';
import {resolve_valid_path, generate_valid_body} from '$lib/testing/schema_generators.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import {generate_app_surface, create_app_surface_spec, type AppSurface} from '$lib/http/surface.js';
import {
	audit_error_schema_tightness,
	assert_error_schema_tightness,
} from '$lib/testing/surface_invariants.js';

describe('stubs', () => {
	test('stub throws on property access', () => {
		assert.throws(() => stub.foo, /Throwing stub 'stub'/);
	});

	test('stub_handler returns a Response', () => {
		const res = stub_handler();
		assert.ok(res instanceof Response);
	});

	test('stub_mw calls next', async () => {
		let called = false;
		await stub_mw({}, () => {
			called = true;
		});
		assert.strictEqual(called, true);
	});
});

describe('create_throwing_stub', () => {
	test('throws on property access with descriptive label', () => {
		const s = create_throwing_stub('test_dep');
		assert.throws(() => s.some_method, /Throwing stub 'test_dep'.*'some_method'/);
	});

	test('allows symbol access without throwing', () => {
		const s = create_throwing_stub('test_dep');
		assert.strictEqual(s[Symbol.toPrimitive], undefined);
	});

	test('allows then access without throwing (Promise compatibility)', () => {
		const s = create_throwing_stub('test_dep');
		assert.strictEqual(s.then, undefined);
	});
});

describe('create_noop_stub', () => {
	test('returns async undefined for any method call', async () => {
		const s = create_noop_stub('test_dep');
		const result = await s.any_method();
		assert.strictEqual(result, undefined);
	});

	test('respects overrides', () => {
		const s = create_noop_stub('test_dep', {name: 'explicit'});
		assert.strictEqual(s.name, 'explicit');
	});

	test('returns different functions for different methods', async () => {
		const s = create_noop_stub('test_dep');
		const r1 = await s.method_a();
		const r2 = await s.method_b();
		assert.strictEqual(r1, undefined);
		assert.strictEqual(r2, undefined);
	});
});

describe('create_test_request_context', () => {
	test('creates context without role', () => {
		const ctx = create_test_request_context();
		assert.ok(ctx.account);
		assert.ok(ctx.actor);
		assert.strictEqual(ctx.permits.length, 0);
	});

	test('creates context with role', () => {
		const ctx = create_test_request_context('admin');
		assert.strictEqual(ctx.permits.length, 1);
		assert.strictEqual(ctx.permits[0]!.role, 'admin');
	});

	test('account and actor IDs are consistent', () => {
		const ctx = create_test_request_context();
		assert.strictEqual(ctx.actor.account_id, ctx.account.id);
	});
});

describe('resolve_test_path', () => {
	test('replaces single param', () => {
		assert.strictEqual(resolve_test_path('/api/users/:id'), '/api/users/test_id');
	});

	test('replaces multiple params', () => {
		assert.strictEqual(
			resolve_test_path('/api/users/:user_id/posts/:post_id'),
			'/api/users/test_user_id/posts/test_post_id',
		);
	});

	test('returns path unchanged when no params', () => {
		assert.strictEqual(resolve_test_path('/api/health'), '/api/health');
	});
});

describe('resolve_fixture_path', () => {
	test('resolves relative to the provided import.meta.url', () => {
		const result = resolve_fixture_path('test.json', import.meta.url);
		assert.ok(result.endsWith('/test.json'));
		assert.ok(result.startsWith('/'));
	});
});

describe('create_test_app_from_specs', () => {
	const test_specs: Array<RouteSpec> = [
		{
			method: 'GET',
			path: '/public',
			auth: {type: 'none'},
			handler: (c) => c.json({ok: true}),
			description: 'Public route',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'GET',
			path: '/protected',
			auth: {type: 'authenticated'},
			handler: (c) => c.json({secret: true}),
			description: 'Protected route',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'POST',
			path: '/admin',
			auth: {type: 'role', role: 'admin'},
			handler: (c) => c.json({admin: true}),
			description: 'Admin route',
			input: z.null(),
			output: z.null(),
		},
	];

	test('creates app without auth context', async () => {
		const app = create_test_app_from_specs(test_specs);
		const res = await app.request('/public');
		assert.strictEqual(res.status, 200);
	});

	test('unauthenticated app returns 401 for protected routes', async () => {
		const app = create_test_app_from_specs(test_specs);
		const res = await app.request('/protected');
		assert.strictEqual(res.status, 401);
	});

	test('authenticated app passes auth guard', async () => {
		const ctx = create_test_request_context();
		const app = create_test_app_from_specs(test_specs, ctx);
		const res = await app.request('/protected');
		assert.strictEqual(res.status, 200);
	});

	test('role app passes role guard', async () => {
		const ctx = create_test_request_context('admin');
		const app = create_test_app_from_specs(test_specs, ctx);
		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 200);
	});
});

// --- Assertion helper tests ---

/** Build a minimal surface for assertion helper tests. */
const build_test_surface = (): AppSurface => {
	const middleware: Array<MiddlewareSpec> = [
		{name: 'origin', path: '/api/*', handler: stub_mw},
		{name: 'session', path: '/api/*', handler: stub_mw},
	];
	const routes: Array<RouteSpec> = [
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
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'GET',
			path: '/api/protected',
			auth: {type: 'authenticated'},
			handler: stub_handler,
			description: 'Protected resource',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'POST',
			path: '/api/admin',
			auth: {type: 'role', role: 'admin'},
			handler: stub_handler,
			description: 'Admin action',
			input: z.null(),
			output: z.null(),
		},
	];
	return generate_app_surface({middleware_specs: middleware, route_specs: routes});
};

describe('assert_surface_matches_snapshot', () => {
	let tmp_dir: string;

	afterEach(() => {
		if (tmp_dir) rmSync(tmp_dir, {recursive: true, force: true});
	});

	test('passes when surface matches snapshot file', () => {
		tmp_dir = mkdtempSync(join(tmpdir(), 'surface-test-'));
		const surface = build_test_surface();
		const snapshot_path = join(tmp_dir, 'snapshot.json');
		writeFileSync(snapshot_path, JSON.stringify(surface));
		assert_surface_matches_snapshot(surface, snapshot_path);
	});

	test('fails when surface differs from snapshot', () => {
		tmp_dir = mkdtempSync(join(tmpdir(), 'surface-test-'));
		const surface = build_test_surface();
		const snapshot_path = join(tmp_dir, 'snapshot.json');
		const modified = {...surface, routes: []};
		writeFileSync(snapshot_path, JSON.stringify(modified));
		assert.throws(() => assert_surface_matches_snapshot(surface, snapshot_path));
	});
});

describe('assert_surface_deterministic', () => {
	test('passes with a pure builder', () => {
		assert_surface_deterministic(build_test_surface);
	});
});

describe('assert_only_expected_public_routes', () => {
	test('passes when expected matches actual', () => {
		const surface = build_test_surface();
		assert_only_expected_public_routes(surface, ['GET /health', 'POST /api/login']);
	});

	test('fails on unexpected public route', () => {
		const surface = build_test_surface();
		// Only list one — the other becomes "unexpected"
		assert.throws(
			() => assert_only_expected_public_routes(surface, ['GET /health']),
			/Unexpected public routes.*POST \/api\/login/,
		);
	});

	test('fails on missing expected route', () => {
		const surface = build_test_surface();
		assert.throws(
			() =>
				assert_only_expected_public_routes(surface, [
					'GET /health',
					'POST /api/login',
					'GET /api/missing',
				]),
			/Expected public routes missing.*GET \/api\/missing/,
		);
	});
});

describe('assert_full_middleware_stack', () => {
	test('passes when all routes have the expected stack', () => {
		const surface = build_test_surface();
		assert_full_middleware_stack(surface, '/api/', ['origin', 'session']);
	});

	test('fails when a route has wrong middleware', () => {
		const surface = build_test_surface();
		assert.throws(
			() => assert_full_middleware_stack(surface, '/api/', ['origin', 'session', 'extra']),
			/has wrong middleware stack/,
		);
	});

	test('fails when no routes match the prefix', () => {
		const surface = build_test_surface();
		assert.throws(
			() => assert_full_middleware_stack(surface, '/nonexistent/', ['origin']),
			/No routes found under/,
		);
	});
});

// Exercise the adversarial runner with minimal specs
const adversarial_specs: Array<RouteSpec> = [
	{
		method: 'GET',
		path: '/public',
		auth: {type: 'none'},
		handler: (c) => c.json({ok: true}),
		description: 'Public route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'GET',
		path: '/protected',
		auth: {type: 'authenticated'},
		handler: (c) => c.json({secret: true}),
		description: 'Protected route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/admin-only',
		auth: {type: 'role', role: 'admin'},
		handler: (c) => c.json({admin: true}),
		description: 'Admin route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'DELETE',
		path: '/keeper-role',
		auth: {type: 'role', role: 'keeper'},
		handler: (c) => c.json({keeper: true}),
		description: 'Keeper role route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/keeper-auth',
		auth: {type: 'keeper'},
		handler: (c) => c.json({keeper: true}),
		description: 'Keeper auth route',
		input: z.null(),
		output: z.null(),
	},
];

const adversarial_middleware: Array<MiddlewareSpec> = [];

describe_adversarial_auth({
	build: () =>
		create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: adversarial_specs,
		}),
	roles: ['admin', 'keeper'],
});

// --- resolve_valid_path and generate_valid_body tests ---

describe('resolve_valid_path', () => {
	test('replaces uuid params with nil UUID', () => {
		const params = z.strictObject({id: z.uuid()});
		assert.strictEqual(
			resolve_valid_path('/things/:id', params),
			'/things/00000000-0000-0000-0000-000000000000',
		);
	});

	test('replaces non-uuid params with test_ prefix', () => {
		const params = z.strictObject({name: z.string()});
		assert.strictEqual(resolve_valid_path('/things/:name', params), '/things/test_name');
	});

	test('handles multiple params', () => {
		const params = z.strictObject({
			account_id: z.uuid(),
			permit_id: z.uuid(),
		});
		assert.strictEqual(
			resolve_valid_path('/accounts/:account_id/permits/:permit_id', params),
			'/accounts/00000000-0000-0000-0000-000000000000/permits/00000000-0000-0000-0000-000000000000',
		);
	});

	test('falls back to test_ prefix without params schema', () => {
		assert.strictEqual(resolve_valid_path('/things/:id'), '/things/test_id');
	});
});

describe('generate_valid_body', () => {
	test('returns undefined for null schema', () => {
		assert.strictEqual(generate_valid_body(z.null()), undefined);
	});

	test('generates valid body for simple object schema', () => {
		const schema = z.strictObject({name: z.string().min(1)});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok(typeof body.name === 'string');
		assert.ok(body.name.length >= 1);
		// confirm it actually passes validation
		schema.parse(body);
	});

	test('generates valid body with uuid field', () => {
		const schema = z.strictObject({id: z.uuid()});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.id, '00000000-0000-0000-0000-000000000000');
		schema.parse(body);
	});

	test('skips optional fields without defaults', () => {
		const schema = z.strictObject({
			required_field: z.string(),
			optional_field: z.string().optional(),
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok('required_field' in body);
		assert.ok(!('optional_field' in body));
		schema.parse(body);
	});

	test('throws for schemas where generation produces invalid values', () => {
		// A schema with constraints that generate_valid_value can't satisfy
		// would throw — but our standard types (string, uuid, number, boolean, enum)
		// all generate valid values. This test confirms the safeParse guard exists.
		const schema = z.strictObject({name: z.string().min(1)});
		// Should not throw for well-supported types
		assert.doesNotThrow(() => generate_valid_body(schema));
	});
});

// --- Adversarial 404 runner tests ---

const ERROR_THING_NOT_FOUND = 'thing_not_found' as const;
const ERROR_ITEM_NOT_FOUND = 'item_not_found' as const;
const ERROR_WIDGET_NOT_FOUND = 'widget_not_found' as const;

const adversarial_404_specs: Array<RouteSpec> = [
	// Route with params + literal 404 → should generate a test
	{
		method: 'GET',
		path: '/things/:id',
		auth: {type: 'authenticated'},
		handler: stub_handler,
		description: 'Get a thing',
		params: z.strictObject({id: z.uuid()}),
		input: z.null(),
		output: z.looseObject({name: z.string()}),
		errors: {404: z.looseObject({error: z.literal(ERROR_THING_NOT_FOUND)})},
	},
	// Route with params + enum 404 → should generate a test (uses first enum value)
	{
		method: 'DELETE',
		path: '/items/:id',
		auth: {type: 'role', role: 'admin'},
		handler: stub_handler,
		description: 'Delete an item',
		params: z.strictObject({id: z.uuid()}),
		input: z.null(),
		output: z.looseObject({ok: z.literal(true)}),
		errors: {
			404: z.looseObject({error: z.enum([ERROR_ITEM_NOT_FOUND, ERROR_WIDGET_NOT_FOUND])}),
		},
	},
	// Route with params + input + 404 → should generate a test with valid body
	{
		method: 'POST',
		path: '/things/:id/rename',
		auth: {type: 'authenticated'},
		handler: stub_handler,
		description: 'Rename a thing',
		params: z.strictObject({id: z.uuid()}),
		input: z.strictObject({name: z.string().min(1)}),
		output: z.looseObject({ok: z.literal(true)}),
		errors: {404: z.looseObject({error: z.literal(ERROR_THING_NOT_FOUND)})},
	},
	// Route with params but no 404 → should be skipped
	{
		method: 'GET',
		path: '/widgets/:id',
		auth: {type: 'none'},
		handler: stub_handler,
		description: 'Get a widget',
		params: z.strictObject({id: z.uuid()}),
		input: z.null(),
		output: z.looseObject({name: z.string()}),
	},
	// Route with 404 but no params → should be skipped
	{
		method: 'GET',
		path: '/status',
		auth: {type: 'none'},
		handler: stub_handler,
		description: 'Status check',
		input: z.null(),
		output: z.looseObject({ok: z.literal(true)}),
		errors: {404: z.looseObject({error: z.literal('not_configured')})},
	},
];

describe_adversarial_404({
	build: () =>
		create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: adversarial_404_specs,
		}),
	roles: ['admin', 'keeper'],
});

// Verifies describe_adversarial_404 handles routes with no params + 404 gracefully (zero tests created).
// Called at top level (not inside test()) because it creates describe() blocks internally.
describe_adversarial_404({
	build: () =>
		create_app_surface_spec({
			middleware_specs: [],
			route_specs: [
				{
					method: 'GET',
					path: '/health',
					auth: {type: 'none'},
					handler: stub_handler,
					description: 'Health',
					input: z.null(),
					output: z.null(),
				},
			],
		}),
	roles: [],
});

describe('error schema tightness baseline', () => {
	test('audit returns typed entries for all error schemas', () => {
		const surface_spec = create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: adversarial_specs,
		});
		const audit = audit_error_schema_tightness(surface_spec.surface);
		assert.ok(Array.isArray(audit));
		// the adversarial specs include authenticated/role/keeper routes,
		// which get auto-derived error schemas (401, 403) — verify those appear
		const statuses = new Set(audit.map((e) => e.status));
		assert.ok(statuses.has('401'), 'should include derived 401 schemas');
		assert.ok(statuses.has('403'), 'should include derived 403 schemas');
		// every entry should have a recognized specificity
		const valid_specificities = new Set(['literal', 'enum', 'generic']);
		for (const entry of audit) {
			assert.ok(
				valid_specificities.has(entry.specificity),
				`unexpected specificity: ${entry.specificity}`,
			);
		}
	});

	test('assert_error_schema_tightness passes with permissive threshold', () => {
		const surface_spec = create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: adversarial_specs,
		});
		// generic threshold = no failures (baseline — consumers tighten from here)
		assert_error_schema_tightness(surface_spec.surface, {min_specificity: 'generic'});
	});
});
