import '../assert_dev_env.js';

/**
 * Deno runtime adapter for spawnable cross-process test server binaries.
 *
 * Binds `Deno.serve` and `hono/deno`'s module-level `upgradeWebSocket`. The
 * shared `testing/cross_backend/testing_server_core.ts` owns the rest. Counterpart to
 * `testing/cross_backend/testing_server_node.ts` — together they isolate the JS-runtime axis (Deno
 * vs Node V8) on identical TS surfaces, and the Rust spine binary covers the
 * cross-language axis.
 *
 * `Deno` globals are declared locally (mirroring `runtime/deno.ts`) so this
 * module typechecks under fuz_app's Node-based config without a `deno.json`
 * or `@types/deno`. It is only ever *run* under Deno.
 *
 * @module
 */

import {upgradeWebSocket} from 'hono/deno';

import {create_deno_runtime} from '../../runtime/deno.js';
import type {ServeHandle, TestingServerAdapter} from './testing_server_core.js';

// Minimal Deno API surface this adapter touches. This module is only ever
// imported by a Deno-run test binary; the declaration keeps it typecheckable
// under the Node toolchain.
declare const Deno: {
	serve: (
		options: {port: number; hostname: string},
		handler: (request: Request, info: unknown) => Response | Promise<Response>,
	) => {shutdown: () => Promise<void>};
	pid: number;
	exit: (code: number) => never;
	addSignalListener: (signal: string, handler: () => void) => void;
};

/** Build the Deno {@link TestingServerAdapter}. */
export const create_deno_testing_adapter = (): TestingServerAdapter => ({
	runtime_label: 'Deno',
	runtime: create_deno_runtime([]),
	get_connection_ip: (c) =>
		(c.env as {remoteAddr?: {hostname?: string}} | undefined)?.remoteAddr?.hostname,
	// Deno's WS upgrade is module-level and stateless — no post-serve attach.
	prepare_websocket: () => ({upgrade_websocket: upgradeWebSocket}),
	serve: ({fetch, port, hostname}) => {
		const server = Deno.serve({port, hostname}, fetch as Parameters<typeof Deno.serve>[1]);
		const handle: ServeHandle = {shutdown: () => server.shutdown(), native: server};
		return handle;
	},
	pid: Deno.pid,
	register_shutdown_signals: (handler) => {
		Deno.addSignalListener('SIGINT', () => void handler());
		Deno.addSignalListener('SIGTERM', () => void handler());
	},
	exit: (code) => Deno.exit(code),
});
