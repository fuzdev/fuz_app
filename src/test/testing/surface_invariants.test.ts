/**
 * Tests for surface invariant assertions.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

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
} from '$lib/testing/surface_invariants.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import {generate_app_surface, type AppSurface} from '$lib/http/surface.js';
import {stub_handler, stub_mw} from '$lib/testing/stubs.js';

const test_middleware: Array<MiddlewareSpec> = [{name: 'origin', path: '/api/*', handler: stub_mw}];

/** Well-formed surface that passes all invariants. */
const build_valid_surface = (): AppSurface => {
	const specs: Array<RouteSpec> = [
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
			method: 'POST',
			path: '/api/keeper/sync',
			auth: {type: 'keeper'},
			handler: stub_handler,
			description: 'Keeper sync',
			input: z.null(),
			output: z.null(),
		},
	];
	return generate_app_surface({middleware_specs: test_middleware, route_specs: specs});
};

describe('assert_protected_routes_declare_401', () => {
	test('passes for well-formed surface', () => {
		assert_protected_routes_declare_401(build_valid_surface());
	});

	test('fails when a protected route lacks 401', () => {
		const surface = build_valid_surface();
		// strip error_schemas from the authenticated route
		const route = surface.routes.find((r) => r.auth.type === 'authenticated')!;
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
		const route = surface.routes.find((r) => r.auth.type === 'role')!;
		route.error_schemas = {'401': {}};
		assert.throws(() => assert_role_routes_declare_403(surface), /missing 403/);
	});

	test('fails when a keeper route lacks 403', () => {
		const surface = build_valid_surface();
		const route = surface.routes.find((r) => r.auth.type === 'keeper')!;
		route.error_schemas = {'401': {}};
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
		route.error_schemas = {'401': {}, '403': {}};
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
		surface.routes.push({...surface.routes[0]!});
		assert.throws(() => assert_no_duplicate_routes(surface), /Duplicate route/);
	});
});

describe('assert_error_schemas_structurally_valid', () => {
	test('passes for well-formed surface', () => {
		assert_error_schemas_structurally_valid(build_valid_surface());
	});

	test('fails when error schema lacks error property', () => {
		const surface = build_valid_surface();
		const route = surface.routes.find((r) => r.auth.type === 'authenticated')!;
		// Replace error schema with one missing the 'error' property
		route.error_schemas = {'401': {type: 'object', properties: {message: {type: 'string'}}}};
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
			'401': {type: 'object', properties: {error: {const: 'same_error'}}},
		};
		surface.routes[2]!.error_schemas = {
			'403': {type: 'object', properties: {error: {const: 'same_error'}}},
			'400': surface.routes[2]!.error_schemas!['400']!,
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
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({username: z.string()}),
				output: z.null(),
				rate_limit: 'both',
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert_sensitive_routes_rate_limited(surface);
	});

	test('passes when sensitive routes have 429 in error schemas', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/account/login',
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({username: z.string()}),
				output: z.null(),
				rate_limit: 'both',
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert_sensitive_routes_rate_limited(surface);
	});

	test('fails when sensitive route lacks rate limiting', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/account/login',
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({username: z.string()}),
				output: z.null(),
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert.throws(() => assert_sensitive_routes_rate_limited(surface), /no rate limiting/);
	});
});

describe('assert_no_unexpected_public_mutations', () => {
	test('passes when public mutations are in allowlist', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/account/login',
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({username: z.string()}),
				output: z.null(),
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert_no_unexpected_public_mutations(surface, ['POST /api/account/login']);
	});

	test('fails when public mutation not in allowlist', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/webhook',
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Webhook',
				input: z.strictObject({data: z.string()}),
				output: z.null(),
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
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
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Bad GET with body',
				input: z.strictObject({name: z.string()}),
				output: z.null(),
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
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
				auth: {type: 'authenticated'},
				handler: stub_handler,
				description: 'Get thing',
				params: z.strictObject({id: z.uuid()}),
				input: z.null(),
				output: z.null(),
				errors: {404: z.looseObject({error: z.literal('thing_not_found')})},
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert_404_schemas_use_specific_errors(surface);
	});

	test('passes when 404 schema uses z.enum()', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'DELETE',
				path: '/api/things/:id',
				auth: {type: 'authenticated'},
				handler: stub_handler,
				description: 'Delete thing',
				params: z.strictObject({id: z.uuid()}),
				input: z.null(),
				output: z.null(),
				errors: {404: z.looseObject({error: z.enum(['thing_not_found', 'parent_not_found'])})},
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert_404_schemas_use_specific_errors(surface);
	});

	test('fails when param route uses generic ApiError for 404', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/api/things/:id',
				auth: {type: 'authenticated'},
				handler: stub_handler,
				description: 'Get thing',
				params: z.strictObject({id: z.uuid()}),
				input: z.null(),
				output: z.null(),
				errors: {404: z.looseObject({error: z.string()})},
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert.throws(() => assert_404_schemas_use_specific_errors(surface), /generic error schema/);
	});

	test('skips routes without params', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/api/bootstrap',
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Bootstrap',
				input: z.strictObject({token: z.string()}),
				output: z.null(),
				errors: {404: z.looseObject({error: z.string()})},
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
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
				auth: {type: 'keeper'},
				handler: stub_handler,
				description: 'List tables',
				input: z.null(),
				output: z.null(),
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert_keeper_routes_under_prefix(surface);
	});

	test('fails when keeper route is outside expected prefix', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/admin/sync',
				auth: {type: 'keeper'},
				handler: stub_handler,
				description: 'Admin sync',
				input: z.null(),
				output: z.null(),
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert.throws(
			() => assert_keeper_routes_under_prefix(surface),
			/not under any expected prefix/,
		);
	});

	test('accepts custom prefixes', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/internal/sync',
				auth: {type: 'keeper'},
				handler: stub_handler,
				description: 'Internal sync',
				input: z.null(),
				output: z.null(),
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
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
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Health check',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'POST',
				path: '/api/account/login',
				auth: {type: 'none'},
				handler: stub_handler,
				description: 'Login',
				input: z.strictObject({username: z.string()}),
				output: z.null(),
				rate_limit: 'both',
			},
		];
		const surface = generate_app_surface({middleware_specs: [], route_specs: specs});
		assert_surface_security_policy(surface, {
			public_mutation_allowlist: ['POST /api/account/login'],
		});
	});
});
