import '../assert_dev_env.js';

/**
 * Bun runtime adapter for spawnable cross-process test server binaries.
 *
 * Binds `Bun.serve` and `hono/bun`'s module-level `upgradeWebSocket` +
 * `websocket` handler. The shared `testing_server_core.ts` owns the rest.
 * Third sibling to `testing_server_node.ts` / `testing_server_deno.ts` —
 * together the three isolate the JS-runtime axis (Node V8 / Deno V8 / Bun
 * JSC) on identical TS surfaces, and the Rust spine binary covers the
 * cross-language axis.
 *
 * Needs **no extra deps**: `hono/bun` ships with the `hono` peer dep and
 * `Bun.serve` is built in (unlike Node, which pulls `@hono/node-server` +
 * `@hono/node-ws`). `RuntimeDeps` reuse `create_node_runtime` — Bun
 * implements the `node:fs` / `node:process` surface `RuntimeDeps` +
 * `cli/daemon` touch.
 *
 * `Bun.serve` is declared locally (mirroring `testing_server_deno.ts`'s
 * `Deno` declaration) so this module typechecks under fuz_app's Node-based
 * config without `@types/bun`. It is only ever *run* under Bun.
 *
 * @module
 */

import process from 'node:process';
import {getConnInfo, upgradeWebSocket, websocket} from 'hono/bun';

import {create_node_runtime} from '../../runtime/node.js';
import type {ServeHandle, TestingServerAdapter} from './testing_server_core.js';

// Minimal Bun API surface this adapter touches. This module is only ever
// imported by a Bun-run test binary; the declaration keeps it typecheckable
// under the Node toolchain. (pid / exit / signals come from `node:process`,
// which Bun implements.)
declare const Bun: {
	serve: (options: {
		fetch: (request: Request, server: unknown) => Response | Promise<Response>;
		port: number;
		hostname: string;
		websocket?: unknown;
	}) => {stop: (close_active_connections?: boolean) => Promise<void> | void};
};

/** Build the Bun {@link TestingServerAdapter}. */
export const create_bun_testing_adapter = (): TestingServerAdapter => ({
	runtime_label: 'Bun',
	runtime: create_node_runtime(),
	get_connection_ip: (c) => getConnInfo(c).remote.address,
	// Bun's WS upgrade is module-level and stateless (like Deno) — no
	// post-serve attach. The `websocket` handler is threaded into `serve`
	// below, where `Bun.serve` wants it.
	prepare_websocket: () => ({upgrade_websocket: upgradeWebSocket}),
	serve: ({fetch, port, hostname}) => {
		const server = Bun.serve({
			fetch: fetch as (request: Request, server: unknown) => Response | Promise<Response>,
			port,
			hostname,
			// Harmless for HTTP-only binaries — Bun only invokes it for sockets
			// upgraded via `upgradeWebSocket`.
			websocket,
		});
		const handle: ServeHandle = {
			shutdown: async () => {
				await server.stop();
			},
			native: server,
		};
		return handle;
	},
	pid: process.pid,
	register_shutdown_signals: (handler) => {
		process.on('SIGINT', () => void handler());
		process.on('SIGTERM', () => void handler());
	},
	exit: (code) => process.exit(code),
});
