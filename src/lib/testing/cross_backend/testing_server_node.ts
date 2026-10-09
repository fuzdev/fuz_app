import '../assert_dev_env.ts';

/**
 * Node runtime adapter for spawnable cross-process test server binaries.
 *
 * Binds `@hono/node-server`'s `serve()` and `@hono/node-ws`'s two-phase
 * `createNodeWebSocket({app})` / `injectWebSocket(server)`: the factory
 * `prepare_websocket` returns builds the first half from the app
 * `create_app_server` assembles, and the core runs the second once `serve()`
 * returns. The shared `testing/cross_backend/testing_server_core.ts` owns
 * the rest. A test binary builds this adapter and hands it to
 * `start_testing_server` alongside its `build_app` seam.
 *
 * `@hono/node-server` + `@hono/node-ws` are **optional** peer deps (same
 * posture as `ws`) — only test binaries import them; production bundles
 * never reach this module (the `assert_dev_env` guard throws on prod load).
 *
 * @module
 */

import process from 'node:process';
import { serve, type ServerType } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';

import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '../../actions/transports.ts';
import { create_node_runtime } from '../../runtime/node.ts';
import type { ServeHandle, TestingServerAdapter } from './testing_server_core.ts';

const node_serve_handle = (server: ServerType): ServeHandle => ({
	shutdown: () =>
		new Promise((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		}),
	native: server
});

/** Build the Node `TestingServerAdapter`. */
export const create_node_testing_adapter = (): TestingServerAdapter => ({
	runtime_label: 'Node',
	runtime: create_node_runtime(),
	get_connection_ip: (c) => getConnInfo(c).remote.address,
	prepare_websocket: (options) => {
		const max_payload = options?.max_message_bytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES;
		let node_ws: NodeWebSocket | undefined;
		return {
			create_upgrade_websocket: (app) => {
				node_ws = createNodeWebSocket({ app });
				// `@hono/node-ws` builds its `ws` server with no options and takes
				// none, so its frame cap would stay `ws`'s 100 MiB default. `ws` reads
				// `options.maxPayload` per upgrade, so setting it here — before any
				// connection — caps every socket at the endpoint's message limit.
				node_ws.wss.options.maxPayload = max_payload;
				return node_ws.upgradeWebSocket;
			},
			attach_to_server: (handle) => {
				// `handle.native` is the `ServerType` from `serve()` —
				// type-erased at the `ServeHandle` seam, so it downcasts here.
				node_ws?.injectWebSocket(handle.native as ServerType);
			}
		};
	},
	serve: ({ fetch, port, hostname }) => node_serve_handle(serve({ fetch, port, hostname })),
	pid: process.pid,
	register_shutdown_signals: (handler) => {
		process.on('SIGINT', () => void handler());
		process.on('SIGTERM', () => void handler());
	},
	exit: (code) => process.exit(code)
});
