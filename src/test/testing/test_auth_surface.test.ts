/**
 * Tests for backend_test_auth_surface.ts — auth attack surface test utilities.
 *
 * @module
 */

import { route_ok } from '#lib/http/route_result.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, assert, test, afterEach } from 'vitest';
import {
	brand,
	check,
	iso_datetime,
	literal,
	loose_object,
	min_length,
	number,
	object,
	one_of,
	optional,
	parse,
	parse_or_throw,
	pipe,
	regex,
	string,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';

import {
	stub,
	stub_handler,
	stub_mw,
	create_throwing_stub,
	create_noop_stub
} from '#lib/testing/stubs.ts';
import { create_test_request_context, create_test_app_from_specs } from '#lib/testing/auth_apps.ts';
import {
	resolve_fixture_path,
	assert_surface_matches_snapshot,
	assert_surface_deterministic,
	assert_only_expected_public_routes,
	assert_full_middleware_stack
} from '#lib/testing/assertions.ts';
import { describe_adversarial_auth } from '#lib/testing/attack_surface.ts';
import { describe_adversarial_404 } from '#lib/testing/adversarial_404.ts';
import { describe_adversarial_input } from '#lib/testing/adversarial_input.ts';
import { resolve_valid_path, generate_valid_body } from '#lib/testing/schema_generators.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import {
	generate_app_surface,
	create_app_surface_spec,
	type AppSurface
} from '#lib/http/surface.ts';
import {
	assert_error_codes_specific,
	assert_error_codes_well_formed
} from '#lib/testing/surface_invariants.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { ActingActor, Email, FactHashSchema, Uuid } from '#lib/primitive_schemas.ts';

/** The content type every non-`raw_body` POST route requires. */
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('stubs', () => {
	test('stub throws on property access', () => {
		assert.throws(() => stub.foo, /Throwing stub 'stub'/);
	});

	test('stub_handler returns a raw result holding a Response', () => {
		const res = stub_handler();
		assert.strictEqual(res.ok, 'raw');
		assert.ok(res.response instanceof Response);
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
		const s = create_noop_stub('test_dep', { name: 'explicit' });
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

describe('resolve_fixture_path', () => {
	test('resolves relative to the provided import.meta.url', () => {
		const result = resolve_fixture_path('test.json', import.meta.url);
		assert.ok(result.endsWith('/test.json'));
		assert.ok(result.startsWith('/'));
	});
});

describe('create_test_app_from_specs', () => {
	const test_specs: Array<RouteSpec> = [
		define_route({
			method: 'GET',
			path: '/public',
			auth: { account: 'none', actor: 'none' },
			handler: () => route_ok({ ok: true }),
			description: 'Public route',
			input: literal(null),
			output: object({ ok: literal(true) })
		}),
		define_route({
			method: 'GET',
			path: '/protected',
			auth: { account: 'required', actor: 'none' },
			handler: () => route_ok({ secret: true }),
			description: 'Protected route',
			input: literal(null),
			output: object({ secret: literal(true) })
		}),
		define_route({
			method: 'POST',
			path: '/admin',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			handler: () => route_ok({ admin: true }),
			description: 'Admin route',
			query: object({ acting: ActingActor }),
			input: literal(null),
			output: object({ admin: literal(true) })
		})
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
		const res = await app.request('/admin', { method: 'POST', headers: JSON_HEADERS });
		assert.strictEqual(res.status, 200);
	});
});

// --- Assertion helper tests ---

/** Build a minimal surface for assertion helper tests. */
const build_test_surface = (): AppSurface => {
	const middleware: Array<MiddlewareSpec> = [
		{ name: 'origin', path: '/api/*', handler: stub_mw },
		{ name: 'session', path: '/api/*', handler: stub_mw }
	];
	const routes: Array<RouteSpec> = [
		define_route({
			method: 'GET',
			path: '/health',
			auth: { account: 'none', actor: 'none' },
			handler: stub_handler,
			description: 'Health check',
			input: literal(null),
			output: literal(null)
		}),
		define_route({
			method: 'POST',
			path: '/api/login',
			auth: { account: 'none', actor: 'none' },
			handler: stub_handler,
			description: 'Login',
			input: literal(null),
			output: literal(null)
		}),
		define_route({
			method: 'GET',
			path: '/api/protected',
			auth: { account: 'required', actor: 'none' },
			handler: stub_handler,
			description: 'Protected resource',
			input: literal(null),
			output: literal(null)
		}),
		define_route({
			method: 'POST',
			path: '/api/admin',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			handler: stub_handler,
			description: 'Admin action',
			input: literal(null),
			output: literal(null)
		})
	];
	return generate_app_surface({ middleware_specs: middleware, route_specs: routes });
};

describe('assert_surface_matches_snapshot', () => {
	let tmp_dir: string;

	afterEach(() => {
		if (tmp_dir) rmSync(tmp_dir, { recursive: true, force: true });
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
		const modified = { ...surface, routes: [] };
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
			/Unexpected public routes.*POST \/api\/login/
		);
	});

	test('fails on missing expected route', () => {
		const surface = build_test_surface();
		assert.throws(
			() =>
				assert_only_expected_public_routes(surface, [
					'GET /health',
					'POST /api/login',
					'GET /api/missing'
				]),
			/Expected public routes missing.*GET \/api\/missing/
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
			/has wrong middleware stack/
		);
	});

	test('fails when no routes match the prefix', () => {
		const surface = build_test_surface();
		assert.throws(
			() => assert_full_middleware_stack(surface, '/nonexistent/', ['origin']),
			/No routes found under/
		);
	});

	const carved_route_specs: Array<RouteSpec> = [
		define_route({
			method: 'GET',
			path: '/api/files/:name',
			auth: { account: 'required', actor: 'none' },
			handler: stub_handler,
			description: 'Read a file',
			input: literal(null),
			output: literal(null)
		}),
		define_route({
			method: 'GET',
			path: '/api/things',
			auth: { account: 'required', actor: 'none' },
			handler: stub_handler,
			description: 'List things',
			input: literal(null),
			output: literal(null)
		})
	];
	// a body cap over `/api/*` that carves `/api/files/*` out
	const build_carved_surface = (): AppSurface =>
		generate_app_surface({
			middleware_specs: [
				{
					name: 'body_cap',
					path: '/api/*',
					handler: stub_mw,
					carve_outs: [{ path: '/api/files/*', reason: 'the file store caps its own bodies' }]
				},
				{ name: 'session', path: '/api/*', handler: stub_mw }
			],
			route_specs: carved_route_specs
		});
	const find_route = (surface: AppSurface, path: string) =>
		surface.routes.find((r) => r.path === path)!;

	test('a carved-out route lacking the layer passes', () => {
		const surface = build_carved_surface();
		assert.deepStrictEqual(find_route(surface, '/api/files/:name').applicable_middleware, [
			'session'
		]);
		assert_full_middleware_stack(surface, '/api/', ['body_cap', 'session']);
	});

	test('a route no carve-out covers lacking the layer fails', () => {
		const surface = build_carved_surface();
		find_route(surface, '/api/things').applicable_middleware = ['session'];
		assert.throws(
			() => assert_full_middleware_stack(surface, '/api/', ['body_cap', 'session']),
			/GET \/api\/things has wrong middleware stack/
		);
	});

	test('a carved-out route still listing the layer fails', () => {
		const surface = build_carved_surface();
		find_route(surface, '/api/files/:name').applicable_middleware = ['body_cap', 'session'];
		assert.throws(
			() => assert_full_middleware_stack(surface, '/api/', ['body_cap', 'session']),
			/GET \/api\/files\/:name has wrong middleware stack \(carved out of body_cap\)/
		);
	});

	test('a carve-out relaxes nothing where another layer of the name runs', () => {
		// a second `body_cap` covers the carved-out file routes, so they keep the name
		const surface = generate_app_surface({
			middleware_specs: [
				{
					name: 'body_cap',
					path: '/api/*',
					handler: stub_mw,
					carve_outs: [{ path: '/api/files/*', reason: 'the file store caps its own bodies' }]
				},
				{ name: 'body_cap', path: '/api/files/*', handler: stub_mw }
			],
			route_specs: carved_route_specs
		});
		assert.deepStrictEqual(find_route(surface, '/api/files/:name').applicable_middleware, [
			'body_cap'
		]);
		assert_full_middleware_stack(surface, '/api/', ['body_cap']);
		find_route(surface, '/api/files/:name').applicable_middleware = [];
		assert.throws(
			() => assert_full_middleware_stack(surface, '/api/', ['body_cap']),
			/GET \/api\/files\/:name has wrong middleware stack/
		);
	});

	test('an exact-template carve-out relaxes no route under it', () => {
		const meta_route: RouteSpec = { ...carved_route_specs[0]!, path: '/api/files/:name/meta' };
		const surface = generate_app_surface({
			middleware_specs: [
				{
					name: 'body_cap',
					path: '/api/*',
					handler: stub_mw,
					carve_outs: [{ path: '/api/files/:name', reason: 'the one file route' }]
				}
			],
			route_specs: [carved_route_specs[0]!, meta_route]
		});
		assert.deepStrictEqual(find_route(surface, '/api/files/:name').applicable_middleware, []);
		assert.deepStrictEqual(find_route(surface, '/api/files/:name/meta').applicable_middleware, [
			'body_cap'
		]);
		assert_full_middleware_stack(surface, '/api/', ['body_cap']);
		find_route(surface, '/api/files/:name/meta').applicable_middleware = [];
		assert.throws(
			() => assert_full_middleware_stack(surface, '/api/', ['body_cap']),
			/GET \/api\/files\/:name\/meta has wrong middleware stack/
		);
	});

	test('a carve-out of a layer the route is not under relaxes nothing', () => {
		// `session` reaches only `/api/things`, so the file route lacks it with no carve-out to explain it
		const surface = generate_app_surface({
			middleware_specs: [
				{
					name: 'session',
					path: '/api/things',
					handler: stub_mw,
					carve_outs: [{ path: '/api/files/*', reason: 'a carve-out outside the layer' }]
				}
			],
			route_specs: carved_route_specs.slice(0, 1)
		});
		assert.throws(
			() => assert_full_middleware_stack(surface, '/api/', ['session']),
			/has wrong middleware stack/
		);
	});
});

// Exercise the adversarial runner with minimal specs
const adversarial_specs: Array<RouteSpec> = [
	define_route({
		method: 'GET',
		path: '/public',
		auth: { account: 'none', actor: 'none' },
		handler: () => route_ok({ ok: true }),
		description: 'Public route',
		input: literal(null),
		output: object({ ok: literal(true) })
	}),
	define_route({
		method: 'GET',
		path: '/protected',
		auth: { account: 'required', actor: 'none' },
		handler: () => route_ok({ secret: true }),
		description: 'Protected route',
		input: literal(null),
		output: object({ secret: literal(true) })
	}),
	define_route({
		method: 'POST',
		path: '/admin-only',
		auth: { account: 'required', actor: 'required', roles: ['admin'] },
		handler: () => route_ok({ admin: true }),
		description: 'Admin route',
		query: object({ acting: ActingActor }),
		input: literal(null),
		output: object({ admin: literal(true) })
	}),
	define_route({
		method: 'DELETE',
		path: '/keeper-role',
		auth: { account: 'required', actor: 'required', roles: ['keeper'] },
		handler: () => route_ok({ keeper: true }),
		description: 'Keeper role route',
		query: object({ acting: ActingActor }),
		input: literal(null),
		output: object({ keeper: literal(true) })
	}),
	define_route({
		method: 'POST',
		path: '/keeper-auth',
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token']
		},
		handler: () => route_ok({ keeper: true }),
		description: 'Keeper auth route',
		query: object({ acting: ActingActor }),
		input: literal(null),
		output: object({ keeper: literal(true) })
	}),
	define_route({
		// The audit SSE stream's shape: a role gate *and* a session-channel
		// gate. Both blocks must reach it — the role cases through the session
		// credential the role apps carry, and the credential case on a channel
		// the gate refuses. Bucketing it as "credential-gated, therefore skip
		// the role cases" is how the coverage went quiet when the real route
		// gained its gate.
		method: 'GET',
		path: '/session-only-role',
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['admin'],
			credential_types: ['session']
		},
		handler: () => route_ok({ streamed: true }),
		description: 'Session-channel-gated admin route',
		query: object({ acting: ActingActor }),
		input: literal(null),
		output: object({ streamed: literal(true) })
	}),
	define_route({
		// Regression guard for the params-schema-aware path synthesizer. The
		// hash param carries a pattern (`^blake3:[0-9a-f]{64}$`), so a
		// `test_hash` segment would 400 at params validation *before* the
		// authority gates — the generated case would assert a 401 and see a
		// 400. `resolve_valid_path` synthesizes a value the schema accepts,
		// so the case reaches the gate it is about.
		method: 'GET',
		path: '/patterned-params/:hash',
		auth: { account: 'required', actor: 'none' },
		params: object({ hash: FactHashSchema }),
		handler: () => route_ok({ ok: true }),
		description: 'Protected route with a format-constrained path param',
		input: literal(null),
		output: object({ ok: literal(true) })
	})
];

const adversarial_middleware: Array<MiddlewareSpec> = [];

describe_adversarial_auth({
	build: () =>
		create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: adversarial_specs
		}),
	roles: ['admin', 'keeper']
});

// A `{re}` param whose pattern refuses `test_<name>` reaches its route through
// a supplied value — without it, `resolve_valid_path` throws in every case.
describe_adversarial_auth({
	build: () =>
		create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: [
				define_route({
					method: 'GET',
					path: '/:slug{.+\\.git}/info/refs',
					auth: { account: 'required', actor: 'none' },
					handler: (c) => route_ok({ slug: c.req.param('slug') }),
					description: 'A route behind a `{re}` param',
					input: literal(null),
					output: object({ slug: optional(string) })
				})
			]
		}),
	roles: ['admin', 'keeper'],
	param_values: { 'GET /:slug{.+\\.git}/info/refs': { slug: 'org/repo.git' } }
});

// Regression guard for typed probes: a `raw_body` POST refuses an untyped
// request with 415 before params or query validation, so the params and query
// fuzz cases must send the route's content type to reach the 400 they assert.
describe_adversarial_input({
	build: () =>
		create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: [
				define_route({
					method: 'POST',
					path: '/raw-upload/:id',
					auth: { account: 'required', actor: 'none' },
					params: object({ id: Uuid }),
					query: object({ size: pipe(string, regex(/^\d+$/)) }),
					handler: () => route_ok({ ok: true }),
					description: 'Raw-byte upload with a uuid param and a numeric query',
					input: literal(null),
					output: object({ ok: literal(true) }),
					raw_body: true
				})
			]
		}),
	roles: ['admin', 'keeper']
});

// --- resolve_valid_path and generate_valid_body tests ---

describe('resolve_valid_path', () => {
	test('replaces uuid params with nil UUID', () => {
		const params = object({ id: Uuid });
		assert.strictEqual(
			resolve_valid_path('/things/:id', params),
			'/things/00000000-0000-0000-0000-000000000000'
		);
	});

	test('synthesizes a schema-satisfying value for a non-uuid param', () => {
		const params = object({ name: string });
		const resolved = resolve_valid_path('/things/:name', params);
		assert.ok(parse(params, { name: resolved.slice('/things/'.length) }).ok);
	});

	test('falls back to the test_ prefix for a param the schema does not name', () => {
		const params = object({ other: string });
		assert.strictEqual(resolve_valid_path('/things/:name', params), '/things/test_name');
	});

	test('handles multiple params', () => {
		const params = object({
			account_id: Uuid,
			role_grant_id: Uuid
		});
		assert.strictEqual(
			resolve_valid_path('/accounts/:account_id/role_grants/:role_grant_id', params),
			'/accounts/00000000-0000-0000-0000-000000000000/role_grants/00000000-0000-0000-0000-000000000000'
		);
	});

	test('falls back to test_ prefix without params schema', () => {
		assert.strictEqual(resolve_valid_path('/things/:id'), '/things/test_id');
	});
});

describe('generate_valid_body', () => {
	test('returns undefined for null schema', () => {
		assert.strictEqual(generate_valid_body(literal(null)), undefined);
	});

	test('generates valid body for simple object schema', () => {
		const schema = object({ name: pipe(string, min_length(1)) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok(typeof body.name === 'string');
		assert.ok(body.name.length >= 1);
		// confirm it actually passes validation
		parse_or_throw(schema, body);
	});

	test('generates valid body with uuid field', () => {
		const schema = object({ id: Uuid });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.id, '00000000-0000-0000-0000-000000000000');
		parse_or_throw(schema, body);
	});

	test('skips optional fields without defaults', () => {
		const schema = object({
			required_field: string,
			optional_field: optional(string)
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok('required_field' in body);
		assert.ok(!('optional_field' in body));
		parse_or_throw(schema, body);
	});

	test('generates valid body with absolute path refinement', () => {
		const AbsPath = pipe(
			string,
			check((p) => p.startsWith('/'))
		);
		const schema = object({ path: AbsPath });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const path = body.path;
		assert.ok(typeof path === 'string');
		assert.ok(path.startsWith('/'));
		parse_or_throw(schema, body);
	});

	test('generates valid body with date-time field', () => {
		const schema = object({ created: pipe(string, iso_datetime) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.created, '2020-01-01T00:00:00.000Z');
		parse_or_throw(schema, body);
	});

	test('generates valid body with nested object', () => {
		const schema = object({
			config: object({
				name: string,
				count: number
			})
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const config = body.config as Record<string, unknown>;
		assert.ok(typeof config.name === 'string');
		assert.ok(typeof config.count === 'number');
		parse_or_throw(schema, body);
	});

	test('generates valid body with nested object containing optional fields', () => {
		const schema = object({
			settings: object({
				required_field: string,
				optional_field: optional(number)
			})
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const settings = body.settings as Record<string, unknown>;
		assert.ok('required_field' in settings);
		assert.ok(!('optional_field' in settings));
		parse_or_throw(schema, body);
	});

	test('generates valid body with email field', () => {
		const schema = object({ email: Email });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.email, 'test@example.com');
		parse_or_throw(schema, body);
	});

	test('generates valid body with url refinement', () => {
		const schema = object({
			link: pipe(
				string,
				check((v) => URL.canParse(v) && v.startsWith('https://'))
			)
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const link = body.link;
		assert.ok(typeof link === 'string');
		assert.ok(link.startsWith('https://'));
		parse_or_throw(schema, body);
	});

	test('generates valid body with branded string', () => {
		const Branded = brand(
			pipe(
				string,
				check((p) => p.startsWith('/'))
			),
			'AbsPath'
		);
		const schema = object({ path: Branded });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const path = body.path;
		assert.ok(typeof path === 'string');
		assert.ok(path.startsWith('/'));
		parse_or_throw(schema, body);
	});

	test('generates valid body with enum field', () => {
		const schema = object({
			status: one_of(['active', 'inactive', 'pending'])
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.status, 'active');
		parse_or_throw(schema, body);
	});

	test('includes fields with defaults', () => {
		const schema = object({
			name: string,
			color: with_default(string, 'blue')
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok('name' in body);
		assert.ok('color' in body);
		parse_or_throw(schema, body);
	});

	test('throws for unsatisfiable schema', () => {
		// Refinement that always rejects — generation produces a value that fails validation
		const schema = object({
			impossible: pipe(
				string,
				check(() => false)
			)
		});
		assert.throws(() => generate_valid_body(schema), /generate_valid_body/);
	});

	test('generates valid body for hex-pattern string (blake3 hash)', async () => {
		// `account_session_revoke_action_spec.input` has `session_id: SessionId`
		// (`^[0-9a-f]{64}$`). The generator must produce a value that round-trips
		// through the input schema without error — previously it returned the
		// default `'xxxxxxxxxx'` which fails the regex.
		const { account_session_revoke_action_spec } =
			await import('#lib/auth/account_action_specs.ts');
		const body = generate_valid_body(account_session_revoke_action_spec.input);
		assert.ok(body);
		const parsed = parse(account_session_revoke_action_spec.input, body);
		assert.ok(parsed.ok, `generated body should pass schema: ${JSON.stringify(parsed)}`);
	});
});

// --- Adversarial 404 runner tests ---

const ERROR_THING_NOT_FOUND = 'thing_not_found' as const;
const ERROR_ITEM_NOT_FOUND = 'item_not_found' as const;
const ERROR_WIDGET_NOT_FOUND = 'widget_not_found' as const;

const adversarial_404_specs: Array<RouteSpec> = [
	// Route with params + literal 404 → should generate a test
	define_route({
		method: 'GET',
		path: '/things/:id',
		auth: { account: 'required', actor: 'none' },
		handler: stub_handler,
		description: 'Get a thing',
		params: object({ id: Uuid }),
		input: literal(null),
		output: loose_object({ name: string }),
		errors: [rest_error(404, ERROR_THING_NOT_FOUND)]
	}),
	// Route with params + two 404 definitions → should generate a test (uses the first)
	define_route({
		method: 'DELETE',
		path: '/items/:id',
		auth: { account: 'required', actor: 'required', roles: ['admin'] },
		handler: stub_handler,
		description: 'Delete an item',
		params: object({ id: Uuid }),
		query: object({ acting: ActingActor }),
		input: literal(null),
		output: loose_object({ ok: literal(true) }),
		errors: [rest_error(404, ERROR_ITEM_NOT_FOUND), rest_error(404, ERROR_WIDGET_NOT_FOUND)]
	}),
	// Route with params + input + 404 → should generate a test with valid body
	define_route({
		method: 'POST',
		path: '/things/:id/rename',
		auth: { account: 'required', actor: 'none' },
		handler: stub_handler,
		description: 'Rename a thing',
		params: object({ id: Uuid }),
		input: object({ name: pipe(string, min_length(1)) }),
		output: loose_object({ ok: literal(true) }),
		errors: [rest_error(404, ERROR_THING_NOT_FOUND)]
	}),
	// Route with params but no 404 → should be skipped
	define_route({
		method: 'GET',
		path: '/widgets/:id',
		auth: { account: 'none', actor: 'none' },
		handler: stub_handler,
		description: 'Get a widget',
		params: object({ id: Uuid }),
		input: literal(null),
		output: loose_object({ name: string })
	}),
	// Route with 404 but no params → should be skipped
	define_route({
		method: 'GET',
		path: '/status',
		auth: { account: 'none', actor: 'none' },
		handler: stub_handler,
		description: 'Status check',
		input: literal(null),
		output: loose_object({ ok: literal(true) }),
		errors: [rest_error(404, 'not_configured')]
	})
];

describe_adversarial_404({
	build: () =>
		create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: adversarial_404_specs
		}),
	roles: ['admin', 'keeper']
});

// Verifies describe_adversarial_404 handles routes with no params + 404 gracefully (zero tests created).
// Called at top level (not inside test()) because it creates describe() blocks internally.
describe_adversarial_404({
	build: () =>
		create_app_surface_spec({
			middleware_specs: [],
			route_specs: [
				define_route({
					method: 'GET',
					path: '/health',
					auth: { account: 'none', actor: 'none' },
					handler: stub_handler,
					description: 'Health',
					input: literal(null),
					output: literal(null)
				})
			]
		}),
	roles: []
});

describe('every declared error names a code', () => {
	test("the adversarial specs' surface, derived and middleware errors included", () => {
		const { surface } = create_app_surface_spec({
			middleware_specs: adversarial_middleware,
			route_specs: adversarial_specs
		});
		assert_error_codes_specific(surface);
		assert_error_codes_well_formed(surface);
	});
});
