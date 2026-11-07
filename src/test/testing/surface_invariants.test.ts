/**
 * Tests for surface invariant assertions.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import {
	literal,
	loose_object,
	object,
	one_of,
	string,
	union,
	type AnySchema
} from '@fuzdev/fuz_schema/schema.ts';

import {
	assert_protected_routes_declare_401,
	assert_role_routes_declare_403,
	assert_input_routes_declare_400,
	assert_params_routes_declare_400,
	assert_descriptions_present,
	assert_no_duplicate_routes,
	assert_surface_invariants,
	assert_error_codes_specific,
	assert_error_codes_well_formed,
	assert_error_code_status_consistency,
	assert_sensitive_routes_rate_limited,
	assert_no_unexpected_public_mutations,
	assert_mutation_routes_use_post,
	assert_keeper_routes_under_prefix,
	assert_surface_security_policy
} from '#lib/testing/surface_invariants.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import { generate_app_surface, type AppSurface } from '#lib/http/surface.ts';
import { stub_handler, stub_mw } from '#lib/testing/stubs.ts';
import { schema_to_surface } from '#lib/http/schema_helpers.ts';
import { REST_RATE_LIMIT_EXCEEDED } from '#lib/http/error_schemas.ts';
import { Uuid } from '#lib/primitive_schemas.ts';

/**
 * A surface with its first route's 404 set to a JSON Schema written from a
 * schema — a declaration no definition can make (a generic `error`, an enum), for
 * the invariants that read the surface as data.
 */
const with_declared_404 = (surface: AppSurface, schema: AnySchema): AppSurface => {
	surface.routes[0]!.error_schemas = {
		...surface.routes[0]!.error_schemas,
		'404': schema_to_surface(schema, { io: 'output' })
	};
	return surface;
};

const test_middleware: Array<MiddlewareSpec> = [
	{ name: 'origin', path: '/api/*', handler: stub_mw }
];

/** Well-formed surface that passes all invariants. */
const build_valid_surface = (): AppSurface => {
	const specs: Array<RouteSpec> = [
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
			method: 'GET',
			path: '/api/me',
			auth: { account: 'required', actor: 'none' },
			handler: stub_handler,
			description: 'Current user',
			input: literal(null),
			output: literal(null)
		}),
		define_route({
			method: 'POST',
			path: '/api/admin/grant',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			handler: stub_handler,
			description: 'Grant role',
			input: object({ role: string }),
			output: literal(null)
		}),
		define_route({
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
			input: literal(null),
			output: literal(null)
		}),
		define_route({
			method: 'POST',
			path: '/api/account/token',
			auth: { account: 'required', actor: 'none', credential_types: ['session'] },
			handler: stub_handler,
			description: 'Mint an api token',
			input: literal(null),
			output: literal(null)
		})
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

	/**
	 * The keeper case above passes on a role-gate-only check too — that route
	 * carries both. A session-gated route with no role is the case that
	 * distinguishes them, and it is the shape the credential-minting actions
	 * and the audit stream ship.
	 */
	test('fails when a role-less session-gated route lacks 403', () => {
		const surface = build_valid_surface();
		const route = surface.routes.find(
			(r) => !r.auth.roles?.length && (r.auth.credential_types?.includes('session') ?? false)
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

	test('fails when the 400 of a route with a body names no body code', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				define_route({
					method: 'POST',
					path: '/api/things/:id',
					auth: { account: 'none', actor: 'none' },
					handler: stub_handler,
					description: 'Takes a thing',
					params: object({ id: string }),
					input: object({ name: string }),
					output: literal(null)
				})
			]
		});
		assert_input_routes_declare_400(surface);
		const declared = surface.routes[0]!.error_schemas!['400'] as { anyOf: Array<any> };
		// the params' branch alone, as the old fact routes declared
		surface.routes[0]!.error_schemas!['400'] = declared.anyOf.find(
			(b) => b.properties.error.const === 'invalid_route_params'
		);
		assert_params_routes_declare_400(surface);
		assert.throws(
			() => assert_input_routes_declare_400(surface),
			/has input but its 400 error schema does not name invalid_request_body/
		);
	});

	test('a GET with an input reads no body, so it needs no 400', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				define_route({
					method: 'GET',
					path: '/api/things',
					auth: { account: 'none', actor: 'none' },
					handler: stub_handler,
					description: 'Lists things',
					input: object({ name: string }),
					output: literal(null)
				})
			]
		});
		assert.strictEqual(surface.routes[0]!.error_schemas, null);
		assert_input_routes_declare_400(surface);
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

describe('assert_error_codes_specific', () => {
	/** A single-route surface (with params) whose 404 is a JSON Schema written from a schema. */
	const surface_with_404 = (schema: AnySchema): AppSurface =>
		with_declared_404(
			generate_app_surface({
				middleware_specs: [],
				route_specs: [
					define_route({
						method: 'GET',
						path: '/api/things/:id',
						auth: { account: 'required', actor: 'none' },
						handler: stub_handler,
						description: 'Get thing',
						params: object({ id: Uuid }),
						input: literal(null),
						output: literal(null)
					})
				]
			}),
			schema
		);

	test('passes for well-formed surface', () => {
		assert_error_codes_specific(build_valid_surface());
	});

	test('passes for a literal, an enum, and a union of them', () => {
		assert_error_codes_specific(
			surface_with_404(loose_object({ error: literal('thing_not_found') }))
		);
		assert_error_codes_specific(
			surface_with_404(loose_object({ error: one_of(['thing_not_found', 'parent_not_found']) }))
		);
		assert_error_codes_specific(
			surface_with_404(
				union([
					union([
						loose_object({ error: literal('inner_a') }),
						loose_object({ error: one_of(['inner_b']) })
					]),
					loose_object({ error: literal('outer') })
				])
			)
		);
	});

	test('fails on a generic error, at any status and on any route', () => {
		assert.throws(
			() => assert_error_codes_specific(surface_with_404(loose_object({ error: string }))),
			/GET \/api\/things\/:id error schema for status 404 does not name its code/
		);
	});

	test('fails on a generic branch of a union, anyOf or oneOf', () => {
		assert.throws(
			() =>
				assert_error_codes_specific(
					surface_with_404(
						union([
							loose_object({ error: literal('thing_not_found') }),
							loose_object({ error: string })
						])
					)
				),
			/does not name its code/
		);
		const surface = build_valid_surface();
		surface.routes[0]!.error_schemas = {
			'400': {
				oneOf: [
					{ type: 'object', properties: { error: { const: 'ok_branch' } } },
					{ type: 'object', properties: { message: { type: 'string' } } }
				]
			}
		};
		assert.throws(() => assert_error_codes_specific(surface), /does not name its code/);
	});

	test('fails on a body with no error property', () => {
		const surface = build_valid_surface();
		surface.routes[1]!.error_schemas = {
			'401': { type: 'object', properties: { message: { type: 'string' } } }
		};
		assert.throws(() => assert_error_codes_specific(surface), /status 401 does not name its code/);
	});

	test("reads a middleware layer's own declarations too", () => {
		const surface = build_valid_surface();
		surface.middleware[0]!.error_schemas = {
			'403': { type: 'object', properties: { error: { type: 'string' } } }
		};
		assert.throws(
			() => assert_error_codes_specific(surface),
			/middleware 'origin' error schema for status 403 does not name its code/
		);
	});
});

describe('assert_error_codes_well_formed', () => {
	const surface_with_400 = (error: Record<string, unknown>): AppSurface => {
		const surface = build_valid_surface();
		surface.routes[0]!.error_schemas = {
			'400': { anyOf: [{ type: 'object', properties: { error } }] }
		};
		return surface;
	};

	test('passes for well-formed surface', () => {
		assert_error_codes_well_formed(build_valid_surface());
	});

	test('passes codes, a literal or an enum', () => {
		assert_error_codes_well_formed(surface_with_400({ const: 'not_found' }));
		assert_error_codes_well_formed(surface_with_400({ enum: ['a', 'b_2'] }));
	});

	test('fails prose in a literal or an enum', () => {
		assert.throws(
			() => assert_error_codes_well_formed(surface_with_400({ const: 'File not found' })),
			/error code "File not found" at status 400 is not a code/
		);
		assert.throws(
			() => assert_error_codes_well_formed(surface_with_400({ enum: ['ok', 'Not-OK'] })),
			/error code "Not-OK" at status 400 is not a code/
		);
	});

	test('runs in assert_surface_invariants', () => {
		assert.throws(
			() => assert_surface_invariants(surface_with_400({ const: 'Bad Request' })),
			/is not a code/
		);
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
			define_route({
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: object({ username: string }),
				output: literal(null),
				rate_limit: 'both'
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_sensitive_routes_rate_limited(surface);
	});

	test('passes when sensitive routes have 429 in error schemas', () => {
		const specs: Array<RouteSpec> = [
			define_route({
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: object({ username: string }),
				output: literal(null),
				errors: [REST_RATE_LIMIT_EXCEEDED]
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_sensitive_routes_rate_limited(surface);
	});

	test('fails when sensitive route lacks rate limiting', () => {
		const specs: Array<RouteSpec> = [
			define_route({
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: object({ username: string }),
				output: literal(null)
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_sensitive_routes_rate_limited(surface), /no rate limiting/);
	});
});

describe('assert_no_unexpected_public_mutations', () => {
	test('passes when public mutations are in allowlist', () => {
		const specs: Array<RouteSpec> = [
			define_route({
				method: 'POST',
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: object({ username: string }),
				output: literal(null)
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_no_unexpected_public_mutations(surface, ['POST /api/account/login']);
	});

	test('fails when public mutation not in allowlist', () => {
		const specs: Array<RouteSpec> = [
			define_route({
				method: 'POST',
				path: '/api/webhook',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Webhook',
				input: object({ data: string }),
				output: literal(null)
			})
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
			define_route({
				method: 'GET',
				path: '/api/bad',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Bad GET with body',
				input: object({ name: string }),
				output: literal(null)
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(() => assert_mutation_routes_use_post(surface), /input schema on GET/);
	});
});

describe('assert_keeper_routes_under_prefix', () => {
	test('passes for well-formed surface', () => {
		assert_keeper_routes_under_prefix(build_valid_surface());
	});

	test('passes when keeper routes are under /api/', () => {
		const specs: Array<RouteSpec> = [
			define_route({
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
				input: literal(null),
				output: literal(null)
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_keeper_routes_under_prefix(surface);
	});

	test('fails when keeper route is outside expected prefix', () => {
		const specs: Array<RouteSpec> = [
			define_route({
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
				input: literal(null),
				output: literal(null)
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert.throws(
			() => assert_keeper_routes_under_prefix(surface),
			/not under any expected prefix/
		);
	});

	test('accepts custom prefixes', () => {
		const specs: Array<RouteSpec> = [
			define_route({
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
				input: literal(null),
				output: literal(null)
			})
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
				path: '/api/account/login',
				auth: { account: 'none', actor: 'none' },
				handler: stub_handler,
				description: 'Login',
				input: object({ username: string }),
				output: literal(null),
				rate_limit: 'both'
			})
		];
		const surface = generate_app_surface({ middleware_specs: [], route_specs: specs });
		assert_surface_security_policy(surface, {
			public_mutation_allowlist: ['POST /api/account/login']
		});
	});
});
