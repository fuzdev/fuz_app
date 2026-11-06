/**
 * `define_route`, `define_route_shape`, and `attach_route_handler`: what the
 * types accept and refuse of a handler's results, checked by `gro typecheck`
 * through the `@ts-expect-error`s below, and that at runtime they return the
 * spec they were given.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import type { Context } from 'hono';
import { z } from 'zod';
import { array, literal, loose_object, number, string } from '@fuzdev/fuz_schema/schema.ts';

import {
	attach_route_handler,
	define_route,
	define_route_shape,
	type RouteSpec
} from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_raw } from '#lib/http/route_result.ts';
import {
	ERROR_TABLE_NOT_FOUND,
	ERROR_TOKEN_SCOPE_REQUIRED,
	REST_AUTHENTICATION_REQUIRED,
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP,
	REST_CREDENTIAL_TYPE_REQUIRED,
	REST_INSUFFICIENT_PERMISSIONS,
	REST_INTERNAL_ERROR,
	REST_RATE_LIMIT_EXCEEDED,
	REST_ROW_NOT_FOUND,
	REST_SERVICE_UNAVAILABLE,
	REST_TABLE_NOT_FOUND,
	REST_TOKEN_SCOPE_REQUIRED,
	rest_error,
	type RestErrorDef
} from '#lib/http/error_schemas.ts';

const shape = {
	method: 'GET',
	path: '/x',
	auth: { account: 'none', actor: 'none' },
	description: 'x',
	input: literal(null),
	output: loose_object({ n: number })
} as const;

// a handler that throws fits any route, and is never run here
const unreachable = (): never => {
	throw new Error('unreachable');
};

const prebuilt = (c: Context) =>
	c.req.query('x') ? route_fail(REST_ROW_NOT_FOUND) : route_ok({ n: 1 });

const split_shape = define_route_shape({ ...shape, errors: [REST_TABLE_NOT_FOUND] });

// The checks are the `@ts-expect-error`s: each must be used. They run in a
// function that is never called, so no spec is applied.
export const type_cases = (c: Context): Array<unknown> => [
	// a declared definition, the catch layers', a raw response, a success
	define_route({
		...shape,
		errors: [REST_TABLE_NOT_FOUND],
		handler: async (c) => {
			if (c.req.query('a')) return route_fail(REST_TABLE_NOT_FOUND);
			if (c.req.query('b')) return route_fail(REST_INTERNAL_ERROR);
			if (c.req.query('c')) return route_fail(REST_SERVICE_UNAVAILABLE);
			if (c.req.query('d')) return route_raw(new Response('bytes'));
			return route_ok({ n: 1 });
		}
	}),
	// literals are kept and arrays read as readonly, against the output's input side
	define_route({
		...shape,
		output: z.strictObject({ ok: z.literal(true), tags: z.array(z.string()) }),
		handler: () => route_ok({ ok: true, tags: ['a'] })
	}),
	define_route({
		...shape,
		output: z.strictObject({ ready: z.literal(true) }),
		// @ts-expect-error a literal output takes only its literal
		handler: () => route_ok({ ready: false })
	}),
	define_route({
		...shape,
		errors: [REST_TABLE_NOT_FOUND],
		// @ts-expect-error an undeclared definition
		handler: () => route_fail(REST_ROW_NOT_FOUND)
	}),
	// @ts-expect-error a `Response` is not a result
	define_route({ ...shape, handler: (c) => c.json({ n: 1 }) }),
	// @ts-expect-error the output is checked
	define_route({ ...shape, handler: () => route_ok({ n: 'x' }) }),
	define_route({
		...shape,
		output: loose_object({ items: array(string) }),
		// @ts-expect-error a fuz_schema output's element
		handler: () => route_ok({ items: [1] })
	}),
	// a zod brand's input side is the plain value, and a default may be left out
	define_route({
		...shape,
		output: z.strictObject({
			id: z.string().brand('Uuid'),
			tags: z.array(z.string()).default([])
		}),
		handler: () => route_ok({ id: 'x' })
	}),
	define_route({
		...shape,
		// @ts-expect-error a 429 only where `rate_limit` derives it
		handler: () => route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 1 })
	}),
	define_route({
		...shape,
		rate_limit: 'both',
		handler: () => route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 1 })
	}),
	// @ts-expect-error a required field is required
	define_route({ ...shape, rate_limit: 'ip', handler: () => route_fail(REST_RATE_LIMIT_EXCEEDED) }),
	define_route({
		...shape,
		errors: [REST_TABLE_NOT_FOUND],
		// @ts-expect-error a bare code takes no fields
		handler: () => route_fail(REST_TABLE_NOT_FOUND, { why: 'x' })
	}),
	// optional fields may be left out, or given
	define_route({
		...shape,
		errors: [REST_AUTHENTICATION_REQUIRED_BOOTSTRAP],
		handler: (c) =>
			c.req.query('a')
				? route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP)
				: c.req.query('b')
					? route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP, {})
					: route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP, { bootstrap_available: true })
	}),
	// the bare 401 where the bootstrap shape is declared: a body its schema accepts
	define_route({
		...shape,
		errors: [REST_AUTHENTICATION_REQUIRED_BOOTSTRAP],
		handler: () => route_fail(REST_AUTHENTICATION_REQUIRED)
	}),
	// and the bootstrap shape where the bare 401 is derived: a loose body
	define_route({
		...shape,
		auth: { account: 'required', actor: 'none' },
		handler: () => route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP, { bootstrap_available: true })
	}),
	define_route({
		...shape,
		errors: [REST_TABLE_NOT_FOUND],
		// @ts-expect-error the same code at another status
		handler: () => route_fail(rest_error(410, ERROR_TABLE_NOT_FOUND))
	}),
	define_route({
		...shape,
		auth: { account: 'required', actor: 'none', required_scope: 'surface:x' },
		// @ts-expect-error a body missing a field the declared one requires
		handler: () => route_fail(rest_error(403, ERROR_TOKEN_SCOPE_REQUIRED))
	}),
	define_route({
		...shape,
		auth: { account: 'required', actor: 'none', required_scope: 'surface:x' },
		handler: () => route_fail(REST_TOKEN_SCOPE_REQUIRED, { required_scope: 'surface:x' })
	}),
	// @ts-expect-error `auth` none derives no 401
	define_route({ ...shape, handler: () => route_fail(REST_AUTHENTICATION_REQUIRED) }),
	define_route({
		...shape,
		auth: { account: 'required', actor: 'none' },
		handler: () => route_fail(REST_AUTHENTICATION_REQUIRED)
	}),
	define_route({
		...shape,
		auth: { account: 'required', actor: 'none' },
		// @ts-expect-error no roles, no 403 `insufficient_permissions`
		handler: () => route_fail(REST_INSUFFICIENT_PERMISSIONS, { required_roles: [] })
	}),
	define_route({
		...shape,
		auth: { account: 'required', actor: 'none', roles: ['admin'], credential_types: ['session'] },
		handler: (c) =>
			c.req.query('a')
				? route_fail(REST_INSUFFICIENT_PERMISSIONS, { required_roles: ['admin'] })
				: route_fail(REST_CREDENTIAL_TYPE_REQUIRED, { required_credential_types: ['session'] })
	}),
	define_route({
		...shape,
		// @ts-expect-error an erased list is refused
		errors: [REST_TABLE_NOT_FOUND] as Array<RestErrorDef>,
		handler: () => route_fail(REST_ROW_NOT_FOUND)
	}),
	// @ts-expect-error a prebuilt handler is checked too
	define_route({ ...shape, errors: [REST_TABLE_NOT_FOUND], handler: prebuilt }),
	// the split form, checked the same
	attach_route_handler(split_shape, () => route_fail(REST_TABLE_NOT_FOUND)),
	// @ts-expect-error the split form, undeclared
	attach_route_handler(split_shape, () => route_fail(REST_ROW_NOT_FOUND)),
	// @ts-expect-error a `c.json` response goes through `route_ok` or `route_fail`
	route_raw(c.json({ error: 'x' }, 404)),
	// @ts-expect-error a success too
	route_raw(c.json({ n: 1 })),
	route_raw(c.body(null, 404)),
	route_raw(c.text('Bad Request\n', 400)),
	route_raw(c.body('{"jsonrpc":"2.0"}', 400, { 'Content-Type': 'application/json' })),
	// a handler that throws fits any route
	define_route({ ...shape, handler: unreachable }),
	// `undefined` is no body, though the output's input side takes it
	define_route({ ...shape, output: z.unknown(), handler: () => route_ok(null) }),
	// @ts-expect-error an unknown output takes no `undefined`
	define_route({ ...shape, output: z.unknown(), handler: () => route_ok(undefined) }),
	// @ts-expect-error nor does an optional one
	define_route({ ...shape, output: z.string().optional(), handler: () => route_ok(undefined) })
];

// @ts-expect-error a spec literal has no brand: only `define_route` and `attach_route_handler` make one
export const literal_spec: RouteSpec = { ...shape, handler: () => route_ok({ n: 1 }) };

describe('define_route', () => {
	test('returns the spec it was given', () => {
		const spec = { ...shape, handler: () => route_ok({ n: 1 }) };
		assert.strictEqual<unknown>(define_route(spec), spec);
	});

	test('a spec has no brand property at runtime', () => {
		const spec = define_route({ ...shape, handler: () => route_ok({ n: 1 }) });
		assert.deepStrictEqual(Object.getOwnPropertySymbols(spec), []);
	});
});

describe('define_route_shape', () => {
	test('returns the shape it was given', () => {
		const given = { ...shape, errors: [REST_TABLE_NOT_FOUND] };
		assert.strictEqual(define_route_shape(given), given);
	});
});

describe('attach_route_handler', () => {
	test('returns the shape with the handler, leaving the shape as it was', () => {
		const handler = () => route_fail(REST_TABLE_NOT_FOUND);
		const spec = attach_route_handler(split_shape, handler);
		assert.notStrictEqual<unknown>(spec, split_shape);
		assert.strictEqual(spec.handler, handler);
		assert.strictEqual(spec.path, split_shape.path);
		assert.deepStrictEqual(spec.errors, [REST_TABLE_NOT_FOUND]);
		assert.ok(!('handler' in split_shape));
	});
});
