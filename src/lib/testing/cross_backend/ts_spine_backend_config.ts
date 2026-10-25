import '../assert_dev_env.ts';

/**
 * Cross-process `BackendConfig` presets for fuz_app's domain-free **TS**
 * spine test binary (`src/test/cross_backend/testing_spine_server_{node,deno,bun}.ts`).
 *
 * The TS analog of `rust_spine_stub_backend_config` (which spawns the Rust spine):
 * these spawn fuz_app's own TS impl over real HTTP with no domain layer, so
 * the `cross_backend_ts_node` / `cross_backend_ts_deno` / `cross_backend_ts_bun`
 * self-test projects verify fuz_app's wire path in its own repo across all
 * three JS runtimes. All run against in-memory pglet (`memory://`) — no
 * external Postgres, unlike the Rust path.
 *
 * The binary writes its daemon token to `{FUZ_TESTING_TS_SPINE_DIR}/run/daemon_token`;
 * anchoring the dir to `paths.root` makes that equal `paths.daemon_token_path`,
 * which `spawn_backend` reads after the health probe.
 *
 * @module
 */

import type { BackendConfig } from './backend_config.ts';
import { build_test_backend_paths } from './build_test_backend_paths.ts';
import {
	action_rate_limit_env,
	make_default_ts_backend_config,
	ts_default_capabilities
} from './default_backend_configs.ts';
import {
	LOGIN_RATE_LIMIT_ENABLED_ENV,
	SPINE_SSE_PATH,
	TS_SPINE_DIR_ENV
} from './spine_surface_constants.ts';

/**
 * Capabilities for the TS spine binary — `ts_default_capabilities` plus `sse`
 * (the binary wires `audit_log_sse`), `ready` (the binary live-mounts the
 * `/ready` deploy gate in `build_spine_app`), `peer_request` (the backend
 * WS transport's `request_connection` path drives server→client `peer/ping`),
 * `ws_account_actions` (the binary mounts its full action set on `/api/ws`,
 * the account actions among them),
 * `cell_gated_create` (the binary's `full_spine_mount` mounts the
 * `test_cell_gated_create_authorize` policy), and `ws_role_gated` (the binary
 * mounts the role-gated WS endpoint at `SPINE_ROLE_GATED_WS_PATH`). The Node
 * binary's preset; `ws_refusal_body` stays `false`, as `@hono/node-ws` drops a
 * refused upgrade's body.
 */
const ts_spine_capabilities = Object.freeze({
	...ts_default_capabilities,
	sse: true,
	ready: true,
	peer_request: true,
	ws_account_actions: true,
	cell_gated_create: true,
	ws_role_gated: true
});

/**
 * Capabilities for the **Deno** spine binary — `ts_spine_capabilities` with
 * `ws_refusal_body: true` (`Deno.upgradeWebSocket` leaves a refused upgrade's
 * response to Hono, body included).
 */
const ts_spine_deno_capabilities = Object.freeze({
	...ts_spine_capabilities,
	ws_refusal_body: true
});

/**
 * Capabilities for the **Bun** spine binary — `ts_spine_capabilities` with
 * `ws_handshake_pipelining: false` and `ws_refusal_body: true` (`Bun.serve`
 * sends a refused upgrade's response as built).
 *
 * `Bun.serve` answers `400` to an upgrade request that carries WebSocket
 * frames in the same TCP write when the handler upgrades after an await that
 * yields to the event loop — a timer, I/O; the spine's does, behind the auth
 * middleware's database reads — so the WS suite's frames-with-the-handshake
 * case has nothing to drive there (observed on Bun 1.4.3; an upgrade made
 * synchronously in `fetch`, or after an await that settles in the same
 * microtask run, takes the frames).
 */
const ts_spine_bun_capabilities = Object.freeze({
	...ts_spine_capabilities,
	ws_handshake_pipelining: false,
	ws_refusal_body: true
});

/** Default port for the Node TS spine binary — slots beside the Rust `spine_stub` (1177). */
export const TS_SPINE_NODE_DEFAULT_PORT = 1178;

/** Default port for the Deno TS spine binary. */
export const TS_SPINE_DENO_DEFAULT_PORT = 1179;

/** Default port for the Bun TS spine binary. */
export const TS_SPINE_BUN_DEFAULT_PORT = 1180;

/** Entry module spawned for the Node TS spine binary. */
export const TS_SPINE_NODE_ENTRY = 'src/test/cross_backend/testing_spine_server_node.ts';

/** Entry module spawned for the Deno TS spine binary. */
export const TS_SPINE_DENO_ENTRY = 'src/test/cross_backend/testing_spine_server_deno.ts';

/** Entry module spawned for the Bun TS spine binary. */
export const TS_SPINE_BUN_ENTRY = 'src/test/cross_backend/testing_spine_server_bun.ts';

export interface TsSpineBackendConfigOptions {
	/** Listening port. Defaults per runtime (`1178` Node, `1179` Deno, `1180` Bun). */
	readonly port?: number;
	/** Database URL. Default `'memory://'` (in-memory pglet). */
	readonly database_url?: string;
	/**
	 * Backend name — labels the spawn in errors and logs, and names its
	 * directory under `os.tmpdir()` (`build_test_backend_paths`). Defaults per
	 * runtime (`ts_spine_node`, `ts_spine_deno`, `ts_spine_bun`). Give each
	 * backend spawned alongside another of its runtime its own name, so their
	 * bootstrap and daemon-token files don't collide.
	 */
	readonly name?: string;
	/**
	 * Enable the per-IP + per-account login rate limiters on the spawned binary
	 * (`FUZ_LOGIN_RATE_LIMIT_ENABLED=true`). Off by default — the standard cross
	 * suites fire many loopback logins a live limiter would 429. Set `true` only
	 * for the dedicated login-security cross project (`global_setup_login_security.ts`),
	 * which drives the 429 + `Retry-After` path and XFF-keyed bucketing over the
	 * wire (`login_security.ts`). The binary always wires `trusted_proxies` for
	 * `127.0.0.1`/`::1`, so the limiter keys on the resolved `X-Forwarded-For`
	 * client IP. Mirrors `SpineStubBackendConfigOptions.enable_login_rate_limit`.
	 */
	readonly enable_login_rate_limit?: boolean;
	/**
	 * Enable the action rate limiters (`FUZ_ACTION_RATE_LIMIT_ENABLED=true`) —
	 * one per-IP and one per-account limiter shared by the RPC and WS
	 * endpoints. Off by default, like `enable_login_rate_limit`; set only for
	 * the dedicated security cross project, which drives them through
	 * `ws_action_rate_limit.ts`. Mirrors `SpineStubBackendConfigOptions.enable_action_rate_limit`.
	 */
	readonly enable_action_rate_limit?: boolean;
	/**
	 * Replace both action limiters' `max_attempts`
	 * (`FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`) so a suite reaches the cap in a few
	 * calls. Requires `enable_action_rate_limit` — the binary refuses to boot
	 * otherwise. Mirrors `SpineStubBackendConfigOptions.action_rate_limit_max_attempts`.
	 */
	readonly action_rate_limit_max_attempts?: number;
}

/**
 * `extra_env` carrying the login-rate-limit toggle when enabled. The TS binary
 * reads `FUZ_LOGIN_RATE_LIMIT_ENABLED` directly (a test-only flag, not in
 * `BaseServerEnv`); the same env-var name the Rust spine-stub reads, so one
 * backend-config option drives both impls.
 */
const login_rate_limit_env = (enable: boolean | undefined): Record<string, string> =>
	enable ? { [LOGIN_RATE_LIMIT_ENABLED_ENV]: 'true' } : {};

/**
 * `BackendConfig` for the Node TS spine binary — spawned via `gro run`
 * (Gro's TS loader resolves the entry's relative imports).
 */
export const ts_spine_node_backend_config = (
	options: TsSpineBackendConfigOptions = {}
): BackendConfig => {
	const {
		port = TS_SPINE_NODE_DEFAULT_PORT,
		database_url,
		enable_login_rate_limit,
		name = 'ts_spine_node'
	} = options;
	const paths = build_test_backend_paths(name);
	return {
		...make_default_ts_backend_config({
			name,
			port,
			start_command: ['gro', 'run', TS_SPINE_NODE_ENTRY],
			database_url,
			paths,
			extra_env: {
				[TS_SPINE_DIR_ENV]: paths.root,
				...login_rate_limit_env(enable_login_rate_limit),
				...action_rate_limit_env(options)
			},
			capabilities: ts_spine_capabilities
		}),
		sse_path: SPINE_SSE_PATH
	};
};

/**
 * `BackendConfig` for the Bun TS spine binary — spawned via `bun run`. Bun
 * resolves the entry's relative `.js`→`.ts` source specifiers natively (no
 * flag needed — unlike Deno's `--sloppy-imports`, and like Gro's loader on
 * the Node path). `Bun.serve` is built in; the WS upgrade comes from the
 * optional `@hono/bun` peer dep.
 */
export const ts_spine_bun_backend_config = (
	options: TsSpineBackendConfigOptions = {}
): BackendConfig => {
	const {
		port = TS_SPINE_BUN_DEFAULT_PORT,
		database_url,
		enable_login_rate_limit,
		name = 'ts_spine_bun'
	} = options;
	const paths = build_test_backend_paths(name);
	return {
		...make_default_ts_backend_config({
			name,
			port,
			start_command: ['bun', 'run', TS_SPINE_BUN_ENTRY],
			database_url,
			paths,
			extra_env: {
				[TS_SPINE_DIR_ENV]: paths.root,
				...login_rate_limit_env(enable_login_rate_limit),
				...action_rate_limit_env(options)
			},
			capabilities: ts_spine_bun_capabilities
		}),
		sse_path: SPINE_SSE_PATH
	};
};

/**
 * `BackendConfig` for the Deno TS spine binary. The `--allow-*` set mirrors
 * the cross-process needs (net + read/write for the daemon-token file + env
 * + sys); `--unstable-detect-cjs` matches the ecosystem's Deno test entries.
 *
 * `--sloppy-imports` is required because the binary imports fuz_app **source**
 * via relative `.js` specifiers (the `src/lib` convention) — Deno resolves
 * `.js`→`.ts` only under this flag, whereas Gro's loader (the Node path)
 * does so natively. (zzz's Deno entry sidesteps it by importing fuz_app as a
 * built package; this binary tests live source instead.)
 */
export const ts_spine_deno_backend_config = (
	options: TsSpineBackendConfigOptions = {}
): BackendConfig => {
	const {
		port = TS_SPINE_DENO_DEFAULT_PORT,
		database_url,
		enable_login_rate_limit,
		name = 'ts_spine_deno'
	} = options;
	const paths = build_test_backend_paths(name);
	return {
		...make_default_ts_backend_config({
			name,
			port,
			start_command: [
				'deno',
				'run',
				'--allow-net',
				'--allow-read',
				'--allow-env',
				'--allow-write',
				'--allow-sys',
				'--allow-ffi',
				'--allow-run',
				'--unstable-detect-cjs',
				'--sloppy-imports',
				TS_SPINE_DENO_ENTRY
			],
			database_url,
			paths,
			extra_env: {
				[TS_SPINE_DIR_ENV]: paths.root,
				...login_rate_limit_env(enable_login_rate_limit),
				...action_rate_limit_env(options)
			},
			capabilities: ts_spine_deno_capabilities
		}),
		sse_path: SPINE_SSE_PATH
	};
};
