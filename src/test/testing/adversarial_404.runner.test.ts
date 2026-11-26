/**
 * Runs `describe_adversarial_404` over minimal specs.
 *
 * @module
 */

import {
	literal,
	loose_object,
	min_length,
	object,
	pipe,
	string
} from '@fuzdev/fuz_schema/schema.ts';
import { stub_handler } from '#lib/testing/stubs.ts';
import { describe_adversarial_404 } from '#lib/testing/adversarial_404.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { ActingActor, Uuid } from '#lib/primitive_schemas.ts';

// --- Adversarial 404 runner tests ---

const adversarial_middleware: Array<MiddlewareSpec> = [];

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
