/**
 * Tests for `server/unmatched_route.ts`: what a request no route answers gets,
 * over a Hono app routing on the raw path as the assembled server does.
 *
 * The live answers on both spines are the `routing:` rows of the request
 * target table's wire leg (`request_target_conformance_wire`).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { Hono } from 'hono';

import { get_request_path } from '#lib/http/request_target.ts';
import { create_unmatched_route_handler } from '#lib/server/unmatched_route.ts';
import { NOT_FOUND_TEXT } from '#lib/http/error_schemas.ts';

const ROUTES = [
	{ method: 'GET', path: '/api/rpc' },
	{ method: 'POST', path: '/api/rpc' },
	{ method: 'POST', path: '/api/account/login' },
	{ method: 'GET', path: '/api/things/:id' },
	{ method: 'DELETE', path: '/api/things/:id' },
	{ method: 'GET', path: '/health' }
] as const;

/** An app mounting `ROUTES`, a `GET /api/ws` that passes every request on, and a middleware. */
const create_app = (): Hono => {
	const app = new Hono({ getPath: get_request_path });
	for (const route of ROUTES) app.on(route.method, route.path, (c) => c.text('hit'));
	app.get('/api/ws', (_c, next) => next());
	// middleware the handler must not count as a route
	app.use('/api/*', (_c, next) => next());
	app.notFound(create_unmatched_route_handler(app.router));
	return app;
};

const read_allow = (res: Response): Array<string> =>
	(res.headers.get('allow') ?? '')
		.split(',')
		.map((m) => m.trim())
		.filter(Boolean)
		.sort();

describe('a method its path does not serve', () => {
	test.each([
		['PUT', '/api/rpc', ['GET', 'HEAD', 'POST']],
		['OPTIONS', '/api/rpc', ['GET', 'HEAD', 'POST']],
		['GET', '/api/account/login', ['POST']],
		['HEAD', '/api/account/login', ['POST']],
		['PATCH', '/api/things/abc', ['DELETE', 'GET', 'HEAD']],
		['POST', '/api/ws', ['GET', 'HEAD']],
		['DELETE', '/health', ['GET', 'HEAD']]
	] as const)('%s %s is the JSON 405 with Allow', async (method, path, allow) => {
		const res = await create_app().request(path, { method });
		assert.strictEqual(res.status, 405);
		assert.deepStrictEqual(read_allow(res), [...allow].sort());
		if (method === 'HEAD') {
			assert.strictEqual(await res.text(), '');
		} else {
			assert.deepStrictEqual(await res.json(), { error: 'method_not_allowed' });
		}
	});

	test('a served method and HEAD beside GET reach their route', async () => {
		const app = create_app();
		assert.strictEqual((await app.request('/api/rpc', { method: 'POST' })).status, 200);
		assert.strictEqual((await app.request('/health', { method: 'HEAD' })).status, 200);
	});
});

describe('a path no route serves', () => {
	test.each(['/api', '/api/', '/api/nope', '/api/things', '/api//rpc', '/api/%72pc'])(
		'%s under the auth scope is the JSON route_not_found',
		async (path) => {
			for (const method of ['GET', 'PUT'] as const) {
				const res = await create_app().request(path, { method });
				assert.strictEqual(res.status, 404, `${method} ${path}`);
				assert.strictEqual(res.headers.get('allow'), null);
				assert.deepStrictEqual(await res.json(), { error: 'route_not_found' });
			}
		}
	);

	test.each(['/nope', '/apix', '/API/rpc', '/%61pi/rpc', '//api/rpc', '/api%2Frpc'])(
		'%s outside the auth scope, read raw, is the plain-text 404',
		async (path) => {
			const res = await create_app().request(path, { method: 'PUT' });
			assert.strictEqual(res.status, 404);
			assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8');
			assert.strictEqual(await res.text(), NOT_FOUND_TEXT);
		}
	);

	test('a GET its route passed on is the 404, not a 405', async () => {
		const res = await create_app().request('/api/ws');
		assert.strictEqual(res.status, 404);
		assert.deepStrictEqual(await res.json(), { error: 'route_not_found' });
		const head = await create_app().request('/api/ws', { method: 'HEAD' });
		assert.strictEqual(head.status, 404);
		assert.strictEqual(await head.text(), '');
	});
});
