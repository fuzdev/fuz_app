/**
 * Tests for surface invariant assertions.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import {
	assert_protected_routes_declare_401,
	assert_role_routes_declare_403,
	assert_input_routes_declare_400,
	assert_descriptions_present,
	assert_no_duplicate_routes,
	assert_surface_invariants,
	assert_error_schemas_structurally_valid,
	assert_error_code_status_consistency,
	assert_404_schemas_use_specific_errors,
	assert_sensitive_routes_rate_limited,
	assert_no_unexpected_public_mutations,
	assert_mutation_routes_use_post,
	assert_keeper_routes_under_prefix,
	assert_surface_security_policy,
	audit_error_schema_tightness
} from '$lib/testing/surface_invariants.ts';
import type { RouteSpec } from '$lib/http/route_spec.ts';
import type { MiddlewareSpec } from '$lib/http/middleware_spec.ts';
import { generate_app_surface, type AppSurface } from '$lib/http/surface.ts';
import { stub_handler, stub_mw } from '$lib/testing/stubs.ts';

const test_middleware: Array<MiddlewareSpec> = [
	{ name: 'origin', path: '/api/*', handler: stub_mw }
];

/** Well-formed surface that passes all invariants. */
const build_valid_surface = (): AppSurface => {
	const specs: Array<RouteSpec> = [
		{
			method: 'GET',
			path: '/health',
			auth: { account: 'none', actor: 'none' },
			handler: stub_handler,
			description: 'Health check',
			input: z.null(),
			output: z.null()
		},
		{
			method: 'GET',
			path: '/api/me',
			auth: { account: 'required', actor: 'none' },
			handler: stub_handler,
			description: 'Current user',
			input: z.null(),
			output: z.null()
		},
		{
			method: 'POST',
			path: '/api/admin/grant',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			handler: stub_handler,
			description: 'Grant role',
			input: z.strictObject({ role: z.string() }),
			output: z.null()
		},
		{
			method: 'POST',
			path: '/api/keeper/sync',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			},
			handler: stub_handler,
			description: 'Keeper sync',
			input: z.null(),
			output: z.null()
		}
	];
	return generate_app_surface({ middleware_specs: test_middleware, route_specs: specs });
};

describe('assert_protected_routes_declare_401', () => {
	test('passes for well-formed surface', () => {
		assert_protected_routes_declare_401(build_valid_surface());
	});

	test('fails when a protected route lacks 401', () => {
		const surface = build_valid_surface();
		// strip error_schemas from the authenticated route
		const route = surface.routes.find(
			(r) =>
				r.auth.account === 'required' && !r.auth.roles?.length && !r.auth.credential_types?.length
		)!;
		route.error_schemas = null;
		assert.throws(() => assert_protected_routes_declare_401(surface), /missing 401/);
	});
});

describe('assert_role_routes_declare_403', () => {
	test('passes for well-formed surface', () => {
		assert_role_routes_declare_403(build_valid_surface());
	});

	test('fails when a role route lacks 403', () => {
		const surface = build_valid_surface();
		const route = surface.routes.find((r) => !!r.auth.roles?.length)!;
		route.error_schemas = { '401': {} };
		assert.throws(() => assert_role_routes_declare_403(surface), /missing 403/);
	});

	test('fails when a keeper route lacks 403', () => {
		const surface = build_valid_surface();
		const route = surface.routes.find(
			(r) => r.auth.credential_types?.includes('daemon_token') ?? false
		)!;
		route.error_schemas = { '401': {} };
		assert.throws(() => assert_role_routes_declare_403(surface), /missing 403/);
	});
});

describe('assert_input_routes_declare_400', () => {
	test('passes for well-formed surface', () => {
		assert_input_routes_declare_400(build_valid_surface());
	});

	test('fails when a route with input lacks 400', () => {
		const surface = build_valid_surface();
		const route = surface.routes.find((r) => r.input_schema !== null)!;
		route.error_schemas = { '401': {}, '403': {} };
		assert.throws(() => assert_input_routes_declare_400(surface), /missing 400/);
	});
});

describe('assert_descriptions_present', () => {
	test('passes for well-formed surface', () => {
		assert_descriptions_present(build_valid_surface());
	});

	test('fails when a route has empty description', () => {
		const surface = build_valid_surface();
		surface.routes[0]!.description = '';
		assert.throws(() => assert_descriptions_present(surface), /empty description/);
	});
});

describe('assert_no_duplicate_routes', () => {
	test('passes for well-formed surface', () => {
		assert_no_duplicate_routes(build_valid_surface());
	});

	test('fails with duplicate method+path', () => {
		const surface = build_valid_surface();
		surface.routes.push({ ...surface.routes[0]! });
		assert.throws(() => assert_no_duplicate_routes(surface), /Duplicate route/);
	});
});

describe('assert_error_schemas_structurally_valid', () => {
	test('passes for well-formed surface', () => {
		assert_error_schemas_structurally_valid(build_valid_surface());
	});

	test('fails when error schema lacks error property', () => {
		const surface = build_valid_surface();
		const route = surface.routes.find(
			(r) =>
				r.auth.account === 'required' && !r.auth.roles?.length && !r.auth.credential_types?.length
		)!;
		// Replace error schema with one missing the 'error' property
		route.error_schemas = {
			'401': { type: 'object', properties: { message: { type: 'string' } } }
		};
		assert.throws(() => assert_error_schemas_structurally_valid(surface), /missing 'error'/);
	});

	test('walks anyOf branches and fails when a branch lacks error property', () => {
		const surface = build_valid_surface();
		const route = surface.routes[0]!;
		route.error_schemas = {
			'400': {
				anyOf: [
					{ type: 'object', properties: { error: { const: 'ok_branch' } } },
					{ type: 'object', properties: { message: { type: 'string' } } }
				]
			}
		};
		assert.throws(() => assert_error_schemas_structurally_valid(surface), /missing 'error'/);
	});

	test('walks oneOf branches (discriminatedUnion) and fails when a branch lacks error', () => {
		const surface = build_valid_surface();
		const route = surface.routes[0]!;
		route.error_schemas = {
			'400': {
				oneOf: [
					{ type: 'object', properties: { error: { const: 'ok_branch' } } },
					{ type: 'object', properties: { message: { type: 'string' } } }
				]
			}
		};
		assert.throws(() => assert_error_schemas_structurally_valid(surface), /missing 'error'/);
	});
});

describe('assert_error_code_status_consistency', () => {
	test('passes for well-formed surface', () => {
		assert_error_code_status_consistency(build_valid_surface());
	});

	test('fails when same literal appears at different status codes', () => {
		const surface = build_valid_surface();
		// Give two routes the same error literal at different statuses
		surface.routes[1]!.error_schemas = {
			'401': { type: 'object', properties: { error: { const: 'same_error' } } }
		};
		surface.routes[2]!.error_schemas = {
			'403': { type: 'object', properties: { error: { const: 'same_error' } } },
			'400': surface.routes[2]!.error_schemas!['400']!
		};
		assert.throws(() => assert_error_code_status_consistency(surface), /multiple status codes/);
	});

	test('walks anyOf branches and flags a literal nested inside a union', () => {
		const surface = build_valid_surface();
		// Bury 'shared_code' in a 400 union on one route and at 401 on another.
		surface.routes[0]!.error_schemas = {
			'400': {
				anyOf: [
					{ type: 'object', properties: { error: { const: 'shared_code' } } },
					{ type: 'object', properties: { error: { const: 'another_400' } } }
				]
			}
		};
		surface.routes[1]!.error_schemas = {
			'401': { type: 'object', properties: { error: { const: 'shared_code' } } }
		};
		assert.throws(() => assert_error_code_status_consistency(surface), /multiple status codes/);
	});
});

describe('assert_sensitive_routes_rate_limited', () => {
	test('passes when sensitive routes have rate_limit_key', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({ username: z.string() }),
				output: z.null(),
				rate_limit: 'both'
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_sensitive_routes_rate_limited(surface);
	});

	test('passes when sensitive routes have 429 in error schemas', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({ username: z.string() }),
				output: z.null(),
				errors: {
					429: z.strictObject({ error: z.literal('rate_limit_exceeded'), retry_after: z.number() })
				}
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_sensitive_routes_rate_limited(surface);
	});

	test('fails when sensitive route lacks rate limiting', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({ username: z.string() }),
				output: z.null()
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_sensitive_routes_rate_limited(surface), /no rate limiting/);
	});
});

describe('assert_no_unexpected_public_mutations', () => {
	test('passes when public mutations are in allowlist', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({ username: z.string() }),
				output: z.null()
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_no_unexpected_public_mutations(surface, ['POST /api/account/login']);
	});

	test('fails when public mutation not in allowlist', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/webhook',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Webhook',
				input: z.strictObject({ data: z.string() }),
				output: z.null()
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_no_unexpected_public_mutations(surface), /not in the allowlist/);
	});
});

describe('assert_mutation_routes_use_post', () => {
	test('passes for well-formed surface', () => {
		assert_mutation_routes_use_post(build_valid_surface());
	});

	test('fails when GET route has input schema', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/api/bad',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Bad GET with body',
				input: z.strictObject({ name: z.string() }),
				output: z.null()
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_mutation_routes_use_post(surface), /input schema on GET/);
	});
});

describe('assert_404_schemas_use_specific_errors', () => {
	test('passes for well-formed surface', () => {
		assert_404_schemas_use_specific_errors(build_valid_surface());
	});

	test('passes when 404 schema uses z.literal()', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/api/things/:id',
				auth: { account: 'required', actor: 'none' },
				handler: stub_handler,
				description: 'Get thing',
				params: z.strictObject({ id: z.uuid() }),
				input: z.null(),
				output: z.null(),
				errors: { 404: z.looseObject({ error: z.literal('thing_not_found') }) }
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_404_schemas_use_specific_errors(surface);
	});

	test('passes when 404 schema uses z.enum()', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'DELETE',
				path: '/api/things/:id',
				auth: { account: 'required', actor: 'none' },
				handler: stub_handler,
				description: 'Delete thing',
				params: z.strictObject({ id: z.uuid() }),
				input: z.null(),
				output: z.null(),
				errors: { 404: z.looseObject({ error: z.enum(['thing_not_found', 'parent_not_found']) }) }
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_404_schemas_use_specific_errors(surface);
	});

	test('fails when param route uses generic ApiError for 404', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/api/things/:id',
				auth: { account: 'required', actor: 'none' },
				handler: stub_handler,
				description: 'Get thing',
				params: z.strictObject({ id: z.uuid() }),
				input: z.null(),
				output: z.null(),
				errors: { 404: z.looseObject({ error: z.string() }) }
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_404_schemas_use_specific_errors(surface), /generic error schema/);
	});

	test('passes when 404 schema is a union of specific branches', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/api/things/:id',
				auth: { account: 'required', actor: 'none' },
				handler: stub_handler,
				description: 'Get thing',
				params: z.strictObject({ id: z.uuid() }),
				input: z.null(),
				output: z.null(),
				errors: {
					404: z.union([
						z.looseObject({ error: z.literal('thing_not_found') }),
						z.looseObject({ error: z.literal('parent_not_found') })
					])
				}
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_404_schemas_use_specific_errors(surface);
	});

	test('fails when 404 union has a generic branch', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/api/things/:id',
				auth: { account: 'required', actor: 'none' },
				handler: stub_handler,
				description: 'Get thing',
				params: z.strictObject({ id: z.uuid() }),
				input: z.null(),
				output: z.null(),
				errors: {
					404: z.union([
						z.looseObject({ error: z.literal('thing_not_found') }),
						z.looseObject({ error: z.string() })
					])
				}
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_404_schemas_use_specific_errors(surface), /generic error schema/);
	});

	test('skips routes without params', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/bootstrap',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Bootstrap',
				input: z.strictObject({ token: z.string() }),
				output: z.null(),
				errors: { 404: z.looseObject({ error: z.string() }) }
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		// Should pass — no params, so generic 404 is fine
		assert_404_schemas_use_specific_errors(surface);
	});
});

describe('assert_keeper_routes_under_prefix', () => {
	test('passes for well-formed surface', () => {
		assert_keeper_routes_under_prefix(build_valid_surface());
	});

	test('passes when keeper routes are under /api/', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/api/db/tables',
				auth: {
					account: 'required',
					actor: 'required',
					roles: ['keeper'],
					credential_types: ['daemon_token']
				},
				handler: stub_handler,
				description: 'List tables',
				input: z.null(),
				output: z.null()
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_keeper_routes_under_prefix(surface);
	});

	test('fails when keeper route is outside expected prefix', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/admin/sync',
				auth: {
					account: 'required',
					actor: 'required',
					roles: ['keeper'],
					credential_types: ['daemon_token']
				},
				handler: stub_handler,
				description: 'Admin sync',
				input: z.null(),
				output: z.null()
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(
			() => assert_keeper_routes_under_prefix(surface),
			/not under any expected prefix/
		);
	});

	test('accepts custom prefixes', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/internal/sync',
				auth: {
					account: 'required',
					actor: 'required',
					roles: ['keeper'],
					credential_types: ['daemon_token']
				},
				handler: stub_handler,
				description: 'Internal sync',
				input: z.null(),
				output: z.null()
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_keeper_routes_under_prefix(surface));
		// Passes with custom prefix
		assert_keeper_routes_under_prefix(surface, ['/internal/']);
	});
});

describe('assert_surface_invariants', () => {
	test('passes for well-formed surface', () => {
		assert_surface_invariants(build_valid_surface());
	});

	test('fails on any invariant violation', () => {
		const surface = build_valid_surface();
		surface.routes[0]!.description = '';
		assert.throws(() => assert_surface_invariants(surface));
	});
});

describe('assert_surface_security_policy', () => {
	test('passes for well-formed surface with config', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/health',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Health check',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({ username: z.string() }),
				output: z.null(),
				rate_limit: 'both'
			}
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_surface_security_policy(surface, {
			public_mutation_allowlist: ['POST /api/account/login']
		});
	});
});

describe('audit_error_schema_tightness union walk', () => {
	/** Build a single-route surface with a synthetic 400 error schema. */
	const build_with_400 = (errors: NonNullable<RouteSpec['errors']>): AppSurface => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/probe',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Probe',
				input: z.strictObject({ name: z.string() }),
				output: z.null(),
				errors
			}
		];
		return generate_app_surface({ middleware_specs: [], route_specs: specs });
	};

	test('anyOf union of [literal, enum] reports enum (min specificity)', () => {
		const surface = build_with_400({
			400: z.union([
				z.looseObject({ error: z.literal('a') }),
				z.looseObject({ error: z.enum(['b', 'c']) })
			])
		});
		const entry = audit_error_schema_tightness(surface).find((e) => e.status === '400')!;
		assert.strictEqual(entry.specificity, 'enum');
		assert.deepStrictEqual([...new Set(entry.error_codes)].sort(), ['a', 'b', 'c']);
	});

	test('anyOf union with a generic branch reports generic and null codes', () => {
		const surface = build_with_400({
			400: z.union([z.looseObject({ error: z.literal('a') }), z.looseObject({ error: z.string() })])
		});
		const entry = audit_error_schema_tightness(surface).find((e) => e.status === '400')!;
		assert.strictEqual(entry.specificity, 'generic');
		assert.strictEqual(entry.error_codes, null);
	});

	test('oneOf union (z.discriminatedUnion) reports min specificity across branches', () => {
		const surface = build_with_400({
			400: z.discriminatedUnion('error', [
				z.looseObject({ error: z.literal('a'), detail: z.string() }),
				z.looseObject({ error: z.literal('b') })
			])
		});
		const entry = audit_error_schema_tightness(surface).find((e) => e.status === '400')!;
		assert.strictEqual(entry.specificity, 'literal');
		assert.deepStrictEqual([...new Set(entry.error_codes)].sort(), ['a', 'b']);
	});

	test('flat literal schema still reports literal (regression check)', () => {
		const surface = build_with_400({
			400: z.looseObject({ error: z.literal('only_one') })
		});
		const entry = audit_error_schema_tightness(surface).find((e) => e.status === '400')!;
		assert.strictEqual(entry.specificity, 'literal');
		assert.deepStrictEqual(entry.error_codes, ['only_one']);
	});

	test('nested unions recurse correctly (Zod 4 does not auto-flatten)', () => {
		// `z.union([z.union([A, B]), C])` emits nested `anyOf` — recursion
		// inside `classify_error_specificity` / `extract_error_codes` is what
		// makes the inner branches visible.
		const surface = build_with_400({
			400: z.union([
				z.union([
					z.looseObject({ error: z.literal('inner_a') }),
					z.looseObject({ error: z.literal('inner_b') })
				]),
				z.looseObject({ error: z.literal('outer') })
			])
		});
		const entry = audit_error_schema_tightness(surface).find((e) => e.status === '400')!;
		assert.strictEqual(entry.specificity, 'literal');
		assert.deepStrictEqual([...new Set(entry.error_codes)].sort(), ['inner_a', 'inner_b', 'outer']);
	});
});
