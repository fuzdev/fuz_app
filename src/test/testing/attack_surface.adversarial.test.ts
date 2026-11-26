/**
 * Runs `describe_adversarial_auth` and `describe_adversarial_input` over minimal specs, and holds
 * their surface to the error-code invariants.
 *
 * @module
 */

import { route_ok } from '#lib/http/route_result.ts';
import { describe, test } from 'vitest';
import { literal, object, optional, pipe, regex, string } from '@fuzdev/fuz_schema/schema.ts';
import { describe_adversarial_auth } from '#lib/testing/attack_surface.ts';
import { describe_adversarial_input } from '#lib/testing/adversarial_input.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import {
	assert_error_codes_specific,
	assert_error_codes_well_formed
} from '#lib/testing/surface_invariants.ts';
import { ActingActor, FactHashSchema, Uuid } from '#lib/primitive_schemas.ts';

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
					handler: (route) => route_ok({ slug: route.params.slug }),
					params: object({ slug: string }),
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
