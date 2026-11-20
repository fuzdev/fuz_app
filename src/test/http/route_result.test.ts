/**
 * The responses `apply_route_specs` builds from a handler's result: a
 * `route_ok` as JSON at 200 with its `set_cookie` lines after any on the
 * context, a `route_fail` as its definition's body at its status with the
 * headers it derives (`Retry-After`) and never a cookie, a `route_raw` as
 * the data describes it, and every raw answer the prepare refuses, refused at
 * the prepare. The SSE result is `route_result.sse.test.ts`'s; that a refusal
 * commits nothing is `route_result.refusal.db.test.ts`'s.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { literal, loose_object, number, object, string } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	apply_route_specs,
	define_route,
	prepare_route_response,
	type RouteSpec
} from '#lib/http/route_spec.ts';
import {
	ROUTE_RAW_REFUSED_HEADERS,
	route_fail,
	route_ok,
	route_raw
} from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

import { route_raw_admitted, route_raw_refusals } from './route_raw_refusals.ts';
import {
	ERROR_INTERNAL_ERROR,
	ERROR_RATE_LIMIT_EXCEEDED,
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP,
	REST_RATE_LIMIT_EXCEEDED,
	REST_ROW_NOT_FOUND,
	REST_TABLE_NOT_FOUND
} from '#lib/http/error_schemas.ts';

const shape = {
	method: 'GET',
	auth: { account: 'none', actor: 'none' },
	description: 'A route.',
	input: literal(null),
	output: loose_object({ n: number })
} as const;

const create_app = (specs: Array<RouteSpec>): Hono => {
	const app = new Hono();
	// a line the middleware put on the context, as the session middleware's clear
	app.use('/cookies/after_context', async (c, next) => {
		c.header('Set-Cookie', 'first=; Max-Age=0', { append: true });
		await next();
	});
	apply_route_specs(
		app,
		specs,
		fuz_auth_guard_resolver,
		new Logger('test', { level: 'off' }),
		create_stub_db()
	);
	return app;
};

// a domain helper that fails without the context, as shared code does
const find_row = (id: string) => (id === 'missing' ? route_fail(REST_ROW_NOT_FOUND) : null);

const app = create_app([
	define_route({
		...shape,
		path: '/ok',
		handler: () => route_ok({ n: 1 })
	}),
	define_route({
		...shape,
		path: '/limited/:retry_after',
		params: object({ retry_after: string }),
		rate_limit: 'ip',
		handler: (route) =>
			route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: Number(route.params.retry_after) })
	}),
	define_route({
		...shape,
		path: '/bare',
		errors: [REST_TABLE_NOT_FOUND],
		handler: () => route_fail(REST_TABLE_NOT_FOUND)
	}),
	define_route({
		...shape,
		path: '/optional/:given',
		params: object({ given: string }),
		errors: [REST_AUTHENTICATION_REQUIRED_BOOTSTRAP],
		handler: (route) =>
			route.params.given === 'yes'
				? route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP, { bootstrap_available: true })
				: route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP)
	}),
	define_route({
		...shape,
		path: '/forward/:id',
		params: object({ id: string }),
		errors: [REST_ROW_NOT_FOUND],
		handler: (route) => {
			const failure = find_row(route.params.id);
			if (failure) return failure;
			return route_ok({ n: 2 });
		}
	}),
	define_route({
		...shape,
		path: '/cookies/ok',
		handler: () => route_ok({ n: 5 }, { set_cookie: ['a=1; Path=/', 'b=2; Path=/'] })
	}),
	define_route({
		...shape,
		path: '/cookies/after_context',
		// the middleware `create_app` mounts puts a line on the context first
		handler: () => route_ok({ n: 6 }, { set_cookie: ['second=1'] })
	}),
	define_route({
		...shape,
		path: '/cookies/fail',
		rate_limit: 'ip',
		// no factory makes this: a failure carrying a cookie
		handler: () =>
			({
				...route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 1 }),
				set_cookie: ['x=1']
			}) as never
	}),
	define_route({
		...shape,
		path: '/raw/empty',
		handler: () => route_raw({ status: 404 })
	}),
	define_route({
		...shape,
		path: '/raw/text',
		handler: () =>
			route_raw({
				status: 418,
				headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'X-Raw': 'yes' },
				body: 'teapot'
			})
	}),
	define_route({
		...shape,
		path: '/raw/bytes',
		handler: () =>
			route_raw({
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
				body: new Uint8Array([1, 2, 3])
			})
	}),
	define_route({
		...shape,
		path: '/raw/stream',
		handler: () =>
			route_raw({
				status: 200,
				headers: { 'Content-Type': 'text/plain' },
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('streamed'));
						controller.close();
					}
				})
			})
	}),
	define_route({
		...shape,
		path: '/raw/repeated',
		handler: () => route_raw({ status: 200, headers: { 'X-Many': ['a', 'b'] } })
	}),
	define_route({
		...shape,
		path: '/headers/ok',
		response_headers: { 'Cache-Control': 'no-store' },
		handler: () => route_ok({ n: 3 })
	}),
	define_route({
		...shape,
		path: '/headers/fail',
		rate_limit: 'ip',
		response_headers: { 'Cache-Control': 'no-store' },
		handler: () => route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 4 })
	}),
	define_route({
		...shape,
		path: '/headers/raw',
		response_headers: { 'Cache-Control': 'no-store' },
		handler: () => route_raw({ status: 204 })
	}),
	define_route({
		...shape,
		path: '/bare_response',
		// a handler typed `any`, or JS, that still returns a `Response`
		handler: () => Response.json({ n: 4 }) as never
	}),
	// results no factory makes: a success without a value, a failure without
	// its definition, an `ok` of neither kind, a raw result without its fields
	...(
		[
			['ok_no_value', { ok: true, set_cookie: [] }],
			['ok_undefined_value', { ok: true, value: undefined, set_cookie: [] }],
			['ok_no_set_cookie', { ok: true, value: 1 }],
			['fail_no_def', { ok: false, status: 404, body: { error: 'x' } }],
			['fail_no_status', { ok: false, body: { error: 'x' }, def: REST_ROW_NOT_FOUND }],
			['ok_other', { ok: 'yes', value: 1 }],
			['raw_no_fields', { ok: 'raw' }],
			['sse_no_stream', { ok: 'sse' }]
		] as const
	).map(([name, result]) =>
		define_route({
			...shape,
			path: `/malformed/${name}`,
			handler: () => result as never
		})
	)
]);

describe('route_ok', () => {
	test('answers its value as JSON at 200', async () => {
		const res = await app.request('/ok');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
		assert.deepStrictEqual(res.headers.getSetCookie(), []);
		assert.strictEqual(await res.text(), '{"n":1}');
	});

	test("carries the route's `response_headers`", async () => {
		const res = await app.request('/headers/ok');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
		assert.strictEqual(await res.text(), '{"n":3}');
	});

	test('carries its `set_cookie` lines, in order', async () => {
		const res = await app.request('/cookies/ok');
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
		assert.strictEqual(await res.text(), '{"n":5}');
	});

	test('writes its lines after a `Set-Cookie` already on the context', async () => {
		const res = await app.request('/cookies/after_context');
		assert.deepStrictEqual(res.headers.getSetCookie(), ['first=; Max-Age=0', 'second=1']);
	});

	test('the result is plain data', () => {
		assert.deepStrictEqual(route_ok({ n: 1 }), { ok: true, value: { n: 1 }, set_cookie: [] });
		assert.deepStrictEqual(route_ok({ n: 1 }, { set_cookie: ['a=1'] }), {
			ok: true,
			value: { n: 1 },
			set_cookie: ['a=1']
		});
	});
});

describe('route_fail', () => {
	test('answers the 429 body and Retry-After header', async () => {
		const res = await app.request('/limited/57');
		assert.strictEqual(res.status, 429);
		assert.strictEqual(res.headers.get('Retry-After'), '57');
		assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
		assert.strictEqual(
			await res.text(),
			`{"error":"${ERROR_RATE_LIMIT_EXCEEDED}","retry_after":57}`
		);
	});

	test('Retry-After rounds up fractional seconds, the body keeps them', async () => {
		const res = await app.request('/limited/12.3');
		assert.strictEqual(res.headers.get('Retry-After'), '13');
		assert.deepStrictEqual(await res.json(), {
			error: ERROR_RATE_LIMIT_EXCEEDED,
			retry_after: 12.3
		});
	});

	test('a retry_after of 0', async () => {
		const res = await app.request('/limited/0');
		assert.strictEqual(res.status, 429);
		assert.strictEqual(res.headers.get('Retry-After'), '0');
	});

	test('a bare code answers `{error}` at its status', async () => {
		const res = await app.request('/bare');
		assert.strictEqual(res.status, 404);
		assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
		assert.strictEqual(await res.text(), '{"error":"table_not_found"}');
	});

	test('optional fields, left out or given', async () => {
		const without = await app.request('/optional/no');
		assert.strictEqual(without.status, 401);
		assert.strictEqual(await without.text(), '{"error":"authentication_required"}');
		const given = await app.request('/optional/yes');
		assert.strictEqual(given.status, 401);
		assert.strictEqual(
			await given.text(),
			'{"error":"authentication_required","bootstrap_available":true}'
		);
	});

	test('a failure from a helper is forwarded', async () => {
		const missing = await app.request('/forward/missing');
		assert.strictEqual(missing.status, 404);
		assert.strictEqual(await missing.text(), '{"error":"row_not_found"}');
		const found = await app.request('/forward/x');
		assert.strictEqual(found.status, 200);
		assert.strictEqual(await found.text(), '{"n":2}');
	});

	test("carries the route's `response_headers` beside its own", async () => {
		const res = await app.request('/headers/fail');
		assert.strictEqual(res.status, 429);
		assert.strictEqual(res.headers.get('Retry-After'), '4');
		assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
	});

	test('a failure carrying a cookie is refused, and the cookie never sent', async () => {
		const res = await app.request('/cookies/fail');
		assert.strictEqual(res.status, 500);
		assert.deepStrictEqual(res.headers.getSetCookie(), []);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, ERROR_INTERNAL_ERROR);
	});

	test('the result is plain data', () => {
		const failure = route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 1 });
		assert.strictEqual(failure.ok, false);
		assert.strictEqual(failure.status, 429);
		assert.strictEqual(failure.code, ERROR_RATE_LIMIT_EXCEEDED);
		assert.deepStrictEqual(failure.body, { error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 1 });
		assert.strictEqual(failure.def, REST_RATE_LIMIT_EXCEEDED);
		assert.notProperty(failure, 'set_cookie');
	});
});

describe('route_raw', () => {
	test('answers an empty body at its status', async () => {
		const res = await app.request('/raw/empty');
		assert.strictEqual(res.status, 404);
		assert.strictEqual(res.headers.get('Content-Type'), null);
		assert.strictEqual(await res.text(), '');
	});

	test('answers any status, with its own headers and its declared Content-Type', async () => {
		const res = await app.request('/raw/text');
		assert.strictEqual(res.status, 418);
		assert.strictEqual(res.headers.get('X-Raw'), 'yes');
		assert.strictEqual(res.headers.get('Content-Type'), 'text/plain; charset=UTF-8');
		assert.strictEqual(await res.text(), 'teapot');
	});

	test('answers bytes with the Content-Length it declares', async () => {
		const res = await app.request('/raw/bytes');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('Content-Type'), 'application/octet-stream');
		assert.strictEqual(res.headers.get('Content-Length'), '3');
		assert.deepStrictEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
	});

	test('answers a stream', async () => {
		const res = await app.request('/raw/stream');
		assert.strictEqual(res.headers.get('Content-Type'), 'text/plain');
		assert.strictEqual(await res.text(), 'streamed');
	});

	test('writes a repeated header once per value', async () => {
		const res = await app.request('/raw/repeated');
		assert.strictEqual(res.headers.get('X-Many'), 'a, b');
	});

	test("carries the route's `response_headers`", async () => {
		const res = await app.request('/headers/raw');
		assert.strictEqual(res.status, 204);
		assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
	});

	test('the result is plain data', () => {
		assert.deepStrictEqual(route_raw({ status: 404 }), {
			ok: 'raw',
			status: 404,
			headers: {},
			body: null
		});
	});

	test('every hop-by-hop name and Set-Cookie is refused', () => {
		assert.deepStrictEqual([...ROUTE_RAW_REFUSED_HEADERS].sort(), [
			'connection',
			'keep-alive',
			'proxy-connection',
			'set-cookie',
			'te',
			'trailer',
			'transfer-encoding',
			'upgrade'
		]);
	});
});

describe('a bare Response', () => {
	test('answers 500 internal_error', async () => {
		const res = await app.request('/bare_response');
		assert.strictEqual(res.status, 500);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, ERROR_INTERNAL_ERROR);
	});
});

describe('a malformed result', () => {
	for (const name of [
		'ok_no_value',
		'ok_undefined_value',
		'ok_no_set_cookie',
		'fail_no_def',
		'fail_no_status',
		'ok_other',
		'raw_no_fields',
		'sse_no_stream'
	]) {
		test(`${name} answers 500 internal_error`, async () => {
			const res = await app.request(`/malformed/${name}`);
			assert.strictEqual(res.status, 500);
			const body = (await res.json()) as { error: string };
			assert.strictEqual(body.error, ERROR_INTERNAL_ERROR);
		});
	}
});

describe('prepare_route_response', () => {
	const prepare = (result: unknown) =>
		prepare_route_response(result as never, { label: 'GET /', opened_sse: new Map() });

	const cases: Array<[name: string, result: () => unknown, kind: string]> = [
		['ok_no_value', () => ({ ok: true, set_cookie: [] }), 'a success without a JSON value'],
		[
			'ok_undefined_value',
			() => ({ ok: true, value: undefined, set_cookie: [] }),
			'a success without a JSON value'
		],
		['fail_no_def', () => ({ ok: false, status: 404, body: { error: 'x' } }), 'a malformed result'],
		[
			'fail_no_status',
			() => ({ ok: false, body: { error: 'x' }, def: REST_ROW_NOT_FOUND }),
			'a malformed result'
		],
		['ok_other', () => ({ ok: 'yes', value: 1 }), 'a malformed result'],
		// no JSON value: `JSON.stringify` writes nothing for these
		[
			'ok_function_value',
			() => ({ ok: true, value: () => 1, set_cookie: [] }),
			'a success without a JSON value'
		],
		[
			'ok_function_with_fields',
			() => ({ ok: true, value: Object.assign(() => 1, { a: 1 }), set_cookie: [] }),
			'a success without a JSON value'
		],
		[
			'ok_symbol_value',
			() => ({ ok: true, value: Symbol('x'), set_cookie: [] }),
			'a success without a JSON value'
		],
		['raw_no_fields', () => ({ ok: 'raw' }), 'a raw answer at status undefined'],
		['a Response', () => new Response('x'), 'a Response'],
		['a 4xx Response', () => new Response('x', { status: 404 }), 'a Response'],
		[
			'a failure carrying a cookie',
			() => ({ ...route_fail(REST_ROW_NOT_FOUND), set_cookie: ['x=1'] }),
			'a failure carrying a cookie'
		],
		[
			'a raw Set-Cookie',
			() => route_raw({ status: 200, headers: { 'set-COOKIE': 'x=1' } }),
			'a raw answer carrying `set-cookie`'
		],
		[
			'a raw body without Content-Type',
			() => route_raw({ status: 200, body: new Uint8Array([1]) }),
			'a raw answer with a body and no `Content-Type`'
		],
		[
			'a foreign stream',
			() => ({ ok: 'sse', stream: { send() {}, close() {}, on_close() {} } }),
			'an SSE stream this request did not open'
		],
		['undefined', () => undefined, 'a malformed result'],
		['null', () => null, 'a malformed result']
	];
	for (const [name, result, kind] of cases) {
		test(`${name} throws the named TypeError`, () => {
			assert.throws(() => prepare(result()), TypeError, `GET /: a route handler returned ${kind}`);
		});
	}

	test('a success is prepared with the JSON `c.json` writes and its lines', () => {
		assert.deepStrictEqual(prepare(route_ok({ n: 1 }, { set_cookie: ['a=1'] })), {
			kind: 'body',
			status: undefined,
			body: '{"n":1}',
			headers: { 'Content-Type': 'application/json' },
			set_cookie: ['a=1']
		});
	});

	// each refusal at the prepare — inside the transaction, before anything is
	// built — not a throw of the emit after the commit, which would answer the
	// same 500 (`route_result.refusal.db.test.ts` holds the commit side)
	for (const [name] of route_raw_refusals()) {
		const init = () => route_raw_refusals().find(([n]) => n === name)![1];
		test(`a raw ${name} is refused at the prepare`, () => {
			assert.throws(
				() => prepare(route_raw(init() as never)),
				TypeError,
				'GET /: a route handler returned'
			);
		});
	}

	for (const [name] of route_raw_admitted()) {
		const init = () => route_raw_admitted().find(([n]) => n === name)![1];
		test(`a raw ${name} is admitted`, () => {
			const prepared = prepare(route_raw(init()));
			assert.strictEqual(prepared.kind, 'body');
		});
	}

	test('a success with a set_cookie line a Headers refuses is refused at the prepare', () => {
		assert.throws(() => prepare(route_ok({}, { set_cookie: ['a=1\nb'] })), TypeError, 'GET /:');
		assert.throws(() => prepare(route_ok({}, { set_cookie: [1 as never] })), TypeError, 'GET /:');
	});

	test('a raw answer with no headers passes none', () => {
		assert.deepStrictEqual(prepare(route_raw({ status: 404 })), {
			kind: 'body',
			status: 404,
			body: null,
			headers: undefined,
			set_cookie: []
		});
	});

	test('a raw answer may declare a Content-Length with no body', () => {
		const prepared = prepare(route_raw({ status: 200, headers: { 'Content-Length': '9' } }));
		assert.deepStrictEqual(prepared, {
			kind: 'body',
			status: 200,
			body: null,
			headers: { 'Content-Length': '9' },
			set_cookie: []
		});
	});
});
