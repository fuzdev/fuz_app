import '../assert_dev_env.js';

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

import type {BackendConfig} from './backend_config.js';
import {build_test_backend_paths} from './build_test_backend_paths.js';
import {
	make_default_ts_backend_config,
	ts_default_capabilities,
} from './default_backend_configs.js';

/** Env var naming the backend root dir; `{dir}/run/daemon_token` must match `bootstrap.daemon_token_path`. */
export const TS_SPINE_DIR_ENV = 'FUZ_TESTING_TS_SPINE_DIR';

/**
 * Audit-log SSE stream path the TS spine binary serves (it wires
 * `audit_log_sse`). Matches `SPINE_SSE_PATH` in `testing/cross_backend/default_spine_surface.ts`
 * and the cross-process SSE suite's default. Scoped to the TS configs
 * (which advertise `capabilities.sse: true`) — the Rust spine doesn't serve
 * the stream, so the shared `ts_default_capabilities` stays `sse: false`.
 */
export const TS_SPINE_SSE_PATH = '/api/admin/audit/stream';

/**
 * Capabilities for the TS spine binary — `ts_default_capabilities` plus `sse`
 * (the binary wires `audit_log_sse`) and `ready` (the binary live-mounts the
 * `/ready` deploy gate in `build_spine_app`).
 */
const ts_spine_capabilities = Object.freeze({...ts_default_capabilities, sse: true, ready: true});

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
}

/**
 * `BackendConfig` for the Node TS spine binary — spawned via `gro run`
 * (Gro's TS loader resolves the `$lib`-free entry's relative imports).
 */
export const ts_spine_node_backend_config = (
	options: TsSpineBackendConfigOptions = {},
): BackendConfig => {
	const {port = TS_SPINE_NODE_DEFAULT_PORT, database_url} = options;
	const name = 'ts_spine_node';
	const paths = build_test_backend_paths(name);
	return {
		...make_default_ts_backend_config({
			name,
			port,
			start_command: ['gro', 'run', TS_SPINE_NODE_ENTRY],
			database_url,
			paths,
			extra_env: {[TS_SPINE_DIR_ENV]: paths.root},
			capabilities: ts_spine_capabilities,
		}),
		sse_path: TS_SPINE_SSE_PATH,
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
	const {port = TS_SPINE_BUN_DEFAULT_PORT, database_url} = options;
	const name = 'ts_spine_bun';
	const paths = build_test_backend_paths(name);
	return {
		...make_default_ts_backend_config({
			name,
			port,
			start_command: ['bun', 'run', TS_SPINE_BUN_ENTRY],
			database_url,
			paths,
			extra_env: {[TS_SPINE_DIR_ENV]: paths.root},
			capabilities: ts_spine_capabilities,
		}),
		sse_path: TS_SPINE_SSE_PATH,
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
	const {port = TS_SPINE_DENO_DEFAULT_PORT, database_url} = options;
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
			extra_env: {[TS_SPINE_DIR_ENV]: paths.root},
			capabilities: ts_spine_capabilities,
		}),
		sse_path: TS_SPINE_SSE_PATH,
	};
};
