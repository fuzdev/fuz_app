/**
 * The strict request-target readers beyond the shared table: the helpers
 * around them (`split_request_url`, `query_first`, `to_query_record`), and
 * what the route pipeline answers through them — a param or query escape
 * that doesn't decode refused whatever the schema, and a decodable one read
 * once.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { literal, nullable, number, object, optional, string } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	query_first,
	read_query_pairs,
	split_request_url,
	to_query_record
} from '#lib/http/request_target.ts';
import { apply_route_specs, define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

const log = new Logger('test', { level: 'off' });
const db = create_stub_db();

describe('split_request_url', () => {
	test('splits the path and the query as sent', () => {
		assert.deepStrictEqual(split_request_url('http://h:1/a/%FF?x=%G0&y'), {
			path: '/a/%FF',
			query: 'x=%G0&y'
		});
		assert.deepStrictEqual(split_request_url('http://h/a'), { path: '/a', query: null });
		assert.deepStrictEqual(split_request_url('http://h/a?'), { path: '/a', query: '' });
		assert.deepStrictEqual(split_request_url('http://h/a?b?c'), { path: '/a', query: 'b?c' });
		assert.deepStrictEqual(split_request_url('http://h/a?q#f'), { path: '/a', query: 'q' });
		assert.deepStrictEqual(split_request_url('http://h'), { path: '/', query: null });
	});
});

describe('query_first and to_query_record', () => {
	test('the first occurrence wins, and a nameless pair is no key', () => {
		const read = read_query_pairs('=x&a=1&a=2&b');
		assert.ok(read.ok);
		assert.strictEqual(query_first(read.value, 'a'), '1');
		assert.strictEqual(query_first(read.value, 'b'), '');
		assert.strictEqual(query_first(read.value, 'c'), undefined);
		const record = to_query_record(read.value);
		assert.deepStrictEqual({ ...record }, { a: '1', b: '' });
		assert.strictEqual(Object.getPrototypeOf(record), null);
	});

	test('a key named for an object member is an own key of the record', () => {
		const read = read_query_pairs('__proto__=x&constructor=y');
		assert.ok(read.ok);
		const record = to_query_record(read.value);
		assert.deepStrictEqual(Object.keys(record), ['__proto__', 'constructor']);
	});
});

const create_app = (): Hono => {
	const app = new Hono();
	const specs: Array<RouteSpec> = [
		define_route({
			method: 'GET',
			path: '/rows/:id',
			auth: { account: 'none', actor: 'none' },
			handler: (route) => route_ok({ id: route.params.id, q: route.query.q ?? null }),
			description: 'a free-text param and a free-text query value',
			params: object({ id: string }),
			query: object({ q: optional(string) }),
			input: literal(null),
			output: object({ id: string, q: nullable(string) })
		}),
		define_route({
			method: 'GET',
			path: '/free',
			auth: { account: 'none', actor: 'none' },
			handler: (route) =>
				route_ok({ pairs: route.query_pairs.ok ? route.query_pairs.value.length : -1 }),
			description: 'no query schema: the handler reads the pairs itself',
			input: literal(null),
			output: object({ pairs: number })
		})
	];
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return app;
};

describe('the route pipeline reads the target strictly', () => {
	test('a free-text param with an undecodable escape is refused', async () => {
		const app = create_app();
		for (const path of ['/rows/%FF', '/rows/%C3%A9%FF', '/rows/%G0', '/rows/%']) {
			const res = await app.request(path);
			assert.strictEqual(res.status, 400, path);
			assert.deepStrictEqual(await res.json(), { error: 'invalid_route_params' }, path);
		}
	});

	test('a decodable param is decoded once', async () => {
		const app = create_app();
		const cases: Array<[string, string]> = [
			['/rows/%25FF', '%FF'],
			['/rows/%C3%A9', 'é'],
			['/rows/a%2Fb', 'a/b'],
			['/rows/a+b', 'a+b'],
			['/rows/%2525', '%25']
		];
		for (const [path, id] of cases) {
			const res = await app.request(path);
			assert.strictEqual(res.status, 200, path);
			assert.deepStrictEqual(await res.json(), { id, q: null }, path);
		}
	});

	test('a query with an undecodable escape is refused, in any key, before the schema', async () => {
		const app = create_app();
		for (const query of ['q=%FF', 'q=%G0', '%FF=1', 'q=ok&q=%C3']) {
			const res = await app.request(`/rows/x?${query}`);
			assert.strictEqual(res.status, 400, query);
			assert.deepStrictEqual(await res.json(), { error: 'invalid_query_params' }, query);
		}
	});

	test('a key named for an object member is an undeclared key the schema refuses', async () => {
		const app = create_app();
		for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			const res = await app.request(`/rows/x?${key}=1`);
			assert.strictEqual(res.status, 400, key);
			assert.strictEqual(((await res.json()) as { error: string }).error, 'invalid_query_params');
		}
	});

	test('the param refusal precedes the query refusal', async () => {
		const res = await create_app().request('/rows/%FF?q=%FF');
		assert.deepStrictEqual(await res.json(), { error: 'invalid_route_params' });
	});

	test('a decodable query value is decoded once, `+` a space', async () => {
		const res = await create_app().request('/rows/x?q=%25FF+%2B');
		assert.deepStrictEqual(await res.json(), { id: 'x', q: '%FF +' });
	});

	test('a route without a query schema reads the refusal off `query_pairs`', async () => {
		const app = create_app();
		assert.deepStrictEqual(await (await app.request('/free?a=1&b')).json(), { pairs: 2 });
		assert.deepStrictEqual(await (await app.request('/free?a=%FF')).json(), { pairs: -1 });
	});
});
