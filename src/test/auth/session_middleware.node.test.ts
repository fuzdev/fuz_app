/**
 * The session middleware's cookie clear over a real Node server: a stale
 * cookie changes nothing of what `@hono/node-server` sends but the
 * `Set-Cookie` line of a response the context built.
 *
 * In-process, `app.request` hands back the `Response` object itself. Here the
 * adapter writes it to a socket — its own lightweight `Response`, which sends
 * what a plain one refuses to build (a bodiless status given an empty body)
 * and frames a body it never had to read with `Content-Length` — so these
 * are the cases a middleware that read or rebuilt the response would change.
 *
 * @module
 */

import { afterEach, assert, describe, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { serve, upgradeWebSocket, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';

import { create_session_middleware } from '#lib/auth/session_middleware.ts';
import {
	raw_http_exchange,
	raw_http_header_values,
	raw_http_parse_response,
	raw_http_request,
	RAW_HTTP_READ_TIMEOUT_MS
} from '#lib/testing/transports/raw_http.ts';
import { connect_raw_ws, type RawWsClient } from '#lib/testing/transports/ws_raw_client.ts';

import { create_test_keyring } from './session_test_helpers.ts';

const session_cookie_name = 'test_session';
const CLEAR = 'test_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
const STALE = 'test_session=stale.invalidsignature';

interface TestServer {
	port: number;
	/** Let the `/api/stream` handler write its second chunk. */
	release_stream: () => void;
	close: () => Promise<void>;
}

const start_server = async (): Promise<TestServer> => {
	const app = new Hono();
	app.use('/api/*', create_session_middleware(create_test_keyring(), session_cookie_name));
	// built by the context
	app.get('/api/json_401', (c) => c.json({ error: 'authentication_required' }, 401));
	app.get('/api/text', (c) => c.text('text'));
	app.get('/api/no_content', (c) => c.body(null, 204));
	app.get('/api/not_modified', (c) => c.body(null, 304));
	// Hono's types refuse a body on 204; the adapter's `Response` sends it
	app.get('/api/empty_204', (c) => c.body('' as unknown as null, 204));
	// a body in two chunks, the second held until the test has read the first
	let release_stream = (): void => {};
	const stream_released = new Promise<void>((resolve) => {
		release_stream = resolve;
	});
	app.get('/api/stream', (c) =>
		stream(c, async (s) => {
			await s.write('first\n');
			await stream_released;
			await s.write('second\n');
		})
	);
	// built by the handler
	const NO_CONTENT = new Response(null, { status: 204 });
	app.get('/api/shared', () => NO_CONTENT);
	// one string-bodied object for every request, made on first use: made
	// inside the running server it is the adapter's `Response`, which sends its
	// body every time (the runtime's own sends a body once)
	let shared_body: Response | undefined;
	app.get(
		'/api/shared_body',
		() => (shared_body ??= new Response('shared', { headers: { 'X-Shared': '1' } }))
	);
	app.get('/api/raw', () => new Response('raw'));
	app.get('/api/raw_empty_204', () => new Response('', { status: 204 }));
	app.get('/api/redirect', () => Response.redirect('http://localhost/elsewhere', 302));
	// an upgrade route calling the adapter's helper itself
	app.get(
		'/api/ws',
		upgradeWebSocket(() => ({}))
	);
	const server: ServerType = await new Promise((resolve) => {
		const s = serve(
			{
				fetch: app.fetch,
				port: 0,
				hostname: '127.0.0.1',
				websocket: { server: new WebSocketServer({ noServer: true }) }
			},
			() => resolve(s)
		);
	});
	return {
		port: (server.address() as AddressInfo).port,
		release_stream,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
};

describe('the clear of an invalid session cookie, over a Node server', () => {
	const clients: Array<RawWsClient> = [];
	let server: TestServer | null = null;
	let upstream: Server | null = null;

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy();
		server?.release_stream();
		await server?.close();
		server = null;
		const closing = upstream;
		upstream = null;
		if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
	});

	/** One raw exchange: the bytes the server answered a request with. */
	const send = async (
		method: string,
		path: string,
		lines: ReadonlyArray<string> = []
	): Promise<string> => {
		const host = `127.0.0.1:${server!.port}`;
		const { received } = await raw_http_exchange(
			`http://${host}`,
			raw_http_request({ method, path, host, header_lines: [...lines, 'Connection: close'] }),
			{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
		);
		return received;
	};

	/**
	 * A response as a client reads it, less what may differ between two
	 * requests: the status line, the headers by lowercase name in name order,
	 * and the body — without `Set-Cookie` and `Date`, and with one spelling of
	 * a `Content-Type` parameter (Hono writes `c.text`'s type itself once the
	 * context carries a header, where the runtime derives it otherwise). The
	 * adapter writes header names in another case and order once the context
	 * carries a header, which no client reads.
	 */
	const comparable = (
		received: string
	): { status: string; headers: Array<string>; body: string } => {
		const head_end = received.indexOf('\r\n\r\n');
		const [status = '', ...lines] = received.slice(0, head_end).split('\r\n');
		return {
			status,
			headers: lines
				.map((line) => {
					const colon = line.indexOf(':');
					const name = line.slice(0, colon).toLowerCase();
					const value = line.slice(colon + 1).trim();
					return `${name}: ${name === 'content-type' ? value.replace(/;\s*/g, ';') : value}`;
				})
				.filter((line) => !/^(set-cookie|date):/.test(line))
				.sort(),
			body: received.slice(head_end + 4)
		};
	};

	test('a stale cookie changes nothing of a response but its Set-Cookie line', async () => {
		server = await start_server();
		const cases: ReadonlyArray<
			readonly [method: string, path: string, status: number, cleared: boolean]
		> = [
			// built by the context: the clear, and nothing else
			['GET', '/api/json_401', 401, true],
			['GET', '/api/text', 200, true],
			['GET', '/api/no_content', 204, true],
			['GET', '/api/not_modified', 304, true],
			['GET', '/api/empty_204', 204, true],
			['HEAD', '/api/text', 200, true],
			['GET', '/api/unrouted', 404, true],
			// built by the handler: nothing at all
			['GET', '/api/raw', 200, false],
			['GET', '/api/raw_empty_204', 204, false],
			['GET', '/api/redirect', 302, false]
		];
		for (const [method, path, status, cleared] of cases) {
			const label = `${method} ${path}`;
			const plain = await send(method, path);
			const stale = await send(method, path, [`Cookie: ${STALE}`]);
			assert.strictEqual(raw_http_parse_response(plain)?.status, status, label);
			assert.strictEqual(raw_http_parse_response(stale)?.status, status, label);
			assert.deepStrictEqual(raw_http_header_values(plain, 'set-cookie'), [], label);
			assert.deepStrictEqual(
				raw_http_header_values(stale, 'set-cookie'),
				cleared ? [CLEAR] : [],
				label
			);
			assert.deepStrictEqual(comparable(stale), comparable(plain), label);
		}
	});

	test('a response the context built keeps its Content-Length', async () => {
		server = await start_server();
		const stale = await send('GET', '/api/json_401', [`Cookie: ${STALE}`]);
		assert.deepStrictEqual(raw_http_header_values(stale, 'set-cookie'), [CLEAR]);
		assert.deepStrictEqual(raw_http_header_values(stale, 'content-length'), [
			String(JSON.stringify({ error: 'authentication_required' }).length)
		]);
		assert.deepStrictEqual(raw_http_header_values(stale, 'transfer-encoding'), []);
	});

	test('a response object returned to every request is never cleared', async () => {
		server = await start_server();
		const stale: Record<string, string> = { cookie: STALE };
		const got: Array<[number, Array<string>]> = [];
		for (const headers of [{}, stale, {}, stale, {}]) {
			const res = await fetch(`http://127.0.0.1:${server.port}/api/shared`, { headers });
			got.push([res.status, res.headers.getSetCookie()]);
		}
		assert.deepStrictEqual(
			got,
			[0, 1, 2, 3, 4].map(() => [204, []])
		);
	});

	test('a string-bodied response object returned to every request keeps answering', async () => {
		server = await start_server();
		// a middleware that rebuilt the object for a stale request would take its
		// body, and the next request without a stale cookie would fail
		for (const stale of [false, true, false, true, true, false]) {
			const received = await send('GET', '/api/shared_body', stale ? [`Cookie: ${STALE}`] : []);
			const response = raw_http_parse_response(received);
			const label = stale ? 'stale' : 'no cookie';
			assert.ok(response, label);
			assert.strictEqual(response.status, 200, label);
			assert.strictEqual(response.body, 'shared', label);
			assert.strictEqual(response.headers['x-shared'], '1', label);
			assert.deepStrictEqual(raw_http_header_values(received, 'set-cookie'), [], label);
			assert.deepStrictEqual(raw_http_header_values(received, 'content-length'), ['6'], label);
		}
	});

	test('a streamed response the context built carries the clear and is not buffered', async () => {
		server = await start_server();
		const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
			headers: { cookie: STALE }
		});
		assert.deepStrictEqual(res.headers.getSetCookie(), [CLEAR]);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		// the handler writes its second chunk only once released, so reading the
		// first proves the body is sent as it is written
		const first = await reader.read();
		assert.strictEqual(decoder.decode(first.value), 'first\n');
		server.release_stream();
		let rest = '';
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			rest += decoder.decode(next.value);
		}
		assert.strictEqual(rest, 'second\n');
	});

	test('a fetched response passed through keeps its own Set-Cookie lines, and gets no clear', async () => {
		const upstream_server = createServer((_req, res) => {
			res.setHeader('Set-Cookie', ['upstream_a=1', 'upstream_b=2']);
			res.setHeader('X-Upstream', '1');
			res.statusCode = 203;
			res.end('from upstream');
		});
		upstream = upstream_server;
		await new Promise<void>((resolve) => upstream_server.listen(0, '127.0.0.1', resolve));
		const { port } = upstream_server.address() as AddressInfo;

		const app = new Hono();
		app.use('/*', create_session_middleware(create_test_keyring(), session_cookie_name));
		app.get('/proxied', () => fetch(`http://127.0.0.1:${port}/`));

		const res = await app.request('/proxied', { headers: { Cookie: STALE } });
		assert.strictEqual(res.status, 203);
		assert.deepStrictEqual(res.headers.getSetCookie(), ['upstream_a=1', 'upstream_b=2']);
		assert.strictEqual(res.headers.get('x-upstream'), '1');
		assert.strictEqual(await res.text(), 'from upstream');
	});

	test('an accepted upgrade carries no clear; a refused one does', async () => {
		server = await start_server();
		// the adapter's placeholder for an upgrade it took is a response the
		// handler built, so the 101 it is copied onto has no clear
		const client = await connect_raw_ws({
			port: server.port,
			path: '/api/ws',
			header_lines: [`Cookie: ${STALE}`]
		});
		clients.push(client);
		assert.deepStrictEqual(raw_http_header_values(client.handshake, 'set-cookie'), []);
		// an upgrade request no route takes is answered by the context
		const host = `127.0.0.1:${server.port}`;
		const { received } = await raw_http_exchange(
			`http://${host}`,
			raw_http_request({
				method: 'GET',
				path: '/api/unrouted',
				host,
				header_lines: [
					'Connection: Upgrade',
					'Upgrade: websocket',
					'Sec-WebSocket-Version: 13',
					'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
					`Cookie: ${STALE}`
				]
			}),
			{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS, until: 'response' }
		);
		assert.strictEqual(raw_http_parse_response(received)?.status, 404);
		assert.deepStrictEqual(raw_http_header_values(received, 'set-cookie'), [CLEAR]);
	});
});
