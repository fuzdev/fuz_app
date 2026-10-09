/**
 * `create_sse_response` over a real Node HTTP server (`@hono/node-server`),
 * against clients that disconnect.
 *
 * A handler that awaits before it builds its stream — the audit-log route
 * re-reads the credential first — can lose its client in the meantime. The
 * adapter then never reads the response body: it finds the connection already
 * destroyed and returns without cancelling the stream, so a stream that only
 * closed on cancellation would stay registered for good. The cases register
 * each stream in a `SubscriberRegistry`, as the audit route does, and assert
 * the registry empties whichever side of the response the client leaves on.
 * The control case keeps its client and asserts the stream stays registered.
 * The early-leave case also runs over cleartext HTTP/2, where the adapter's
 * response object is no stream and the connection's state lives on its
 * `Http2Stream`. The streaming cases run over HTTP/1 only: Hono's `streamSSE`
 * sets `Transfer-Encoding: chunked`, which HTTP/2 forbids, so the adapter's
 * `writeHead` throws and no response starts there.
 *
 * @module
 */

import { afterEach, assert, describe, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request as http_request } from 'node:http';
import { connect as http2_connect, constants as http2_constants, createServer } from 'node:http2';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_sse_response } from '$lib/realtime/sse.ts';
import { SubscriberRegistry } from '$lib/realtime/subscriber_registry.ts';

const log = new Logger('test', { level: 'off' });

/** Long enough for a disconnect to cross loopback and the server to see it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

/** Poll until `predicate` holds, failing after `timeout_ms`. */
const wait_until = async (predicate: () => boolean, timeout_ms = 2000): Promise<void> => {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeout_ms) throw new Error('condition not met in time');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

interface TestServer {
	port: number;
	registry: SubscriberRegistry<unknown>;
	/** Resolves once the handler is waiting at its gate. */
	reached_gate: () => Promise<void>;
	/** Lets the handler past its gate to build and register its stream. */
	open_gate: () => void;
	/** Resolves once the handler has returned its response. */
	responded: () => Promise<void>;
	close: () => Promise<void>;
}

/** The two Node transports `@hono/node-server` serves. */
type Transport = 'http1' | 'http2';

/**
 * A server with one SSE route that waits at a gate, then builds a stream and
 * registers it — the shape of the audit-log route, minus the database.
 */
const start_server = async (transport: Transport): Promise<TestServer> => {
	const registry = new SubscriberRegistry<unknown>();
	const gate_reached = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const response_returned = Promise.withResolvers<void>();
	const app = new Hono();
	app.get('/stream', async (c) => {
		gate_reached.resolve();
		await gate.promise;
		const { response, stream } = create_sse_response(c, log);
		const unsubscribe = registry.subscribe(stream);
		stream.on_close(unsubscribe);
		response_returned.resolve();
		return response;
	});
	const { promise: listening, resolve: on_listening } = Promise.withResolvers<AddressInfo>();
	const server: ServerType = serve(
		{
			fetch: app.fetch,
			port: 0,
			hostname: '127.0.0.1',
			...(transport === 'http2' ? { createServer } : null)
		},
		(info) => on_listening(info)
	);
	const { port } = await listening;
	return {
		port,
		registry,
		reached_gate: () => gate_reached.promise,
		open_gate: () => gate.resolve(),
		responded: () => response_returned.promise,
		close: () =>
			new Promise<void>((resolve) => {
				registry.close_all();
				server.close(() => resolve());
				(server as { closeAllConnections?: () => void }).closeAllConnections?.();
			})
	};
};

/** A client request to the SSE route, transport-neutral. */
interface TestRequest {
	/** Resolves once the first bytes of the response body arrive. */
	first_data: Promise<void>;
	/** Drops the request — the client leaving. */
	destroy: () => void;
}

const open_request = (transport: Transport, port: number): TestRequest => {
	const { promise: first_data, resolve } = Promise.withResolvers<void>();
	if (transport === 'http2') {
		const session = http2_connect(`http://127.0.0.1:${port}`);
		session.on('error', () => {
			// the test destroys the session on purpose
		});
		const req = session.request({ ':path': '/stream', ':method': 'GET' });
		req.on('error', () => {
			// the test cancels the request on purpose
		});
		req.once('data', () => resolve());
		req.end();
		return {
			first_data,
			destroy: () => {
				req.close(http2_constants.NGHTTP2_CANCEL);
				session.destroy();
			}
		};
	}
	const req = http_request({ host: '127.0.0.1', port, path: '/stream', method: 'GET' });
	req.on('error', () => {
		// the test destroys the request on purpose
	});
	req.on('response', (res) => {
		res.once('data', () => resolve());
	});
	req.end();
	return { first_data, destroy: () => req.destroy() };
};

let current: TestServer | null = null;

afterEach(async () => {
	await current?.close();
	current = null;
});

describe.each<Transport>(['http1', 'http2'])(
	'create_sse_response on @hono/node-server over %s',
	(transport) => {
		test('a client that leaves before the handler returns leaves no stream behind', async () => {
			const server = (current = await start_server(transport));
			const req = open_request(transport, server.port);
			await server.reached_gate();

			req.destroy();
			await settle();
			server.open_gate();
			await server.responded();

			await wait_until(() => server.registry.count === 0);
		});
	}
);

describe('create_sse_response on @hono/node-server while streaming', () => {
	test('a client that leaves while streaming leaves no stream behind', async () => {
		const server = (current = await start_server('http1'));
		const req = open_request('http1', server.port);
		await server.reached_gate();
		server.open_gate();
		await req.first_data;
		assert.strictEqual(server.registry.count, 1);

		req.destroy();

		await wait_until(() => server.registry.count === 0);
	});

	test('a client that stays keeps its stream', async () => {
		const server = (current = await start_server('http1'));
		const req = open_request('http1', server.port);
		await server.reached_gate();
		server.open_gate();
		await req.first_data;
		await settle();

		assert.strictEqual(server.registry.count, 1);
		req.destroy();
	});
});
