/**
 * `RouteSpec.response_headers`: checked at registration, written on the
 * context by the route's first stage, so every answer the route gives carries
 * them — its own refusals, every result kind, the error catch's 500 and 503 —
 * a result that names one of them refused, and the record listed on the
 * surface.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { literal, loose_object, object, string } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_raw, route_sse } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { create_sse_stream } from '#lib/realtime/sse.ts';
import { generate_app_surface } from '#lib/http/surface.ts';
import { DbCheckoutError } from '#lib/db/db_checkout_error.ts';
import { REST_RATE_LIMIT_EXCEEDED, REST_ROW_NOT_FOUND } from '#lib/http/error_schemas.ts';
import { expect_logged_error } from '#lib/testing/logged_errors.ts';

const DECLARED = { 'Cache-Control': 'no-store', 'X-Route': 'declared' } as const;

const shape = {
	method: 'GET',
	auth: { account: 'none', actor: 'none' },
	description: 'x',
	input: literal(null),
	output: loose_object({}),
	response_headers: DECLARED
} as const;

const create_app = (specs: Array<RouteSpec>): Hono => {
	const app = new Hono();
	apply_route_specs(
		app,
		specs,
		fuz_auth_guard_resolver,
		new Logger('test', { level: 'off' }),
		create_stub_db(),
		{ open_sse: create_sse_stream }
	);
	return app;
};

const app = create_app([
	define_route({ ...shape, path: '/ok', handler: () => route_ok({}) }),
	define_route({
		...shape,
		path: '/fail',
		errors: [REST_ROW_NOT_FOUND],
		handler: () => route_fail(REST_ROW_NOT_FOUND)
	}),
	define_route({ ...shape, path: '/raw', handler: () => route_raw({ status: 204 }) }),
	define_route({
		...shape,
		path: '/sse',
		response_headers: { 'X-Route': 'declared' },
		handler: (route) => {
			const stream = route.open_sse({ keep_alive_ms: null });
			stream.close();
			return route_sse(stream);
		}
	}),
	define_route({
		...shape,
		path: '/throw',
		handler: () => {
			throw new Error('the handler failed');
		}
	}),
	define_route({
		...shape,
		path: '/unavailable',
		handler: () => {
			throw new DbCheckoutError({ cause: new Error('pool exhausted') });
		}
	}),
	define_route({
		...shape,
		path: '/params/:id',
		params: object({ id: string }),
		handler: () => route_ok({})
	}),
	define_route({
		...shape,
		path: '/gated',
		auth: { account: 'required', actor: 'none' },
		handler: () => route_ok({})
	}),
	define_route({
		...shape,
		method: 'POST',
		path: '/post',
		input: object({ name: string }),
		handler: () => route_ok({})
	}),
	// a result naming a declared header
	define_route({
		...shape,
		path: '/raw_conflict',
		handler: () => route_raw({ status: 200, headers: { 'cache-control': 'max-age=60' } })
	}),
	define_route({
		...shape,
		path: '/fail_conflict',
		rate_limit: 'ip',
		response_headers: { 'Retry-After': '9' },
		handler: () => route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: 1 })
	}),
	define_route({
		...shape,
		path: '/sse_conflict',
		handler: (route) => route_sse(route.open_sse({ keep_alive_ms: null }))
	})
]);

const assert_declared = (res: Response, label: string): void => {
	assert.strictEqual(res.headers.get('cache-control'), 'no-store', label);
	assert.strictEqual(res.headers.get('x-route'), 'declared', label);
};

describe('RouteSpec.response_headers', () => {
	for (const [path, status] of [
		['/ok', 200],
		['/fail', 404],
		['/raw', 204],
		['/throw', 500],
		['/unavailable', 503],
		['/params/x', 200],
		// the 401 of the route's own gate
		['/gated', 401]
	] as const) {
		test(`${path}: ${status} carries them`, async () => {
			if (path === '/throw')
				expect_logged_error('Unhandled handler error Error: the handler failed');
			if (path === '/unavailable') expect_logged_error('pool checkout failed: DbCheckoutError');
			const res = await app.request(path);
			assert.strictEqual(res.status, status, path);
			assert_declared(res, path);
		});
	}

	test("an SSE answer carries them beside the stream's", async () => {
		const res = await app.request('/sse');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('x-route'), 'declared');
		assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
	});

	test("the route's 415 and 400 carry them", async () => {
		const unsupported = await app.request('/post', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: 'x'
		});
		assert.strictEqual(unsupported.status, 415);
		assert_declared(unsupported, '415');
		const invalid = await app.request('/post', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{"name":1}'
		});
		assert.strictEqual(invalid.status, 400);
		assert_declared(invalid, '400');
	});

	for (const path of ['/raw_conflict', '/fail_conflict', '/sse_conflict']) {
		test(`${path}: a result naming a declared header is refused`, async () => {
			expect_logged_error(
				`Unhandled handler error TypeError: GET ${path}: a route handler returned`
			);
			const res = await app.request(path);
			assert.strictEqual(res.status, 500);
			assert.notStrictEqual(res.headers.get('cache-control'), 'max-age=60');
		});
	}

	test('another route carries none', async () => {
		const plain = create_app([
			define_route({
				method: 'GET',
				path: '/plain',
				auth: { account: 'none', actor: 'none' },
				description: 'x',
				input: literal(null),
				output: loose_object({}),
				handler: () => route_ok({})
			})
		]);
		const res = await plain.request('/plain');
		assert.isNull(res.headers.get('x-route'));
	});

	for (const [name, record] of [
		['set-cookie', { 'Set-Cookie': 'a=1' }],
		['connection', { Connection: 'close' }],
		['transfer-encoding', { 'Transfer-Encoding': 'chunked' }],
		['content-type', { 'Content-Type': 'text/plain' }],
		['content-length', { 'content-length': '0' }],
		['an empty value', { 'X-A': '' }],
		['a value a `Headers` refuses', { 'X-A': 'a\nb' }],
		['a name twice', { 'X-A': '1', 'x-a': '2' }],
		['a list', { 'X-A': ['1', '2'] }],
		['no record', 'no-store']
	] as const) {
		test(`registration refuses ${name}, naming the route`, () => {
			assert.throws(
				() =>
					create_app([
						{
							...define_route({ ...shape, path: '/bad', handler: () => route_ok({}) }),
							response_headers: record as never
						}
					]),
				/Route "GET \/bad": response_headers/
			);
		});
	}

	test('the surface lists them, and leaves the field off a route declaring none', () => {
		const surface = generate_app_surface({
			route_specs: [
				define_route({ ...shape, path: '/declared', handler: () => route_ok({}) }),
				define_route({
					method: 'GET',
					path: '/none',
					auth: { account: 'none', actor: 'none' },
					description: 'x',
					input: literal(null),
					output: loose_object({}),
					handler: () => route_ok({})
				})
			],
			middleware_specs: []
		});
		const [declared, none] = surface.routes;
		assert.deepStrictEqual(declared!.response_headers, DECLARED);
		assert.ok(!('response_headers' in none!));
	});
});
