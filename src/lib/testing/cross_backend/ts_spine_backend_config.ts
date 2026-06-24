import '../assert_dev_env.ts';

/**
 * Cross-process `BackendConfig` presets for fuz_app's domain-free **TS**
 * spine test binary (`src/test/cross_backend/testing_spine_server_{node,deno,bun}.ts`).
 *
 * The TS analog of `rust_spine_stub_backend_config` (which spawns the Rust spine):
 * these spawn fuz_app's own TS impl over real HTTP with no domain layer, so
 * the `cross_backend_ts_node` / `cross_backend_ts_deno` / `cross_backend_ts_bun`
 * self-test projects verify fuz_app's wire path in its own repo across all
 * three JS runtimes. All run against in-memory PGlite (`memory://`) — no
 * external Postgres, unlike the Rust path.
 *
 * The binary writes its daemon token to `{FUZ_TESTING_TS_SPINE_DIR}/run/daemon_token`;
 * anchoring the dir to `paths.root` makes that equal `paths.daemon_token_path`,
 * which `spawn_backend` reads after the health probe.
 *
 * @module
 */

import type {BackendConfig} from './backend_config.ts';
import {build_test_backend_paths} from './build_test_backend_paths.ts';
import {
	LOGIN_RATE_LIMIT_ENABLED_ENV,
	make_default_ts_backend_config,
	ts_default_capabilities,
} from './default_backend_configs.ts';
import {SPINE_SSE_PATH} from './spine_surface_constants.ts';

/** Env var naming the backend root dir; `{dir}/run/daemon_token` must match `bootstrap.daemon_token_path`. */
export const TS_SPINE_DIR_ENV = 'FUZ_TESTING_TS_SPINE_DIR';

/**
 * Capabilities for the TS spine binary — `ts_default_capabilities` plus `sse`
 * (the binary wires `audit_log_sse`), `ready` (the binary live-mounts the
 * `/ready` deploy gate in `build_spine_app`), and `peer_request` (the backend
 * WS transport's `request_connection` path drives server→client `peer/ping`).
 */
const ts_spine_capabilities = Object.freeze({
	...ts_default_capabilities,
	sse: true,
	ready: true,
	peer_request: true,
});

/**
 * Capabilities for the **Bun** spine binary — `ts_spine_capabilities` with
 * `oversized_reject_closes_connection: false`. `Bun.serve` drains the declared
 * `Content-Length` of an oversized-body `413` reject and keeps the socket
 * alive (processing the correctly-framed pipelined request) even when the
 * response carries `Connection: close`, unlike `@hono/node-server` / Deno /
 * hyper, which close. Bun is not insecure — it frames on `Content-Length`, so
 * there is no desync — but the smuggling suite's strong "connection closes"
 * assertion doesn't hold; this flag routes Bun onto the suite's no-desync arm.
 * See `docs/security.md` §"Body Size Limiting".
 */
const ts_spine_bun_capabilities = Object.freeze({
	...ts_spine_capabilities,
	oversized_reject_closes_connection: false,
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
	/** Database URL. Default `'memory://'` (in-memory PGlite). */
	readonly database_url?: string;
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
}

/**
 * `extra_env` carrying the login-rate-limit toggle when enabled. The TS binary
 * reads `FUZ_LOGIN_RATE_LIMIT_ENABLED` directly (a test-only flag, not in
 * `BaseServerEnv`); the same env-var name the Rust spine-stub reads, so one
 * backend-config option drives both impls.
 */
const login_rate_limit_env = (enable: boolean | undefined): Record<string, string> =>
	enable ? {[LOGIN_RATE_LIMIT_ENABLED_ENV]: 'true'} : {};

/**
 * `BackendConfig` for the Node TS spine binary — spawned via `gro run`
 * (Gro's TS loader resolves the `$lib`-free entry's relative imports).
 */
export const ts_spine_node_backend_config = (
	options: TsSpineBackendConfigOptions = {},
): BackendConfig => {
	const {port = TS_SPINE_NODE_DEFAULT_PORT, database_url, enable_login_rate_limit} = options;
	const name = 'ts_spine_node';
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
			},
			capabilities: ts_spine_capabilities,
		}),
		sse_path: SPINE_SSE_PATH,
	};
};

/**
 * `BackendConfig` for the Bun TS spine binary — spawned via `bun run`. Bun
 * resolves the entry's relative `.js`→`.ts` source specifiers natively (no
 * flag needed — unlike Deno's `--sloppy-imports`, and like Gro's loader on
 * the Node path), and `Bun.serve` + `hono/bun` need no extra deps.
 */
export const ts_spine_bun_backend_config = (
	options: TsSpineBackendConfigOptions = {},
): BackendConfig => {
	const {port = TS_SPINE_BUN_DEFAULT_PORT, database_url, enable_login_rate_limit} = options;
	const name = 'ts_spine_bun';
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
			},
			capabilities: ts_spine_bun_capabilities,
		}),
		sse_path: SPINE_SSE_PATH,
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
	options: TsSpineBackendConfigOptions = {},
): BackendConfig => {
	const {port = TS_SPINE_DENO_DEFAULT_PORT, database_url, enable_login_rate_limit} = options;
	const name = 'ts_spine_deno';
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
				TS_SPINE_DENO_ENTRY,
			],
			database_url,
			paths,
			extra_env: {
				[TS_SPINE_DIR_ENV]: paths.root,
				...login_rate_limit_env(enable_login_rate_limit),
			},
			capabilities: ts_spine_capabilities,
		}),
		sse_path: SPINE_SSE_PATH,
	};
};
