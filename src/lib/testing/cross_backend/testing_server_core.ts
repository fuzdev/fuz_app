import '../assert_dev_env.ts';

/**
 * Runtime-agnostic core for spawnable cross-process **test** server
 * binaries.
 *
 * A test binary mounts a fuz_app-derived surface over a real HTTP socket so
 * the `cross_backend/*` suites (and the cross-impl bench) can drive it the
 * same way they drive the Rust spine. This module owns the runtime-neutral
 * orchestration — stale-daemon check, daemon-info write, serve, post-serve
 * WS attach, graceful shutdown — and delegates the runtime-boundary
 * primitives (HTTP serve, WS upgrade construction, signals, pid, exit) to a
 * `TestingServerAdapter`. The shipped adapters are
 * `testing/cross_backend/testing_server_node.ts` (`@hono/node-server` + `@hono/node-ws`),
 * `testing/cross_backend/testing_server_deno.ts` (`Deno.serve` + `@hono/deno`), and
 * `testing/cross_backend/testing_server_bun.ts` (`Bun.serve` + `@hono/bun`).
 *
 * The app itself — routes, RPC, DB, `_testing_reset`, WS endpoints — is the
 * caller's `StartTestingServerOptions.build_app` seam, so this core
 * stays domain-free. WebSocket endpoints mount through `create_app_server`'s
 * `ws_endpoints`: `build_app` asks its context to prepare the runtime's
 * upgrade helper and passes the resulting factory as
 * `create_upgrade_websocket`; the core attaches it to the server once
 * `serve` returns (Node's `injectWebSocket`). fuz_app's own `testing_spine_server` passes a
 * no-domain build; consumers (zzz, fuz_forge) pass their domain build.
 *
 * **NEVER ships in a release.** This module lives under `cross_backend/` and
 * opens with `import '../assert_dev_env.ts';`, which throws on
 * production-bundle load. The runtime adapters reach for the optional
 * `@hono/node-server` / `@hono/node-ws` peer deps; only test binaries import
 * them.
 *
 * @module
 */

import type { Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { Logger, type Logger as LoggerType } from '@fuzdev/fuz_util/log.ts';

import { write_daemon_info, read_daemon_info, is_daemon_running } from '../../cli/daemon.ts';
import type { RuntimeDeps } from '../../runtime/deps.ts';

/**
 * Adapter-built handle to a bound HTTP server.
 *
 * `shutdown` stops accepting new connections at once and settles when the
 * in-flight ones have drained — the core starts it, closes the app (which
 * ends live WebSockets), then awaits it. `native` is an adapter-specific
 * server reference — used by Node's `@hono/node-ws` `injectWebSocket(server)`
 * post-serve hook.
 */
export interface ServeHandle {
	shutdown: () => Promise<void>;
	/** Adapter-specific server ref for post-serve hooks. Type-erased at the seam. */
	native?: unknown;
}

/** Options for `TestingServerAdapter.prepare_websocket`. */
export interface PrepareWebsocketOptions {
	/**
	 * Largest inbound WebSocket message, in bytes — pass the largest
	 * `WsEndpointSpec.max_message_bytes` of the mounted endpoints; a smaller
	 * value refuses messages the endpoint would accept. Node's `ws` server takes
	 * it as its frame cap (`maxPayload`), so an oversized message is refused
	 * before it is buffered whole; Deno and Bun ignore it, leaving the
	 * per-message check `register_ws_endpoint` makes (both close with
	 * `WS_CLOSE_MESSAGE_TOO_BIG`). The default sits far below `ws`'s own
	 * 100 MiB, so a build raising an endpoint's cap must pass it here too.
	 *
	 * @default DEFAULT_WS_MAX_MESSAGE_BYTES
	 */
	max_message_bytes?: number;
}

/**
 * Result of an adapter's WS preparation step.
 *
 * `create_upgrade_websocket` is the factory a build passes to
 * `create_app_server` as `AppServerOptions.create_upgrade_websocket`.
 * `attach_to_server` runs after `serve()` returns a `ServeHandle` —
 * Node uses it for `injectWebSocket(server)`, and it does nothing when the
 * factory was never called (no `ws_endpoints`); Deno and Bun leave it
 * undefined.
 */
export interface PreparedWebsocket {
	create_upgrade_websocket: (app: Hono) => UpgradeWebSocket;
	attach_to_server?: (handle: ServeHandle) => void;
}

/**
 * Runtime adapter contract for the test-binary entry. Each adapter
 * (`testing/cross_backend/testing_server_node.ts`, `testing/cross_backend/testing_server_deno.ts`,
 * `testing/cross_backend/testing_server_bun.ts`) implements this and hands the shape to
 * `start_testing_server`.
 */
export interface TestingServerAdapter {
	/** Human-readable runtime label for log output (e.g. `"Node"`, `"Deno"`). */
	runtime_label: string;
	/** `RuntimeDeps` capability bundle from `create_node_runtime` / `create_deno_runtime`. */
	runtime: RuntimeDeps;
	/** Extract the raw TCP connection IP from a Hono context. */
	get_connection_ip: (c: Context) => string | undefined;
	/** Prepare the runtime's WS upgrade helper and its post-serve attach step. */
	prepare_websocket: (options?: PrepareWebsocketOptions) => PreparedWebsocket;
	/** Bind `app.fetch` to `port` on `hostname`; return a `ServeHandle`. */
	serve: (options: { fetch: Hono['fetch']; port: number; hostname: string }) => ServeHandle;
	/** Current process pid (for `daemon.json`). */
	pid: number;
	/** Register SIGINT/SIGTERM listeners that invoke `handler` once each. */
	register_shutdown_signals: (handler: () => Promise<void>) => void;
	/** Forceful exit on graceful-shutdown completion or fatal error. */
	exit: (code: number) => never;
}

/** What the core hands a `StartTestingServerOptions.build_app` seam. */
export interface BuildTestingAppContext {
	/**
	 * Prepare the runtime adapter's WS upgrade helper and return the factory
	 * to pass to `create_app_server` as `create_upgrade_websocket`. The core
	 * runs the adapter's attach step once the server is bound, so a build
	 * that mounts `ws_endpoints` needs nothing else. An HTTP-only build
	 * doesn't call it. Call it at most once per build: the Node adapter
	 * attaches one upgrade listener per preparation, and two would race on
	 * the shared socket.
	 */
	prepare_websocket: (options?: PrepareWebsocketOptions) => (app: Hono) => UpgradeWebSocket;
}

/** The assembled app a `StartTestingServerOptions.build_app` seam returns. */
export interface BuiltTestingApp {
	/** The assembled Hono app (HTTP routes, RPC, and WS endpoints already mounted). */
	app: Hono;
	/**
	 * Tear down backend(s) + DB + any rotation on graceful shutdown. Called
	 * after the listener stops accepting connections and before its drain is
	 * awaited, so it must end live WebSockets (`AppServer.close` does).
	 */
	close: () => Promise<void>;
}

/** Options for `start_testing_server`. */
export interface StartTestingServerOptions {
	/** Runtime-boundary adapter (Node or Deno). */
	adapter: TestingServerAdapter;
	/**
	 * Daemon-info namespace — the `cli/daemon` key the `daemon.json` is
	 * written under (e.g. `'fuz_app_spine'`). The cross-process harness
	 * reads the daemon token from the rotation file, not this; `daemon.json`
	 * is for stale-process detection + parity with production daemon
	 * lifecycle.
	 */
	daemon_name: string;
	/** Bind host (e.g. `'localhost'`). */
	host: string;
	/** Bind port. */
	port: number;
	/** App version recorded in `daemon.json`. */
	app_version?: string;
	/**
	 * Build the app. Closes over the entry's runtime + connection-IP getter
	 * + password deps + resolved config — so this core never touches the
	 * domain. Returns the assembled app and a `close` teardown.
	 */
	build_app: (context: BuildTestingAppContext) => Promise<BuiltTestingApp>;
	/** Optional logger; defaults to a `[daemon_name]`-namespaced `Logger`. */
	log?: LoggerType;
}

/**
 * Loopback bind hosts — the only ones the test binary may serve on. It ships
 * deterministic dev secrets (fixed cookie keys + bootstrap token in
 * `default_secrets.ts`), so binding any network-reachable interface would let
 * anyone who knows those fixed keys forge cookies against it. An allowlist
 * (not an `0.0.0.0`/`::` blocklist) closes the gap a concrete LAN/public
 * interface IP — e.g. `--host 192.168.1.50` — would otherwise slip through.
 * Covers `localhost`, the IPv4 loopback `127.0.0.0/8`, and IPv6 `::1`.
 */
export const is_loopback_host = (host: string): boolean => {
	const h = host.replace(/^\[(.*)\]$/, '$1'); // unwrap an `[::1]`-style IPv6 literal
	return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};

/**
 * Boot a test-mode server using the supplied runtime adapter.
 *
 * Mirrors a production `start_server` at the surface level — stale-daemon
 * check, daemon-info write, bind, graceful shutdown — but the app is the
 * caller's no-domain (or domain) `StartTestingServerOptions.build_app`
 * and the runtime boundary is the `TestingServerAdapter`. Refuses any
 * non-loopback bind host (the test binary must stay on loopback — see
 * `is_loopback_host`).
 */
export const start_testing_server = async (options: StartTestingServerOptions): Promise<void> => {
	const { adapter, daemon_name, host, port, app_version, build_app } = options;
	const log = options.log ?? new Logger(`[${daemon_name}]`);
	const { runtime } = adapter;

	if (!is_loopback_host(host)) {
		log.error(
			`FATAL: binding to '${host}' exposes the test binary (which ships deterministic ` +
				`dev secrets) beyond loopback. Use --host localhost (default), 127.0.0.1, or ::1 instead.`
		);
		adapter.exit(1);
	}

	const stale = await read_daemon_info(runtime, daemon_name);
	if (stale) {
		if (await is_daemon_running(runtime, stale.pid)) {
			log.warn('found running server', stale);
		} else {
			log.warn(`stale daemon.json (pid ${stale.pid} not running), replacing`);
		}
	}

	const prepared_websockets: Array<PreparedWebsocket> = [];
	const built = await build_app({
		prepare_websocket: (ws_options) => {
			const prepared = adapter.prepare_websocket(ws_options);
			prepared_websockets.push(prepared);
			return prepared.create_upgrade_websocket;
		}
	});

	await write_daemon_info(runtime, daemon_name, {
		version: 1,
		pid: adapter.pid,
		port,
		started: new Date().toISOString(),
		app_version: app_version ?? '0.0.0-test'
	});

	log.info(`Listening on http://${host}:${port} (${adapter.runtime_label}, test mode)`);
	const server = adapter.serve({ fetch: built.app.fetch, port, hostname: host });
	for (const prepared of prepared_websockets) prepared.attach_to_server?.(server);

	let shutting_down = false;
	const shutdown = async (): Promise<void> => {
		if (shutting_down) adapter.exit(1);
		shutting_down = true;
		log.info('shutting down...');
		try {
			// Stop accepting first so no new request reaches a closed DB, but
			// don't await the drain yet: live WebSockets hold it open until
			// `built.close()` ends them (`AppServer.close`), so awaiting it
			// first would wait on sockets nothing is closing. A request already
			// in flight when the signal lands may still see the backend close
			// under it — acceptable for a test binary, where shutdown follows
			// the suite.
			const drained = server.shutdown();
			await built.close();
			await drained;
		} catch (error) {
			log.error('shutdown error:', error);
		}
		adapter.exit(0);
	};

	adapter.register_shutdown_signals(shutdown);
};
