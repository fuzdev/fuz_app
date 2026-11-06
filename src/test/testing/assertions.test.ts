/**
 * Tests for `get_route_error_schema` and `assert_error_schema_valid` over a
 * lookup of route error maps (`AppSurfaceSpec.route_error_maps`).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { string } from '@fuzdev/fuz_schema/schema.ts';

import {
	assert_error_response_declared,
	assert_error_schema_valid,
	get_route_error_schema
} from '#lib/testing/assertions.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';

const REST_THING_NOT_FOUND = rest_error(404, 'thing_not_found');
const REST_THING_TAKEN = rest_error(409, 'thing_taken');
const REST_GATE_REFUSED = rest_error(409, 'gate_refused');
const REST_THING_INVALID = rest_error(422, 'thing_invalid', { field: string });

const spec = create_app_surface_spec({
	route_specs: [
		{
			method: 'GET',
			path: '/things/:id',
			auth: { account: 'none', actor: 'none' },
			description: 'Gets a thing.',
			input: z.null(),
			output: z.null(),
			errors: [REST_THING_NOT_FOUND, REST_THING_TAKEN, REST_THING_INVALID],
			handler: (c) => c.json(null)
		}
	],
	middleware_specs: [
		{ name: 'gate', path: '*', handler: async (_c, next) => next(), errors: [REST_GATE_REFUSED] }
	]
});
const route = spec.surface.routes[0]!;
const lookup = spec.route_error_maps;

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

	// the status's schema is a union of `literal(code)` bodies, so its parse
	// alone refuses a code the route doesn't declare there
	test('fails a code the route does not declare at the status', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 404, { error: 'other' }),
			'error schema mismatch for 404 on GET /things/:id (error "other"): [{"kind":"literal"'
		);
		// declared, but at another status
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 404, { error: 'thing_taken' }),
			'error schema mismatch for 404 on GET /things/:id (error "thing_taken"): [{"kind":"literal"'
		);
		// a status of several definitions: a code of none of them
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 409, { error: 'thing_not_found' }),
			'error schema mismatch for 409 on GET /things/:id (error "thing_not_found")'
		);
		// a code declared at the status, with another definition's fields
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 422, { error: 'thing_not_found', field: 'x' }),
			'error schema mismatch for 422 on GET /things/:id (error "thing_not_found")'
		);
	});

	test('throws an Error with the issues on a body off its schema', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 422, { error: 'thing_invalid', field: 1 }),
			'error schema mismatch for 422 on GET /things/:id (error "thing_invalid"): [{"kind":"string","expected":"string","received":"number","path":["field"]}]'
		);
	});

	test('fails when no schema is declared for the status', () => {
		assert.throws(
			() => assert_error_schema_valid(lookup, route, 500, {}),
			'missing error schema for 500 on GET /things/:id'
		);
	});
});

describe('assert_error_response_declared', () => {
	const errors = lookup.get('GET /things/:id')!;
	const json = (body: unknown, status: number): Response =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const fails = async (response: Response, jsonrpc = false): Promise<string | null> => {
		try {
			await assert_error_response_declared(errors, jsonrpc, response, 'GET /things/x');
		} catch (e) {
			return (e as Error).message;
		}
		return null;
	};

	test('passes a declared error, a success, and a non-JSON response', async () => {
		assert.isNull(await fails(json({ error: 'thing_not_found' }, 404)));
		assert.isNull(await fails(json({ error: 'gate_refused' }, 409)));
		assert.isNull(await fails(json({ ok: true }, 200)));
		assert.isNull(await fails(new Response('nope', { status: 418 })));
	});

	test('fails an undeclared status and a body off its schema', async () => {
		assert.strictEqual(
			await fails(json({ error: 'teapot' }, 418)),
			'Undeclared error status (418): GET /things/x: {"error":"teapot"}'
		);
		assert.match(
			(await fails(json({ error: 'other' }, 404)))!,
			/^Error schema mismatch \(404\): GET \/things\/x: \[/
		);
	});

	test('accepts the always-accepted errors and, on a jsonrpc route, an envelope', async () => {
		assert.isNull(await fails(json({ error: 'internal_error' }, 500)));
		assert.isNull(await fails(json({ error: 'service_unavailable' }, 503)));
		const envelope = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } };
		assert.isNull(await fails(json(envelope, 404), true));
		assert.ok(await fails(json(envelope, 404), false));
	});

	test('leaves the response readable', async () => {
		const response = json({ error: 'thing_not_found' }, 404);
		await assert_error_response_declared(errors, false, response, 'GET /things/x');
		assert.deepStrictEqual(await response.json(), { error: 'thing_not_found' });
	});
});
