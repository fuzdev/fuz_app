/**
 * Tests for `get_route_error_schema` and `assert_error_schema_valid` over a
 * lookup holding Zod and `@fuzdev/fuz_schema` error schemas.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';

import { assert_error_schema_valid, get_route_error_schema } from '#lib/testing/assertions.ts';
import type { RouteErrorSchemas } from '#lib/http/error_schemas.ts';
import { generate_app_surface } from '#lib/http/surface.ts';

const FuzNotFound = loose_object({ error: literal('thing_not_found') });
const ZodConflict = z.looseObject({ error: z.literal('thing_taken') });

const route = generate_app_surface({
	route_specs: [
		{
			method: 'GET',
			path: '/things/:id',
			auth: { account: 'none', actor: 'none' },
			description: 'Gets a thing.',
			input: z.null(),
			output: z.null(),
			handler: (c) => c.json(null)
		}
	],
	middleware_specs: []
}).routes[0]!;

const lookup: Map<string, RouteErrorSchemas> = new Map([
	['GET /things/:id', { 404: FuzNotFound, 409: ZodConflict }]
]);

describe('get_route_error_schema', () => {
	test('returns the declared schema of either library', () => {
		assert.strictEqual(get_route_error_schema(lookup, route, 404), FuzNotFound);
		assert.strictEqual(get_route_error_schema(lookup, route, 409), ZodConflict);
		assert.strictEqual(get_route_error_schema(lookup, route, 500), undefined);
	});
});

describe('assert_error_schema_valid', () => {
	test('passes a body matching a fuz_schema or a Zod schema', () => {
		assert_error_schema_valid(lookup, route, 404, { error: 'thing_not_found' });
		assert_error_schema_valid(lookup, route, 409, { error: 'thing_taken' });
	});

	test('throws an Error with the issues on a fuz_schema mismatch', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 404, { error: 'other' }),
			'error schema mismatch for 404 on GET /things/:id: [{"kind":"literal","expected":"\\"thing_not_found\\"","received":"string","path":["error"]}]'
		);
	});

	test('throws an Error with the issues on a Zod mismatch', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 409, { error: 'other' }),
			/^error schema mismatch for 409 on GET \/things\/:id: \[\{"code":"invalid_value"/
		);
	});

	test('fails when no schema is declared for the status', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 500, {}),
			'missing error schema for 500 on GET /things/:id'
		);
	});
});
