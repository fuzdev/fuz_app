import '../assert_dev_env.ts';

/**
 * Bun runtime adapter for spawnable cross-process test server binaries.
 *
 * Binds `Bun.serve` and `hono/bun`'s module-level `upgradeWebSocket` +
 * `websocket` handler. The shared `testing/cross_backend/testing_server_core.ts` owns the rest.
 * Third sibling to `testing/cross_backend/testing_server_node.ts` / `testing/cross_backend/testing_server_deno.ts` —
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
 * `Bun.serve` is declared locally (mirroring `testing/cross_backend/testing_server_deno.ts`'s
 * `Deno` declaration) so this module typechecks under fuz_app's Node-based
 * config without `@types/bun`. It is only ever *run* under Bun.
 *
 * @module
 */

import process from 'node:process';
import { getConnInfo, upgradeWebSocket, websocket } from 'hono/bun';

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
		websocket?: unknown;
	}) => { stop: (close_active_connections?: boolean) => Promise<void> | void };
};

/** Build the Bun {@link TestingServerAdapter}. */
export const create_bun_testing_adapter = (): TestingServerAdapter => ({
	runtime_label: 'Bun',
	runtime: create_node_runtime(),
	get_connection_ip: (c) => getConnInfo(c).remote.address,
	// Bun's WS upgrade is module-level and stateless (like Deno) — no
	// post-serve attach. The `websocket` handler is threaded into `serve`
	// below, where `Bun.serve` wants it.
	prepare_websocket: () => ({ upgrade_websocket: upgradeWebSocket }),
	serve: ({ fetch, port, hostname }) => {
		const server = Bun.serve({
			fetch: fetch as (request: Request, server: unknown) => Response | Promise<Response>,
			port,
			hostname,
			// Harmless for HTTP-only binaries — Bun only invokes it for sockets
			// upgraded via `upgradeWebSocket`.
			websocket
		});
		const handle: ServeHandle = {
			// Bun bug (1.3.14): after a *server-initiated* WebSocket close
			// (`ServerWebSocket.close()` / `hono/bun`'s `WSContext.close()`),
			// `server.stop()` never resolves — Bun doesn't decrement its
			// active-connection count for a server-closed socket, so the stop
			// waits forever for a connection it already closed. The trigger is
			// orthogonal to HTTP load, hono-vs-raw `Bun.serve`, in-vs-cross
			// process, the force flag (`stop()`/`stop(false)`/`stop(true)` all
			// hang), and the client runtime — a single server-closed WS is
			// necessary and sufficient. Client-initiated close or leaving the
			// socket open both stop cleanly in ~0ms. In this suite the trigger is
			// `create_ws_auth_guard` closing the socket on `session_revoke_all`
			// (the `ws.cross.test.ts` close-on-revoke case) — the only
			// server-initiated WS close, which is why teardown hangs there and
			// not under HTTP-only or client-closed WS traffic.
			//
			// So initiate a force-close (`true` drops active connections, no
			// drain) but DON'T await it: awaiting hangs `start_testing_server`'s
			// shutdown forever — `built.close()` and `exit(0)` never run, and the
			// spawning harness blocks on a child that never exits (observed as a
			// multi-minute hang needing SIGKILL). The force-close still tears the
			// live sockets down; the `exit(0)` the core fires immediately after
			// does the real teardown a few ms later. Node/Deno don't need this —
			// their `shutdown()`/`close()` resolve normally. The `.catch` guards a
			// future Bun that rejects rather than hangs; if a future Bun resolves
			// the promise after a server-initiated close, revert to
			// `await server.stop(true)` to mirror the Node/Deno adapters.
			shutdown: () => {
				void Promise.resolve(server.stop(true)).catch(() => {});
				return Promise.resolve();
			},
			native: server
		};
		return handle;
	},
	pid: process.pid,
	register_shutdown_signals: (handler) => {
		process.on('SIGINT', () => void handler());
		process.on('SIGTERM', () => void handler());
	},
	exit: (code) => process.exit(code)
});
