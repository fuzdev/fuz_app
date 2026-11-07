/**
 * The responses `apply_route_specs` builds from a handler's result: a
 * `route_ok` as JSON at 200, a `route_fail` as its definition's body at its
 * status with the headers it derives (`Retry-After`), a `route_raw` as it is,
 * and the headers and cookies a handler set on the context carried onto each.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { literal, loose_object, number, object, string } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	apply_route_specs,
	define_route,
	to_route_response,
	type RouteSpec
} from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_raw } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
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
		handler: (c) =>
			route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: Number(c.req.param('retry_after')) })
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
		handler: (c) =>
			c.req.param('given') === 'yes'
				? route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP, { bootstrap_available: true })
				: route_fail(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP)
	}),
	define_route({
		...shape,
		path: '/forward/:id',
		params: object({ id: string }),
		errors: [REST_ROW_NOT_FOUND],
		handler: (c) => {
			const failure = find_row(c.req.param('id') ?? '');
			if (failure) return failure;
			return route_ok({ n: 2 });
		}
	}),
	define_route({
		...shape,
		path: '/raw/empty',
		handler: (c) => route_raw(c.body(null, 404))
	}),
	define_route({
		...shape,
		path: '/raw/text',
		handler: (c) => route_raw(c.text('teapot', 418, { 'X-Raw': 'yes' }))
	}),
	define_route({
		...shape,
		path: '/headers/ok',
		handler: (c) => {
			setCookie(c, 'fuz_test', 'abc', { httpOnly: true, path: '/' });
			c.header('Cache-Control', 'no-store');
			return route_ok({ n: 3 });
		}
	}),
	define_route({
		...shape,
		path: '/headers/fail',
		rate_limit: 'ip',
		handler: (c) => {
			setCookie(c, 'fuz_test', '', { path: '/', maxAge: 0 });
			c.header('Connection', 'close');
			return route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 4 });
		}
	}),
	define_route({
		...shape,
		path: '/headers/raw',
		handler: (c) => {
			c.header('Cache-Control', 'no-store');
			return route_raw(c.body(null, 204));
		}
	}),
	define_route({
		...shape,
		path: '/bare_response',
		// a handler typed `any`, or JS, that still returns a `Response`
		handler: (c) => c.json({ n: 4 }) as never
	}),
	// results no factory makes: a success without a value, a failure without
	// its definition, an `ok` of neither kind, a raw result without a response
	...(
		[
			['ok_no_value', { ok: true }],
			['ok_undefined_value', { ok: true, value: undefined }],
			['fail_no_def', { ok: false, status: 404, body: { error: 'x' } }],
			['fail_no_status', { ok: false, body: { error: 'x' }, def: REST_ROW_NOT_FOUND }],
			['ok_other', { ok: 'yes', value: 1 }],
			['raw_no_response', { ok: 'raw' }]
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
		assert.strictEqual(await res.text(), '{"n":1}');
	});

	test('carries a cookie and a header set on the context', async () => {
		const res = await app.request('/headers/ok');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('Set-Cookie'), 'fuz_test=abc; Path=/; HttpOnly');
		assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
		assert.strictEqual(await res.text(), '{"n":3}');
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

	test('carries a cookie and a header set on the context beside its own', async () => {
		const res = await app.request('/headers/fail');
		assert.strictEqual(res.status, 429);
		assert.strictEqual(res.headers.get('Retry-After'), '4');
		assert.strictEqual(res.headers.get('Connection'), 'close');
		assert.strictEqual(res.headers.get('Set-Cookie'), 'fuz_test=; Max-Age=0; Path=/');
	});

	test('the result is plain data', () => {
		const failure = route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 1 });
		assert.strictEqual(failure.ok, false);
		assert.strictEqual(failure.status, 429);
		assert.strictEqual(failure.code, ERROR_RATE_LIMIT_EXCEEDED);
		assert.deepStrictEqual(failure.body, { error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 1 });
		assert.strictEqual(failure.def, REST_RATE_LIMIT_EXCEEDED);
		assert.deepStrictEqual(route_ok({ n: 1 }), { ok: true, value: { n: 1 } });
	});
});

describe('route_raw', () => {
	test('answers an empty body as it is', async () => {
		const res = await app.request('/raw/empty');
		assert.strictEqual(res.status, 404);
		assert.strictEqual(res.headers.get('Content-Type'), null);
		assert.strictEqual(await res.text(), '');
	});

	test('answers any status, with its own headers', async () => {
		const res = await app.request('/raw/text');
		assert.strictEqual(res.status, 418);
		assert.strictEqual(res.headers.get('X-Raw'), 'yes');
		assert.strictEqual(await res.text(), 'teapot');
	});

	test('a response built from the context carries its headers', async () => {
		const res = await app.request('/headers/raw');
		assert.strictEqual(res.status, 204);
		assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
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
		'fail_no_def',
		'fail_no_status',
		'ok_other',
		'raw_no_response'
	]) {
		test(`${name} answers 500 internal_error`, async () => {
			const res = await app.request(`/malformed/${name}`);
			assert.strictEqual(res.status, 500);
			const body = (await res.json()) as { error: string };
			assert.strictEqual(body.error, ERROR_INTERNAL_ERROR);
		});
	}
});

describe('to_route_response', () => {
	// what `to_route_response` throws for a result, caught in the handler
	const thrown_by = async (make_result: (c: Context) => unknown): Promise<unknown> => {
		let thrown: unknown;
		const app = new Hono();
		app.get('/', (c) => {
			try {
				return to_route_response(c, make_result(c) as never);
			} catch (error) {
				thrown = error;
				return c.body(null, 500);
			}
		});
		await app.request('/');
		return thrown;
	};

	const cases: Array<[name: string, make_result: (c: Context) => unknown, kind: string]> = [
		['ok_no_value', () => ({ ok: true }), 'a malformed result'],
		['ok_undefined_value', () => ({ ok: true, value: undefined }), 'a malformed result'],
		['fail_no_def', () => ({ ok: false, status: 404, body: { error: 'x' } }), 'a malformed result'],
		[
			'fail_no_status',
			() => ({ ok: false, body: { error: 'x' }, def: REST_ROW_NOT_FOUND }),
			'a malformed result'
		],
		['ok_other', () => ({ ok: 'yes', value: 1 }), 'a malformed result'],
		// no JSON value: `JSON.stringify` writes nothing for these
		['ok_function_value', () => ({ ok: true, value: () => 1 }), 'a malformed result'],
		[
			'ok_function_with_fields',
			() => ({ ok: true, value: Object.assign(() => 1, { a: 1 }) }),
			'a malformed result'
		],
		['ok_symbol_value', () => ({ ok: true, value: Symbol('x') }), 'a malformed result'],
		['raw_no_response', () => ({ ok: 'raw' }), 'a malformed result'],
		['a 200 Response', (c) => c.json({ n: 1 }), 'a Response'],
		['a 4xx Response', (c) => c.json({ error: 'x' }, 404), 'a Response'],
		['undefined', () => undefined, 'a malformed result'],
		['null', () => null, 'a malformed result']
	];
	for (const [name, make_result, kind] of cases) {
		test(`${name} throws the named TypeError`, async () => {
			const error = await thrown_by(make_result);
			assert(error instanceof TypeError, `${name} threw ${String(error)}`);
			assert.include(error.message, `GET /: a route handler returned ${kind} — return`);
		});
	}
});
