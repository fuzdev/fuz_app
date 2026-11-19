/**
 * Tests for `create_ws_transport`'s refused upgrade: the rejection carries
 * the refusal's status and body, the connection is closed once it is read,
 * and a body that never ends still rejects. Each case runs against a local
 * `node:http` server whose `upgrade` handler writes the response by hand.
 *
 * @module
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { afterEach, assert, describe, test } from 'vitest';
import { WebSocketServer } from 'ws';

import {
	create_ws_transport,
	WS_REFUSAL_BODY_TIMEOUT_MS,
	WsUpgradeRefusedError
} from '#lib/testing/transports/ws_transport.ts';

const REFUSAL_BODY = '{"error":"forbidden_origin"}';

interface StubServer {
	readonly base_url: string;
	/** Resolves when the client ends the upgrade connection (the server reads its FIN). */
	readonly socket_ended: Promise<void>;
}

const servers: Array<Server> = [];
const sockets: Array<Socket> = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				})
		)
	);
});

/** A server answering every upgrade with `respond` written raw to its socket. */
const start_refusing_server = async (respond: (socket: Socket) => void): Promise<StubServer> => {
	const server = createServer();
	servers.push(server);
	let on_socket_ended!: () => void;
	const socket_ended = new Promise<void>((resolve) => {
		on_socket_ended = resolve;
	});
	server.on('upgrade', (_req, socket: Socket) => {
		sockets.push(socket);
		// read, so the client's FIN surfaces as `end`; the server's half stays
		// open (an http server socket allows half-open), so `close` never fires
		socket.resume();
		socket.once('end', on_socket_ended);
		respond(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return { base_url: `http://127.0.0.1:${port}`, socket_ended };
};

const catch_refusal = async (base_url: string): Promise<WsUpgradeRefusedError> => {
	try {
		await create_ws_transport({ base_url, ws_path: '/ws', cookies: [] });
	} catch (error) {
		assert.instanceOf(error, WsUpgradeRefusedError);
		return error;
	}
	assert.fail('expected the upgrade to be refused');
};

describe('create_ws_transport refused upgrade', () => {
	test('a complete refusal rejects with its status and body, and the connection closes', async () => {
		const stub = await start_refusing_server((socket) => {
			socket.write(
				'HTTP/1.1 403 Forbidden\r\n' +
					'Content-Type: application/json\r\n' +
					`Content-Length: ${Buffer.byteLength(REFUSAL_BODY)}\r\n` +
					'\r\n' +
					REFUSAL_BODY
			);
		});
		const error = await catch_refusal(stub.base_url);
		assert.strictEqual(error.status, 403);
		assert.strictEqual(error.body, REFUSAL_BODY);
		assert.include(error.message, 'refused: Unexpected server response: 403');
		// the server never closes its end, so only the client's close ends it
		await stub.socket_ended;
	});

	test('a refusal whose body never ends rejects with what arrived', async () => {
		const partial = '{"error":';
		const stub = await start_refusing_server((socket) => {
			socket.write(
				'HTTP/1.1 401 Unauthorized\r\n' +
					'Content-Type: application/json\r\n' +
					'Content-Length: 1000\r\n' +
					'\r\n' +
					partial
			);
		});
		const started = performance.now();
		const error = await catch_refusal(stub.base_url);
		const elapsed = performance.now() - started;
		assert.strictEqual(error.status, 401);
		assert.strictEqual(error.body, partial);
		assert.isAtLeast(elapsed, WS_REFUSAL_BODY_TIMEOUT_MS - 50);
		await stub.socket_ended;
	});
});

describe('create_ws_transport accepted upgrade', () => {
	test('an accepted upgrade opens and round-trips a frame', async () => {
		const server = createServer();
		servers.push(server);
		const wss = new WebSocketServer({ server });
		wss.on('connection', (ws) => {
			ws.on('message', (data, is_binary) => ws.send(data, { binary: is_binary }));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		const client = await create_ws_transport({
			base_url: `http://127.0.0.1:${port}`,
			ws_path: '/ws',
			cookies: []
		});
		try {
			await client.send({ hello: 'world' });
			const echoed = await client.wait_for((msg) => (msg as { hello?: string }).hello === 'world');
			assert.deepEqual(echoed, { hello: 'world' });
		} finally {
			await client.close();
			wss.close();
		}
	});
});
