/**
 * `register_action_ws` over a real Node WebSocket server, against a client
 * that **withholds its close frame**.
 *
 * `@hono/node-ws` keeps firing `onMessage` after the server calls
 * `ws.close(…)`, until the close handshake completes — and a client that
 * never answers the close holds the socket in that state for the `ws` close
 * timeout. A well-behaved client library answers the close itself, so the
 * window can't be reached through one; this file drives a raw-socket client
 * instead (`connect_raw_ws`), reads the server's close frame, and keeps
 * sending.
 *
 * The cases assert that a socket the server closed — revoked, or evicted by
 * the per-account cap — runs no further handler. The control case sends on a
 * socket the server did *not* close, through the same raw client, so the
 * "nothing ran" assertions are the close's doing. One more case writes frames
 * in the same TCP write as the upgrade request — before `onOpen` can have run —
 * and asserts they are queued and dispatched rather than lost.
 *
 * @module
 */

import { afterEach, assert, describe, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { register_action_ws } from '$lib/actions/register_action_ws.ts';
import type { RequestResponseActionSpec } from '$lib/actions/action_spec.ts';
import type { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import { WS_CLOSE_CONNECTION_LIMIT, WS_CLOSE_SESSION_REVOKED } from '$lib/actions/transports.ts';
import { AUTH_SESSION_TOKEN_HASH_KEY, REQUEST_CONTEXT_KEY } from '$lib/auth/request_context.ts';
import { hash_session_token } from '$lib/auth/session_queries.ts';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY
} from '$lib/hono_context.ts';
import { create_test_account } from '$lib/testing/entities.ts';
import { create_stub_db } from '$lib/testing/stubs.ts';
import {
	connect_raw_ws,
	is_raw_ws_close,
	raw_ws_close_code,
	RAW_WS_OPCODE_TEXT,
	type RawWsClient,
	type RawWsFrame
} from '$lib/testing/transports/ws_raw_client.ts';

const log = new Logger('test', { level: 'off' });

const ACCOUNT_ID = 'acc_raw';

/** A side-effecting action — what a revoked socket must not be able to run. */
const record_spec: RequestResponseActionSpec = {
	method: 'record',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.strictObject({ value: z.string() }),
	output: z.strictObject({ value: z.string() }),
	async: true,
	description: 'record a value'
};

const is_response_to =
	(id: number) =>
	(frame: RawWsFrame): boolean =>
		frame.opcode === RAW_WS_OPCODE_TEXT && JSON.parse(frame.payload.toString('utf-8')).id === id;

const record_request = (id: number, value: string): string =>
	JSON.stringify({ jsonrpc: '2.0', id, method: 'record', params: { value } });

/** Long enough for a frame to cross loopback and its handler to run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

interface TestServer {
	port: number;
	transport: BackendWebsocketTransport;
	/** Values the `record` handler ran with, in order. */
	recorded: Array<string>;
	close: () => Promise<void>;
}

const start_server = async (max_connections_per_account?: number): Promise<TestServer> => {
	const app = new Hono();
	// Stand in for the auth middleware chain: a session credential on one
	// account, pre-baked (no database behind this test).
	app.use('/ws', async (c, next) => {
		c.set(ACCOUNT_ID_KEY, ACCOUNT_ID);
		c.set(REQUEST_CONTEXT_KEY, {
			account: create_test_account({ id: ACCOUNT_ID }),
			actor: null,
			role_grants: []
		});
		c.set(CREDENTIAL_TYPE_KEY, 'session');
		c.set('auth_session_id', 'raw_session');
		c.set(AUTH_SESSION_TOKEN_HASH_KEY, hash_session_token('raw_session'));
		c.set(AUTH_API_TOKEN_ID_KEY, null);
		c.set(TEST_CONTEXT_PRESET_KEY, true);
		await next();
	});
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
	const recorded: Array<string> = [];
	const { transport } = register_action_ws({
		path: '/ws',
		connection_closer: null,
		app,
		upgradeWebSocket,
		actions: [
			{
				spec: record_spec,
				handler: (input) => {
					recorded.push((input as { value: string }).value);
					return input;
				}
			}
		],
		db: create_stub_db(),
		max_connections_per_account,
		heartbeat: false,
		log
	});
	const server: ServerType = await new Promise((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
	});
	injectWebSocket(server);
	return {
		port: (server.address() as AddressInfo).port,
		transport,
		recorded,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
};

describe('register_action_ws on Node — a client that withholds its close frame', () => {
	const clients: Array<RawWsClient> = [];
	let server: TestServer | null = null;

	const open = async (): Promise<RawWsClient> => {
		const client = await connect_raw_ws({ port: server!.port, path: '/ws' });
		clients.push(client);
		return client;
	};

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy();
		await server?.close();
		server = null;
	});

	test('control: an open socket dispatches every frame the raw client sends', async () => {
		server = await start_server();
		const client = await open();

		client.send_text(record_request(1, 'first'));
		await client.wait_for(is_response_to(1));
		client.send_text(record_request(2, 'second'));
		await client.wait_for(is_response_to(2));

		assert.deepStrictEqual(server.recorded, ['first', 'second']);
	});

	test('frames sent with the handshake dispatch in order once the socket is open', async () => {
		server = await start_server();
		// in the server's hands before `onOpen` has run, let alone admitted
		const client = await connect_raw_ws({
			port: server.port,
			path: '/ws',
			pipelined: [record_request(1, 'first'), record_request(2, 'second')]
		});
		clients.push(client);

		await client.wait_for(is_response_to(1));
		await client.wait_for(is_response_to(2));

		assert.deepStrictEqual(server.recorded, ['first', 'second']);
	});

	test('a revoked socket runs no further handler', async () => {
		server = await start_server();
		const client = await open();
		client.send_text(record_request(1, 'before revocation'));
		await client.wait_for(is_response_to(1));

		assert.strictEqual(server.transport.close_sockets_for_account(ACCOUNT_ID as never), 1);
		const close = await client.wait_for(is_raw_ws_close);
		assert.strictEqual(raw_ws_close_code(close), WS_CLOSE_SESSION_REVOKED);

		// the close frame goes unanswered and the client keeps sending — the
		// server still reads these frames while its close handshake is pending
		client.send_text(record_request(2, 'after revocation'));
		client.send_text(record_request(3, 'and again'));
		await settle();

		assert.deepStrictEqual(server.recorded, ['before revocation']);
		assert.strictEqual(
			client.frames.filter((frame) => frame.opcode === RAW_WS_OPCODE_TEXT).length,
			1,
			'no reply after the close either'
		);
	});

	test('a socket evicted by the connection cap runs no further handler', async () => {
		server = await start_server(1);
		const oldest = await open();
		oldest.send_text(record_request(1, 'oldest, before eviction'));
		await oldest.wait_for(is_response_to(1));

		const newest = await open();
		newest.send_text(record_request(1, 'newest'));
		await newest.wait_for(is_response_to(1));
		const close = await oldest.wait_for(is_raw_ws_close);
		assert.strictEqual(raw_ws_close_code(close), WS_CLOSE_CONNECTION_LIMIT);

		oldest.send_text(record_request(2, 'oldest, after eviction'));
		await settle();

		assert.deepStrictEqual(server.recorded, ['oldest, before eviction', 'newest']);
	});
});
