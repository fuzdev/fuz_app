import '../assert_dev_env.ts';

/**
 * Node runtime adapter for spawnable cross-process test server binaries.
 *
 * Binds `@hono/node-server`'s `serve()` and module-level `upgradeWebSocket`.
 * `prepare_websocket` builds the `ws` `WebSocketServer` that upgrades the
 * sockets, and `serve` hands it to `@hono/node-server`, which upgrades only
 * on a server given one. The shared `testing/cross_backend/testing_server_core.ts`
 * owns the rest. A test binary builds this adapter and hands it to
 * `start_testing_server` alongside its `build_app` seam.
 *
 * `@hono/node-server` + `ws` are **optional** peer deps — only test binaries
 * import them; production bundles never reach this module (the
 * `assert_dev_env` guard throws on prod load).
 *
 * @module
 */

import process from 'node:process';
import { serve, upgradeWebSocket, type ServerType } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { WebSocketServer } from 'ws';

import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '../../actions/transports.ts';
import { create_node_runtime } from '../../runtime/node.ts';
import type { ServeHandle, TestingServerAdapter } from './testing_server_core.ts';

const node_serve_handle = (server: ServerType): ServeHandle => ({
	shutdown: () =>
		new Promise((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		})
});

/**
 * How far above the endpoint's message limit the `ws` frame cap sits. Past
 * `maxPayload`, `ws` closes with `WS_CLOSE_MESSAGE_TOO_BIG` but no reason, so
 * the cap leaves headroom for the per-message check in `register_action_ws` to
 * answer a message just over the limit with the code and
 * `WS_CLOSE_MESSAGE_TOO_BIG_REASON`, as the other backends do, and still
 * refuses a grossly oversized one before buffering it toward `ws`'s 100 MiB
 * default.
 */
const NODE_WS_MAX_PAYLOAD_MULTIPLIER = 2;

/** Build the Node `TestingServerAdapter`. */
export const create_node_testing_adapter = (): TestingServerAdapter => {
	// set by `prepare_websocket`, read by `serve` — the core prepares before it serves
	let wss: WebSocketServer | undefined;
	return {
		runtime_label: 'Node',
		runtime: create_node_runtime(),
		get_connection_ip: (c) => getConnInfo(c).remote.address,
		prepare_websocket: (options) => {
			wss = new WebSocketServer({
				noServer: true,
				maxPayload:
					NODE_WS_MAX_PAYLOAD_MULTIPLIER *
					(options?.max_message_bytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES)
			});
			return upgradeWebSocket;
		},
		serve: ({ fetch, port, hostname }) =>
			node_serve_handle(
				serve({ fetch, port, hostname, websocket: wss ? { server: wss } : undefined })
			),
		pid: process.pid,
		register_shutdown_signals: (handler) => {
			process.on('SIGINT', () => void handler());
			process.on('SIGTERM', () => void handler());
		},
		exit: (code) => process.exit(code)
	};
};
