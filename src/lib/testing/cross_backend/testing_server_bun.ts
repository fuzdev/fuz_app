import '../assert_dev_env.ts';

/**
 * Bun runtime adapter for spawnable cross-process test server binaries.
 *
 * Binds `Bun.serve` and `@hono/bun`'s module-level `upgradeWebSocket` +
 * `websocket` handler. The shared `testing/cross_backend/testing_server_core.ts` owns the rest.
 * Sibling to `testing/cross_backend/testing_server_node.ts` — together the two
 * isolate the JS-runtime axis (Node V8 / Bun JSC) on identical TS surfaces,
 * and the Rust spine binary covers the cross-language axis.
 *
 * Needs the optional `@hono/bun` peer dep (the Bun counterpart to Node's
 * `@hono/node-server` + `ws`); `Bun.serve` is built in.
 * `RuntimeDeps` reuse `create_node_runtime` — Bun
 * implements the `node:fs` / `node:process` surface `RuntimeDeps` +
 * `testing/daemon_info.ts` touch.
 *
 * `Bun.serve` is declared locally so this module typechecks under fuz_app's
 * Node-based config without `@types/bun`. It is only ever *run* under Bun.
 *
 * @module
 */

import process from 'node:process';
import { getConnInfo, upgradeWebSocket, websocket } from '@hono/bun';

import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '../../actions/transports.ts';
import { create_node_runtime } from '../../runtime/node.ts';
import type { ServeHandle, TestingServerAdapter } from './testing_server_core.ts';

// Minimal Bun API surface this adapter touches. This module is only ever
// imported by a Bun-run test binary; the declaration keeps it typecheckable
// under the Node toolchain. (pid / exit / signals come from `node:process`,
// which Bun implements.)
declare const Bun: {
	serve: (options: {
		fetch: (request: Request, server: unknown) => Response | Promise<Response>;
		port: number;
		hostname: string;
		websocket?: object & { maxPayloadLength?: number };
	}) => { stop: (close_active_connections?: boolean) => Promise<void> | void };
};

/**
 * How far above the endpoint's message limit Bun's own frame cap sits. Bun
 * drops a socket past `maxPayloadLength` without a close frame (the client sees
 * 1006), where Node's `ws` closes with `WS_CLOSE_MESSAGE_TOO_BIG` but no reason —
 * so, as on Node, the cap leaves headroom for the per-message check in
 * `register_action_ws` to answer a message just over the limit with that code
 * and `WS_CLOSE_MESSAGE_TOO_BIG_REASON`, and still refuses a
 * grossly oversized one before buffering it toward Bun's 16 MiB default.
 */
const BUN_WS_MAX_PAYLOAD_MULTIPLIER = 2;

/** Build the Bun `TestingServerAdapter`. */
export const create_bun_testing_adapter = (): TestingServerAdapter => {
	// set by `prepare_websocket`, read by `serve` — the core prepares before it serves
	let max_message_bytes = DEFAULT_WS_MAX_MESSAGE_BYTES;
	return {
		runtime_label: 'Bun',
		runtime: create_node_runtime(),
		get_connection_ip: (c) => getConnInfo(c).remote.address,
		// Bun's WS upgrade is module-level and stateless. The `websocket`
		// handler is threaded into `serve` below, where `Bun.serve` wants it,
		// carrying the frame cap.
		prepare_websocket: (options) => {
			max_message_bytes = options?.max_message_bytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES;
			return upgradeWebSocket;
		},
		serve: ({ fetch, port, hostname }) => {
			const server = Bun.serve({
				fetch,
				port,
				hostname,
				// Harmless for HTTP-only binaries — Bun only invokes it for sockets
				// upgraded via `upgradeWebSocket`.
				websocket: {
					...websocket,
					maxPayloadLength: BUN_WS_MAX_PAYLOAD_MULTIPLIER * max_message_bytes
				}
			});
			const handle: ServeHandle = {
				// `false` stops accepting and lets the requests in flight finish, as
				// Node's `server.close()` does; `true` would reset them, losing a
				// response the shutdown drain is waiting to send. It settles once
				// every connection is gone: the core's `built.close()` ends the live
				// WebSockets, and a shutdown that gave up skips the wait. Verified on
				// Bun 1.4.4, the tested floor.
				shutdown: () => Promise.resolve(server.stop(false))
			};
			return handle;
		},
		pid: process.pid,
		register_shutdown_signals: (handler) => {
			process.on('SIGINT', () => void handler());
			process.on('SIGTERM', () => void handler());
		},
		exit: (code) => process.exit(code)
	};
};
