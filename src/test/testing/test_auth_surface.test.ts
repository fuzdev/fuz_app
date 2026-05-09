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
import {
	describe_adversarial_auth,
	resolve_standard_error_schema_tightness,
} from '$lib/testing/attack_surface.js';
import {describe_adversarial_404} from '$lib/testing/adversarial_404.js';
import {resolve_valid_path, generate_valid_body} from '$lib/testing/schema_generators.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import {generate_app_surface, create_app_surface_spec, type AppSurface} from '$lib/http/surface.js';
import {
	audit_error_schema_tightness,
	assert_error_schema_tightness,
	FUZ_APP_STOCK_ROUTE_TIGHTNESS_ALLOWLIST,
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
		assert.strictEqual(ctx.role_grants.length, 0);
	});

	test('creates context with role', () => {
		const ctx = create_test_request_context('admin');
		assert.strictEqual(ctx.role_grants.length, 1);
		assert.strictEqual(ctx.role_grants[0]!.role, 'admin');
	});

	test('account and actor IDs are consistent', () => {
		const ctx = create_test_request_context();
		assert.ok(ctx.actor !== null);
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
			auth: {account: 'none', actor: 'none'},
			handler: (c) => c.json({ok: true}),
			description: 'Public route',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'GET',
			path: '/protected',
			auth: {account: 'required', actor: 'none'},
			handler: (c) => c.json({secret: true}),
			description: 'Protected route',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'POST',
			path: '/admin',
			auth: {account: 'required', actor: 'required', roles: ['admin']},
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
			auth: {account: 'none', actor: 'none'},
			handler: stub_handler,
			description: 'Health check',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'POST',
			path: '/api/login',
			auth: {account: 'none', actor: 'none'},
			handler: stub_handler,
			description: 'Login',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'GET',
			path: '/api/protected',
			auth: {account: 'required', actor: 'none'},
			handler: stub_handler,
			description: 'Protected resource',
			input: z.null(),
			output: z.null(),
		},
		{
			method: 'POST',
			path: '/api/admin',
			auth: {account: 'required', actor: 'required', roles: ['admin']},
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
		auth: {account: 'none', actor: 'none'},
		handler: (c) => c.json({ok: true}),
		description: 'Public route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'GET',
		path: '/protected',
		auth: {account: 'required', actor: 'none'},
		handler: (c) => c.json({secret: true}),
		description: 'Protected route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/admin-only',
		auth: {account: 'required', actor: 'required', roles: ['admin']},
		handler: (c) => c.json({admin: true}),
		description: 'Admin route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'DELETE',
		path: '/keeper-role',
		auth: {account: 'required', actor: 'required', roles: ['keeper']},
		handler: (c) => c.json({keeper: true}),
		description: 'Keeper role route',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/keeper-auth',
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token'],
		},
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
			role_grant_id: z.uuid(),
		});
		assert.strictEqual(
			resolve_valid_path('/accounts/:account_id/role_grants/:role_grant_id', params),
			'/accounts/00000000-0000-0000-0000-000000000000/role_grants/00000000-0000-0000-0000-000000000000',
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

	test('generates valid body with absolute path refinement', () => {
		const AbsPath = z.string().refine((p) => p.startsWith('/'));
		const schema = z.strictObject({path: AbsPath});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const path = body.path;
		assert.ok(typeof path === 'string');
		assert.ok(path.startsWith('/'));
		schema.parse(body);
	});

	test('generates valid body with date-time field', () => {
		const schema = z.strictObject({created: z.iso.datetime()});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.created, '2020-01-01T00:00:00.000Z');
		schema.parse(body);
	});

	test('generates valid body with nested object', () => {
		const schema = z.strictObject({
			config: z.strictObject({
				name: z.string(),
				count: z.number(),
			}),
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const config = body.config as Record<string, unknown>;
		assert.ok(typeof config.name === 'string');
		assert.ok(typeof config.count === 'number');
		schema.parse(body);
	});

	test('generates valid body with nested object containing optional fields', () => {
		const schema = z.strictObject({
			settings: z.strictObject({
				required_field: z.string(),
				optional_field: z.number().optional(),
			}),
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const settings = body.settings as Record<string, unknown>;
		assert.ok('required_field' in settings);
		assert.ok(!('optional_field' in settings));
		schema.parse(body);
	});

	test('generates valid body with email field', () => {
		const schema = z.strictObject({email: z.email()});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.email, 'test@example.com');
		schema.parse(body);
	});

	test('generates valid body with url refinement', () => {
		const schema = z.strictObject({link: z.url()});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const link = body.link;
		assert.ok(typeof link === 'string');
		assert.ok(link.startsWith('https://'));
		schema.parse(body);
	});

	test('generates valid body with branded string', () => {
		const Branded = z
			.string()
			.refine((p) => p.startsWith('/'))
			.brand('AbsPath');
		const schema = z.strictObject({path: Branded});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const path = body.path;
		assert.ok(typeof path === 'string');
		assert.ok(path.startsWith('/'));
		schema.parse(body);
	});

	test('generates valid body with enum field', () => {
		const schema = z.strictObject({
			status: z.enum(['active', 'inactive', 'pending']),
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.status, 'active');
		schema.parse(body);
	});

	test('includes fields with defaults', () => {
		const schema = z.strictObject({
			name: z.string(),
			color: z.string().default('blue'),
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok('name' in body);
		assert.ok('color' in body);
		schema.parse(body);
	});

	test('throws for unsatisfiable schema', () => {
		// Refinement that always rejects — generation produces a value that fails validation
		const schema = z.strictObject({
			impossible: z.string().refine(() => false, 'always fails'),
		});
		assert.throws(() => generate_valid_body(schema), /generate_valid_body/);
	});

	test('generates valid body for hex-pattern string (blake3 hash)', async () => {
		// `account_session_revoke_action_spec.input` has `session_id: Blake3Hash`
		// (`^[0-9a-f]{64}$`). The generator must produce a value that round-trips
		// through the input schema without error — previously it returned the
		// default `'xxxxxxxxxx'` which fails the regex.
		const {account_session_revoke_action_spec} = await import('$lib/auth/account_action_specs.js');
		const body = generate_valid_body(account_session_revoke_action_spec.input);
		assert.ok(body);
		const parsed = account_session_revoke_action_spec.input.safeParse(body);
		assert.ok(parsed.success, `generated body should pass schema: ${JSON.stringify(parsed)}`);
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
		auth: {account: 'required', actor: 'none'},
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
		auth: {account: 'required', actor: 'required', roles: ['admin']},
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
		auth: {account: 'required', actor: 'none'},
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
		auth: {account: 'none', actor: 'none'},
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
		auth: {account: 'none', actor: 'none'},
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
					auth: {account: 'none', actor: 'none'},
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

describe('resolve_standard_error_schema_tightness', () => {
	// Surface built with one consumer-allowlisted route (`POST /api/foo`) and
	// one unlisted generic route (`POST /api/unlisted`). Consumer-allowlisted
	// route must pass; unlisted must fail. Stock-allowlist behavior is covered
	// by the `deepStrictEqual` check in the additive-merge test — whatever
	// entries ship in `FUZ_APP_STOCK_ROUTE_TIGHTNESS_ALLOWLIST` survive the
	// concat.
	const mixed_specs: Array<RouteSpec> = [
		{
			method: 'POST',
			path: '/api/foo',
			auth: {account: 'none', actor: 'none'},
			handler: stub_handler,
			description: 'Consumer-allowlisted generic route',
			input: z.strictObject({name: z.string()}),
			output: z.null(),
			errors: {400: z.looseObject({error: z.string()})},
		},
		{
			method: 'POST',
			path: '/api/unlisted',
			auth: {account: 'none', actor: 'none'},
			handler: stub_handler,
			description: 'Generic route not in any allowlist',
			input: z.strictObject({name: z.string()}),
			output: z.null(),
			errors: {400: z.looseObject({error: z.string()})},
		},
	];

	test('null → null (opt-out preserved)', () => {
		assert.strictEqual(resolve_standard_error_schema_tightness(null), null);
	});

	test('undefined → stock defaults', () => {
		const resolved = resolve_standard_error_schema_tightness(undefined);
		assert.ok(resolved);
		assert.deepStrictEqual(resolved.allowlist, [...FUZ_APP_STOCK_ROUTE_TIGHTNESS_ALLOWLIST]);
		assert.deepStrictEqual(resolved.ignore_statuses, [401, 403, 429]);
	});

	test('consumer allowlist is additive — stock entries prefix, consumer entries suffix', () => {
		const resolved = resolve_standard_error_schema_tightness({
			allowlist: ['POST /api/foo'],
		});
		assert.ok(resolved);
		// deepStrictEqual pins the exact concat order: stock first, then consumer.
		// Whatever stock entries ship survive the merge; consumer entries are
		// appended rather than replacing.
		assert.deepStrictEqual(resolved.allowlist, [
			...FUZ_APP_STOCK_ROUTE_TIGHTNESS_ALLOWLIST,
			'POST /api/foo',
		]);

		// Runtime behavior: consumer-allowlisted route passes, unlisted fails.
		const surface_spec = create_app_surface_spec({
			middleware_specs: [],
			route_specs: mixed_specs,
		});
		assert.throws(
			() => assert_error_schema_tightness(surface_spec.surface, resolved),
			/POST \/api\/unlisted → 400 \(generic\)/,
		);
		try {
			assert_error_schema_tightness(surface_spec.surface, resolved);
			assert.fail('expected assert_error_schema_tightness to throw');
		} catch (e) {
			const msg = (e as Error).message;
			assert.ok(!msg.includes('POST /api/foo'), 'consumer-allowlisted route must not fail');
		}
	});

	test('consumer ignore_statuses is additive', () => {
		const resolved = resolve_standard_error_schema_tightness({ignore_statuses: [503]});
		assert.ok(resolved);
		assert.deepStrictEqual(resolved.ignore_statuses, [401, 403, 429, 503]);
	});

	test('consumer min_specificity overrides default', () => {
		const resolved = resolve_standard_error_schema_tightness({min_specificity: 'literal'});
		assert.ok(resolved);
		assert.strictEqual(resolved.min_specificity, 'literal');
		// stock allowlist survives the override
		assert.deepStrictEqual(resolved.allowlist, [...FUZ_APP_STOCK_ROUTE_TIGHTNESS_ALLOWLIST]);
	});
});
