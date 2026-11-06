/**
 * Tests for `get_route_error_schema` and `assert_error_schema_valid` over a
 * lookup of route error maps (`AppSurfaceSpec.route_errors`).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import { assert_error_schema_valid, get_route_error_schema } from '#lib/testing/assertions.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';

const REST_THING_NOT_FOUND = rest_error(404, 'thing_not_found');
const REST_THING_TAKEN = rest_error(409, 'thing_taken');
const REST_GATE_REFUSED = rest_error(409, 'gate_refused');

const spec = create_app_surface_spec({
	route_specs: [
		{
			method: 'GET',
			path: '/things/:id',
			auth: { account: 'none', actor: 'none' },
			description: 'Gets a thing.',
			input: z.null(),
			output: z.null(),
			errors: [REST_THING_NOT_FOUND, REST_THING_TAKEN],
			handler: (c) => c.json(null)
		}
	],
	middleware_specs: [
		{ name: 'gate', path: '*', handler: async (_c, next) => next(), errors: [REST_GATE_REFUSED] }
	]
});
const route = spec.surface.routes[0]!;
const lookup = spec.route_errors;

describe('get_route_error_schema', () => {
	test("returns the route error map's schema at a status", () => {
		assert.strictEqual(get_route_error_schema(lookup, route, 404), REST_THING_NOT_FOUND.schema);
		// the route's own and the middleware's, a union
		assert.deepStrictEqual(get_route_error_schema(lookup, route, 409)?.def, [
			REST_GATE_REFUSED.schema,
			REST_THING_TAKEN.schema
		]);
		assert.strictEqual(get_route_error_schema(lookup, route, 500), undefined);
	});
});

describe('assert_error_schema_valid', () => {
	test("passes a body matching the route's or a middleware's definition", () => {
		assert_error_schema_valid(lookup, route, 404, { error: 'thing_not_found' });
		assert_error_schema_valid(lookup, route, 409, { error: 'thing_taken' });
		assert_error_schema_valid(lookup, route, 409, { error: 'gate_refused' });
	});

	test('throws an Error with the issues on a mismatch', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 404, { error: 'other' }),
			'error schema mismatch for 404 on GET /things/:id: [{"kind":"literal","expected":"\\"thing_not_found\\"","received":"string","path":["error"]}]'
		);
	});

	test('fails when no schema is declared for the status', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 500, {}),
			'missing error schema for 500 on GET /things/:id'
		);
	});
});
