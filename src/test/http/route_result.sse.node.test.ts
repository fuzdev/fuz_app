/**
 * A route that opens an SSE stream, over a real `@hono/node-server` socket:
 * an answer other than the stream — a failure, a throw, a success — carries
 * none of the stream's headers, exactly one framing header, and the
 * connection closes when the request asks; the stream's own answer is framed
 * chunked alone and delivers its connect comment. `GET` and `HEAD` both
 * (a `HEAD` answer carries no body and so no length; the stream's `HEAD`
 * answer leaves out its `Connection: keep-alive`, so the connection ends).
 *
 * In-process (`app.request`) no socket frames a response, so a response
 * carrying both `Transfer-Encoding` and `Content-Length` — the adapter writes
 * a buffered body's length beside a header the context held — shows only
 * here.
 *
 * @module
 */

import { afterAll, assert, beforeAll, describe, test } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, define_route } from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_sse } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { create_sse_stream } from '#lib/realtime/sse.ts';
import { SSE_CONNECTED_COMMENT } from '#lib/realtime/sse_constants.ts';
import { REST_ROW_NOT_FOUND } from '#lib/http/error_schemas.ts';
import { expect_logged_error } from '#lib/testing/logged_errors.ts';

const shape = {
	method: 'GET',
	auth: { account: 'none', actor: 'none' },
	description: 'A route that opens a stream.',
	input: literal(null),
	output: loose_object({}),
	errors: [REST_ROW_NOT_FOUND]
} as const;

/** What a raw socket read of one response holds, and whether the server ended it. */
interface RawResponse {
	head: string;
	body: string;
	/** The server closed the connection within the wait. */
	ended: boolean;
}

/**
 * Send one request with `Connection: close` and read until the server ends
 * the connection or `wait_ms` passes; with `first_chunk`, stop at the first
 * body bytes instead.
 */
const send_raw = (
	port: number,
	method: string,
	path: string,
	options?: { first_chunk?: boolean; wait_ms?: number }
): Promise<RawResponse> =>
	new Promise((resolve) => {
		const socket = connect(port, '127.0.0.1');
		let data = '';
		let settled = false;
		const finish = (ended: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			const split = data.indexOf('\r\n\r\n');
			resolve({
				head: split === -1 ? data : data.slice(0, split),
				body: split === -1 ? '' : data.slice(split + 4),
				ended
			});
		};
		const timer = setTimeout(() => finish(false), options?.wait_ms ?? 1000);
		socket.on('data', (chunk) => {
			data += chunk.toString('latin1');
			if (options?.first_chunk && data.includes(SSE_CONNECTED_COMMENT)) finish(true);
		});
		socket.on('end', () => finish(true));
		socket.on('error', () => finish(true));
		socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
	});

const header_names = (head: string): Array<string> =>
	head
		.split('\r\n')
		.slice(1)
		.map((line) => line.slice(0, line.indexOf(':')).toLowerCase());

const SSE_ONLY = ['cache-control', 'transfer-encoding'];

describe('an opened SSE stream over a real Node socket', () => {
	let server: ServerType;
	let port: number;

	beforeAll(async () => {
		const app = new Hono();
		apply_route_specs(
			app,
			[
				define_route({
					...shape,
					path: '/open_then_fail',
					handler: (route) => {
						route.open_sse({ keep_alive_ms: null });
						return route_fail(REST_ROW_NOT_FOUND);
					}
				}),
				define_route({
					...shape,
					path: '/open_then_throw',
					handler: (route) => {
						route.open_sse({ keep_alive_ms: null });
						throw new Error('after the open');
					}
				}),
				define_route({
					...shape,
					path: '/open_then_ok',
					handler: (route) => {
						route.open_sse({ keep_alive_ms: null });
						return route_ok({});
					}
				}),
				define_route({
					...shape,
					path: '/open_twice',
					handler: (route) => {
						route.open_sse({ keep_alive_ms: null });
						return route_sse(route.open_sse({ keep_alive_ms: null }));
					}
				})
			],
			fuz_auth_guard_resolver,
			new Logger('test', { level: 'off' }),
			create_stub_db(),
			{ open_sse: create_sse_stream }
		);
		const { promise, resolve } = Promise.withResolvers<AddressInfo>();
		server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info));
		({ port } = await promise);
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			(server as { closeAllConnections?: () => void }).closeAllConnections?.();
		});
	});

	for (const method of ['GET', 'HEAD']) {
		for (const [path, status] of [
			['/open_then_fail', 404],
			['/open_then_throw', 500],
			['/open_then_ok', 200]
		] as const) {
			test(`${method} ${path}: no stream header, one framing header, the connection closed`, async () => {
				if (path === '/open_then_throw') {
					expect_logged_error('Unhandled handler error Error: after the open');
				}
				const res = await send_raw(port, method, path);
				assert.ok(res.head.startsWith(`HTTP/1.1 ${status} `), res.head);
				const names = header_names(res.head);
				for (const name of SSE_ONLY) assert.notInclude(names, name, res.head);
				assert.notInclude(res.head.toLowerCase(), 'keep-alive', res.head);
				assert.notInclude(res.head.toLowerCase(), 'text/event-stream', res.head);
				// a `HEAD` answer sends no body, and the adapter no length for it
				assert.strictEqual(
					names.filter((n) => n === 'content-length').length,
					method === 'GET' ? 1 : 0,
					res.head
				);
				assert.ok(res.ended, `the server ended the connection: ${res.head}`);
				if (method === 'GET') assert.ok(res.body.startsWith('{'), res.body);
				else assert.strictEqual(res.body, '');
			});
		}

		test(`${method} /open_twice: the answered stream, framed chunked alone`, async () => {
			const res = await send_raw(port, method, '/open_twice', {
				first_chunk: method === 'GET',
				wait_ms: 300
			});
			assert.ok(res.head.startsWith('HTTP/1.1 200 '), res.head);
			const names = header_names(res.head);
			assert.include(names, 'transfer-encoding', res.head);
			assert.notInclude(names, 'content-length', res.head);
			assert.include(res.head.toLowerCase(), 'content-type: text/event-stream', res.head);
			if (method === 'GET') {
				assert.include(res.body, SSE_CONNECTED_COMMENT);
			} else {
				// the stream was closed at the emit: no body, no keep-alive holding
				// the connection, so the request's `Connection: close` ends it
				assert.strictEqual(res.body, '');
				assert.notInclude(res.head.toLowerCase(), 'keep-alive', res.head);
				assert.ok(res.ended, `the server ended the connection: ${res.head}`);
			}
		});
	}
});
