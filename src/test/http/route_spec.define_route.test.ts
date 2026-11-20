/**
 * `define_route`, `define_route_shape`, and `attach_route_handler`: what the
 * types accept and refuse of a handler's results, checked by `gro typecheck`
 * through the `@ts-expect-error`s below, and that at runtime they return the
 * spec they were given.
 *
 * @module
 */

import { describe, assert, expectTypeOf, test } from 'vitest';
import type { Context } from 'hono';
import {
	array,
	brand,
	literal,
	loose_object,
	number,
	object,
	optional,
	string,
	unknown,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';

import {
	attach_route_handler,
	define_route,
	define_route_shape,
	type RouteContext,
	type RouteSpec
} from '#lib/http/route_spec.ts';
import type { RequestActorContext, RequestContext } from '#lib/auth/request_context.ts';
import type { ResolvedAuth } from '#lib/auth/resolved_auth.ts';
import { ActingActor, type Uuid } from '#lib/primitive_schemas.ts';
import { route_fail, route_ok, route_raw, route_sse } from '#lib/http/route_result.ts';
import type { SseStream } from '#lib/realtime/sse.ts';
import { query_first, type QueryPairsRead } from '#lib/http/request_target.ts';
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

/** A query key's first value, as a handler reads one off `route.query_pairs`. */
const query_of = (route: { query_pairs: QueryPairsRead }, name: string): string | undefined =>
	route.query_pairs.ok ? query_first(route.query_pairs.value, name) : undefined;

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

const prebuilt = (route: RouteContext) =>
	query_of(route, 'x') ? route_fail(REST_ROW_NOT_FOUND) : route_ok({ n: 1 });

const split_shape = define_route_shape({ ...shape, errors: [REST_TABLE_NOT_FOUND] });

// The checks are the `@ts-expect-error`s: each must be used. They run in a
// function that is never called, so no spec is applied.
export const type_cases = (c: Context): Array<unknown> => [
	// a declared definition, the catch layers', a raw response, a success
	define_route({
		...shape,
		errors: [REST_TABLE_NOT_FOUND],
		handler: async (route) => {
			if (query_of(route, 'a')) return route_fail(REST_TABLE_NOT_FOUND);
			if (query_of(route, 'b')) return route_fail(REST_INTERNAL_ERROR);
			if (query_of(route, 'c')) return route_fail(REST_SERVICE_UNAVAILABLE);
			if (query_of(route, 'd')) {
				return route_raw({ status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'bytes' });
			}
			if (query_of(route, 'e')) return route_sse(null as unknown as SseStream<{ n: number }>);
			return route_ok({ n: 1 });
		}
	}),
	// literals are kept and arrays read as readonly, against the output's input side
	define_route({
		...shape,
		output: object({ ok: literal(true), tags: array(string) }),
		handler: () => route_ok({ ok: true, tags: ['a'] })
	}),
	define_route({
		...shape,
		output: object({ ready: literal(true) }),
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
	define_route({ ...shape, handler: () => c.json({ n: 1 }) }),
	// @ts-expect-error the output is checked
	define_route({ ...shape, handler: () => route_ok({ n: 'x' }) }),
	define_route({
		...shape,
		output: loose_object({ items: array(string) }),
		// @ts-expect-error a fuz_schema output's element
		handler: () => route_ok({ items: [1] })
	}),
	// a brand's input side is the plain value, and a default may be left out
	define_route({
		...shape,
		output: object({
			id: brand(string, 'Uuid'),
			tags: with_default(array(string), [])
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
	// a failure built by hand carries the definition at its own status and code
	define_route({
		...shape,
		errors: [REST_TABLE_NOT_FOUND],
		handler: () => ({
			ok: false as const,
			status: 404 as const,
			code: 'table_not_found' as const,
			body: { error: 'table_not_found' as const },
			def: REST_TABLE_NOT_FOUND
		})
	}),
	define_route({
		...shape,
		errors: [REST_TABLE_NOT_FOUND],
		// @ts-expect-error a definition at another status and code
		handler: () => ({
			ok: false as const,
			status: 404 as const,
			code: 'table_not_found' as const,
			body: { error: 'table_not_found' as const },
			def: REST_RATE_LIMIT_EXCEEDED
		})
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
		handler: (route) =>
			query_of(route, 'a')
				? route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP)
				: query_of(route, 'b')
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
		handler: (route) =>
			query_of(route, 'a')
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
	// @ts-expect-error a raw answer is data, never a `Response`
	route_raw(c.json({ error: 'x' }, 404)),
	// @ts-expect-error nor a body-built one
	route_raw(c.body(null, 404)),
	route_raw({ status: 404 }),
	route_raw({ status: 400, headers: { 'Content-Type': 'text/plain' }, body: 'Bad Request\n' }),
	route_raw({
		status: 400,
		headers: { 'Content-Type': 'application/json' },
		body: '{"jsonrpc":"2.0"}'
	}),
	// @ts-expect-error a body is no `Response`
	route_raw({ status: 200, headers: { 'Content-Type': 'text/plain' }, body: new Response('x') }),
	route_ok({ n: 1 }, { set_cookie: ['x=1'] }),
	// a handler that throws fits any route
	define_route({ ...shape, handler: unreachable }),
	// `undefined` is no body, though the output's input side takes it
	define_route({ ...shape, output: unknown, handler: () => route_ok(null) }),
	// @ts-expect-error an unknown output takes no `undefined`
	define_route({ ...shape, output: unknown, handler: () => route_ok(undefined) }),
	// @ts-expect-error nor does an optional one
	define_route({ ...shape, output: optional(string), handler: () => route_ok(undefined) }),
	// @ts-expect-error a handler takes the route context, never the Hono context
	define_route({ ...shape, handler: (_c: Context) => route_ok({ n: 1 }) }),
	// @ts-expect-error nor the Hono context beside it
	define_route({ ...shape, handler: (_c: Context, _route: RouteContext) => route_ok({ n: 1 }) })
];

const typed_input = object({ name: string, n: with_default(number, 1) });
const typed_params = object({ id: string });
const typed_query = object({ acting: ActingActor });

const typed_split_shape = define_route_shape({
	...shape,
	method: 'POST',
	input: typed_input,
	params: typed_params
});
const actor_split_shape = define_route_shape({
	...shape,
	auth: { account: 'required', actor: 'required' },
	query: typed_query
});

// What the handler's `route` is typed as, read off the spec — never called.
export const typed_context_cases = (): Array<unknown> => [
	define_route({
		...shape,
		method: 'POST',
		input: typed_input,
		params: typed_params,
		handler: (route) => {
			expectTypeOf(route.input).toEqualTypeOf<{ name: string; n: number }>();
			expectTypeOf(route.params).toEqualTypeOf<{ id: string }>();
			expectTypeOf(route.query).toEqualTypeOf<undefined>();
			expectTypeOf(route.auth).toEqualTypeOf<RequestContext | null>();
			expectTypeOf(route.credential).toEqualTypeOf<ResolvedAuth | null>();
			expectTypeOf(route.client_ip).toEqualTypeOf<string>();
			expectTypeOf(route.signal).toEqualTypeOf<AbortSignal>();
			return route_ok({ n: route.input.n });
		}
	}),
	define_route({
		...shape,
		// @ts-expect-error a route without `params` has none to read
		handler: (route) => route_ok({ n: route.params.id })
	}),
	define_route({
		...shape,
		handler: (route) => {
			expectTypeOf(route.input).toEqualTypeOf<null>();
			return route_ok({ n: 1 });
		}
	}),
	// an account-required route's `auth` is a request context, an actor-required
	// one's carries its actor
	define_route({
		...shape,
		auth: { account: 'required', actor: 'none' },
		handler: (route) => {
			expectTypeOf(route.auth).toEqualTypeOf<RequestContext>();
			return route_ok({ n: route.auth.account.username.length });
		}
	}),
	define_route({
		...shape,
		auth: { account: 'required', actor: 'required' },
		query: typed_query,
		handler: (route) => {
			expectTypeOf(route.auth).toEqualTypeOf<RequestActorContext>();
			expectTypeOf(route.query).toEqualTypeOf<{ acting?: Uuid | undefined }>();
			return route_ok({ n: route.auth.actor.name.length });
		}
	}),
	define_route({
		...shape,
		// @ts-expect-error a public route's `auth` may be null
		handler: (route) => route_ok({ n: route.auth.account.username.length })
	}),
	// the split form types its handler's context from the shape
	attach_route_handler(typed_split_shape, (route) =>
		route_ok({ n: route.input.n + route.params.id.length })
	),
	// a handler written with no parameter still fits
	attach_route_handler(split_shape, () => route_ok({ n: 1 }))
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

describe('define_route auth guard', () => {
	const stub_route = (auth: RequestContext | null): RouteContext =>
		({ auth }) as unknown as RouteContext;
	const actor_context = {
		account: { id: 'a' },
		actor: { id: 'b' },
		role_grants: []
	} as unknown as RequestContext;
	const account_context = { ...actor_context, actor: null } as unknown as RequestContext;

	test('a public route keeps its handler as given', () => {
		const handler = () => route_ok({ n: 1 });
		assert.strictEqual(define_route({ ...shape, handler }).handler, handler);
	});

	test('an account-required route refuses to run without a request context', async () => {
		const spec = define_route({
			...shape,
			auth: { account: 'required', actor: 'none' },
			handler: () => route_ok({ n: 1 })
		});
		assert.throws(() => spec.handler(stub_route(null)), /no request context/);
		assert.deepStrictEqual(await spec.handler(stub_route(account_context)), route_ok({ n: 1 }));
	});

	test('an actor-required route refuses to run without an acting actor', async () => {
		const spec = attach_route_handler(actor_split_shape, () => route_ok({ n: 1 }));
		assert.throws(() => spec.handler(stub_route(null)), /no request context/);
		assert.throws(() => spec.handler(stub_route(account_context)), /no acting actor/);
		assert.deepStrictEqual(await spec.handler(stub_route(actor_context)), route_ok({ n: 1 }));
	});

	test('a spread whose `auth` was rewritten keeps the guard its handler was typed for', () => {
		const spec = define_route({
			...shape,
			auth: { account: 'required', actor: 'none' },
			handler: () => route_ok({ n: 1 })
		});
		const rewritten = { ...spec, auth: { account: 'none', actor: 'none' } } as RouteSpec;
		assert.throws(() => rewritten.handler(stub_route(null)), /no request context/);
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
