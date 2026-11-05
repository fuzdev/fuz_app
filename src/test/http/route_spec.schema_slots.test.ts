/**
 * `apply_route_specs` refuses a schema slot holding a value of neither
 * library — `params`, `query`, `input`, `output`, an `errors` entry — at
 * registration, naming the route and the slot, and admits a Zod or a
 * `@fuzdev/fuz_schema` schema in each, with `params`, `query` and an `errors`
 * entry left absent.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { literal, object, string } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

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

	for (const [label, value] of NOT_SCHEMAS) {
		test(`${label} as an errors entry, naming its status`, () => {
			assert.throws(
				() => register({ errors: { 404: z.looseObject({ error: z.string() }), 409: value } }),
				refusal('errors\\.409')
			);
		});
	}

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
			errors: { 404: z.looseObject({ error: z.string() }) }
		});
	});

	test('a fuz_schema schema in every slot', () => {
		register({
			params: object({ id: string }),
			query: object({ q: string }),
			input: object({ name: string }),
			output: object({ ok: literal(true) }),
			errors: { 404: object({ error: string }) }
		});
	});

	test('absent params, query and errors entries', () => {
		register({ params: undefined, query: undefined, errors: undefined });
		register({ errors: {} });
		register({ errors: { 404: undefined } });
	});
});
