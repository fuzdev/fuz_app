/**
 * Tests for the surface assertion helpers and `resolve_fixture_path`.
 *
 * @module
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, assert, test, afterEach } from 'vitest';
import { literal } from '@fuzdev/fuz_schema/schema.ts';
import { stub_handler, stub_mw } from '#lib/testing/stubs.ts';
import {
	resolve_fixture_path,
	assert_surface_matches_snapshot,
	assert_surface_deterministic,
	assert_only_expected_public_routes,
	assert_full_middleware_stack
} from '#lib/testing/assertions.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import { generate_app_surface, type AppSurface } from '#lib/http/surface.ts';

describe('resolve_fixture_path', () => {
	test('resolves relative to the provided import.meta.url', () => {
		const result = resolve_fixture_path('test.json', import.meta.url);
		assert.ok(result.endsWith('/test.json'));
		assert.ok(result.startsWith('/'));
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
