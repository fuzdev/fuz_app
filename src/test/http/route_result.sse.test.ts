/**
 * The SSE result: a route opens its stream through `RouteContext.open_sse`
 * and answers `route_sse(stream)`, and `apply_route_specs` answers with that
 * stream's response — refusing a stream another request opened, closing one
 * the route opened and did not answer with, and refusing to open one without
 * an `open_sse`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_sse } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { create_sse_stream, type SseStream } from '#lib/realtime/sse.ts';
import { SSE_CONNECTED_COMMENT } from '#lib/realtime/sse_constants.ts';
import { ERROR_INTERNAL_ERROR, REST_ROW_NOT_FOUND } from '#lib/http/error_schemas.ts';

const shape = {
	method: 'GET',
	auth: { account: 'none', actor: 'none' },
	description: 'A route.',
	input: literal(null),
	output: loose_object({})
} as const;

const create_app = (specs: Array<RouteSpec>, with_opener = true): Hono => {
	const app = new Hono();
	apply_route_specs(
		app,
		specs,
		fuz_auth_guard_resolver,
		new Logger('test', { level: 'off' }),
		create_stub_db(),
		with_opener ? { open_sse: create_sse_stream } : undefined
	);
	return app;
};

/** The first chunk of a streamed body, then the body cancelled. */
const read_first_chunk = async (res: Response): Promise<string> => {
	const reader = res.body!.getReader();
	const { value } = await reader.read();
	await reader.cancel();
	return new TextDecoder().decode(value);
};

describe('route_sse', () => {
	test('answers the stream the route opened', async () => {
		let opened: SseStream<{ n: number }> | null = null;
		const app = create_app([
			define_route({
				...shape,
				path: '/sse',
				handler: (route) => {
					opened = route.open_sse<{ n: number }>({ keep_alive_ms: null });
					return route_sse(opened);
				}
			})
		]);
		const res = await app.request('/sse');
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(
			[...res.headers].filter(([name]) => name !== 'set-cookie'),
			[
				['cache-control', 'no-cache'],
				['connection', 'keep-alive'],
				['content-type', 'text/event-stream'],
				['transfer-encoding', 'chunked']
			]
		);
		assert.ok(opened, 'the route opened a stream');
		assert.strictEqual(await read_first_chunk(res), SSE_CONNECTED_COMMENT);
	});

	test('a stream another request opened is refused', async () => {
		let earlier: SseStream | null = null;
		const app = create_app([
			define_route({
				...shape,
				path: '/sse',
				handler: (route) => {
					const stream = route.open_sse({ keep_alive_ms: null });
					// the second request answers with the first one's stream
					const answer = earlier ?? stream;
					earlier ??= stream;
					return route_sse(answer);
				}
			})
		]);
		const first = await app.request('/sse');
		assert.strictEqual(first.status, 200);
		await first.body!.cancel();
		const second = await app.request('/sse');
		assert.strictEqual(second.status, 500);
		const body = (await second.json()) as { error: string; message?: string };
		assert.strictEqual(body.error, ERROR_INTERNAL_ERROR);
		// refused at the prepare, not a build of the other request's body that fails
		assert.include(body.message, 'an SSE stream this request did not open');
	});

	test('a stream the route opened and did not answer with is closed', async () => {
		let closed = false;
		const app = create_app([
			define_route({
				...shape,
				path: '/sse',
				handler: (route) => {
					const stream = route.open_sse({ keep_alive_ms: null });
					stream.on_close(() => {
						closed = true;
					});
					return route_ok({});
				}
			})
		]);
		const res = await app.request('/sse');
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual([...res.headers], [['content-type', 'application/json']]);
		assert.strictEqual(await res.text(), '{}');
		assert.ok(closed, 'the unanswered stream was closed');
	});

	// the opener writes nothing on the context, so no answer but the stream's
	// own carries `Transfer-Encoding`, `Connection`, `Cache-Control`
	test("leaves none of the opener's headers on the answer", async () => {
		const app = create_app([
			define_route({
				...shape,
				path: '/refused',
				errors: [REST_ROW_NOT_FOUND],
				handler: (route) => {
					route.open_sse({ keep_alive_ms: null });
					return route_fail(REST_ROW_NOT_FOUND);
				}
			}),
			define_route({
				...shape,
				path: '/thrown',
				handler: (route) => {
					route.open_sse({ keep_alive_ms: null });
					throw new Error('after the open');
				}
			})
		]);
		for (const [path, status] of [
			['/refused', 404],
			['/thrown', 500]
		] as const) {
			const res = await app.request(path);
			assert.strictEqual(res.status, status, path);
			assert.deepStrictEqual([...res.headers], [['content-type', 'application/json']], path);
		}
	});

	test('a stream opened twice answers the one returned, the other closed', async () => {
		const closed: Array<string> = [];
		const app = create_app([
			define_route({
				...shape,
				path: '/sse',
				handler: (route) => {
					const first = route.open_sse({ keep_alive_ms: null });
					const second = route.open_sse({ keep_alive_ms: null });
					first.on_close(() => closed.push('first'));
					second.on_close(() => closed.push('second'));
					return route_sse(second);
				}
			})
		]);
		const res = await app.request('/sse');
		assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');
		assert.deepStrictEqual(closed, ['first']);
		assert.strictEqual(await read_first_chunk(res), SSE_CONNECTED_COMMENT);
	});

	test('a stream opened by a handler that then throws is closed', async () => {
		let closed = false;
		const app = create_app([
			define_route({
				...shape,
				path: '/sse',
				handler: (route) => {
					const stream = route.open_sse({ keep_alive_ms: null });
					stream.on_close(() => {
						closed = true;
					});
					throw new Error('after the open');
				}
			})
		]);
		const res = await app.request('/sse');
		assert.strictEqual(res.status, 500);
		assert.ok(closed, 'the stream was closed');
	});

	test('opening a stream with no `open_sse` given throws', async () => {
		const app = create_app(
			[
				define_route({
					...shape,
					path: '/sse',
					handler: (route) => route_sse(route.open_sse())
				})
			],
			false
		);
		const res = await app.request('/sse');
		assert.strictEqual(res.status, 500);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, ERROR_INTERNAL_ERROR);
	});
});
