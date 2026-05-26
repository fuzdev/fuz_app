import '../assert_dev_env.js';

/**
 * Node runtime adapter for spawnable cross-process test server binaries.
 *
 * Binds `@hono/node-server`'s `serve()` and `@hono/node-ws`'s two-phase
 * `createNodeWebSocket(app)` / `injectWebSocket(server)`. The shared
 * `testing_server_core.ts` owns the rest. A test binary builds this adapter
 * and hands it to `start_testing_server` alongside its `build_app` seam.
 *
 * `@hono/node-server` + `@hono/node-ws` are **optional** peer deps (same
 * posture as `ws`) — only test binaries import them; production bundles
 * never reach this module (the `assert_dev_env` guard throws on prod load).
 *
 * @module
 */

import process from 'node:process';
import {serve, type ServerType} from '@hono/node-server';
import {getConnInfo} from '@hono/node-server/conninfo';
import {createNodeWebSocket} from '@hono/node-ws';

import {create_node_runtime} from '../../runtime/node.js';
import type {ServeHandle, TestingServerAdapter} from './testing_server_core.js';

const node_serve_handle = (server: ServerType): ServeHandle => ({
	shutdown: () =>
		new Promise((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		}),
	native: server,
});

/** Build the Node {@link TestingServerAdapter}. */
export const create_node_testing_adapter = (): TestingServerAdapter => ({
	runtime_label: 'Node',
	runtime: create_node_runtime(),
	get_connection_ip: (c) => getConnInfo(c).remote.address,
	prepare_websocket: (app) => {
		const {upgradeWebSocket, injectWebSocket} = createNodeWebSocket({app});
		return {
			upgrade_websocket: upgradeWebSocket,
			attach_to_server: (handle) => {
				// `handle.native` is the `ServerType` from `serve()` —
				// type-erased at the {@link ServeHandle} seam, so it downcasts here.
				injectWebSocket(handle.native as ServerType);
			},
		};
	},
	serve: ({fetch, port, hostname}) => node_serve_handle(serve({fetch, port, hostname})),
	pid: process.pid,
	register_shutdown_signals: (handler) => {
		process.on('SIGINT', () => void handler());
		process.on('SIGTERM', () => void handler());
	},
	exit: (code) => process.exit(code),
});
