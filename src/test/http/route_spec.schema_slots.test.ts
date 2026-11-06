/**
 * `apply_route_specs` refuses a schema slot holding a value of neither
 * library — `params`, `query`, `input`, `output` — and an `errors` entry that
 * is not an error definition, at registration, naming the route and the slot,
 * and admits a Zod or a `@fuzdev/fuz_schema` schema in each schema slot and
 * definitions in `errors`, with `params`, `query` and `errors` left absent.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { literal, loose_object, object, string } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { rest_error } from '#lib/http/error_schemas.ts';

const base_route: RouteSpec = {
	method: 'POST',
	path: '/api/things',
	auth: { account: 'none', actor: 'none' },
	description: 'Takes a thing.',
	input: z.strictObject({ name: z.string() }),
	output: z.strictObject({ ok: z.literal(true) }),
	handler: (c) => c.json({ ok: true })
};

// a spec is data: a JS caller, or one cast past the types, can put anything in a slot
const register = (overrides: Record<string, unknown>): void => {
	apply_route_specs(
		new Hono(),
		[{ ...base_route, ...overrides }],
		fuz_auth_guard_resolver,
		new Logger('test', { level: 'off' }),
		create_stub_db()
	);
};

const NOT_SCHEMAS: Array<[string, unknown]> = [
	['an empty object', {}],
	['null', null],
	['a string', 'z.string()'],
	['a schema-shaped object', { kind: 'string', def: {} }]
];

const refusal = (slot: string): RegExp =>
	new RegExp(
		`^Route "POST /api/things": ${slot} is neither a Zod schema nor a @fuzdev/fuz_schema schema$`
	);

describe('apply_route_specs refuses a value of neither library', () => {
	for (const slot of ['params', 'query', 'input', 'output'] as const) {
		for (const [label, value] of NOT_SCHEMAS) {
			test(`${label} as ${slot}, naming the route and slot`, () => {
				assert.throws(() => register({ [slot]: value }), refusal(slot));
			});
		}
	}

	test('an absent input or output', () => {
		assert.throws(() => register({ input: undefined }), refusal('input'));
		assert.throws(() => register({ output: undefined }), refusal('output'));
	});

	for (const [label, value] of [
		...NOT_SCHEMAS,
		['a Zod schema', z.looseObject({ error: z.string() })],
		['a fuz_schema schema', loose_object({ error: string })]
	] as Array<[string, unknown]>) {
		test(`${label} as an errors entry, naming its index`, () => {
			assert.throws(
				() => register({ errors: [rest_error(404, 'thing_not_found'), value] }),
				/^Route "POST \/api\/things": errors\[1\] is not an error definition \(`rest_error`\)$/
			);
		});
	}

	test('a status map as errors, the form before definitions', () => {
		assert.throws(
			() => register({ errors: { 404: rest_error(404, 'thing_not_found').schema } }),
			/^Route "POST \/api\/things": errors is not a list of error definitions \(`rest_error`\)$/
		);
	});

	test('before the checks that read the schemas', () => {
		// the acting biconditional reads input and query; without the slot check
		// first, this threw a TypeError naming nothing
		assert.throws(() => register({ query: {} }), refusal('query'));
		assert.throws(() => register({ input: {} }), refusal('input'));
	});
});

describe('apply_route_specs admits', () => {
	test('a Zod schema in every slot', () => {
		register({
			params: z.strictObject({ id: z.string() }),
			query: z.strictObject({ q: z.string() }),
			errors: [rest_error(404, 'thing_not_found')]
		});
	});

	test('a fuz_schema schema in every slot', () => {
		register({
			params: object({ id: string }),
			query: object({ q: string }),
			input: object({ name: string }),
			output: object({ ok: literal(true) }),
			errors: [rest_error(404, 'thing_not_found'), rest_error(409, 'thing_taken')]
		});
	});

	test('absent params, query and errors, and an empty errors list', () => {
		register({ params: undefined, query: undefined, errors: undefined });
		register({ errors: [] });
	});
});
