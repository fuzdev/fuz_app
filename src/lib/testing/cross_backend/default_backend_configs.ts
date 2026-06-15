import '../assert_dev_env.js';

/**
 * Family-shared `BackendConfig` builders for cross-process test backends.
 *
 * Two consumer-facing factories — {@link make_default_ts_backend_config}
 * and {@link make_default_rust_backend_config} — own the common shape
 * for the JS-runtime (Deno/Node on V8) and Rust families respectively.
 * Per-backend factories in consumer projects compose a small
 * declaration against one of these and add consumer-specific env vars
 * via `extra_env`.
 *
 * Defaults baked in by family:
 *
 * - **TS** — `'memory://'` PGlite, 30s startup window, capabilities
 *   without trusted_proxy/login_rate_limit. The TS canonical path
 *   leaves these limiters null in test mode.
 * - **Rust** — caller-supplied real Postgres URL (PGlite isn't reachable
 *   from `tokio-postgres`), 120s startup window (cargo first-build cost),
 *   capabilities including trusted_proxy + login_rate_limit + the
 *   `FUZ_TESTING_RESET_DB_ON_STARTUP=true` self-wipe gate.
 *
 * Both builders default `port_env_var` to `'PORT'`. Consumers whose
 * binary reads a different name (e.g. zzz's `ZZZ_PORT`) override.
 *
 * Common across both families: `/api/rpc`, `/api/ws`, `/health`,
 * `/api/account/bootstrap`, `cookie_name: 'fuz_session'`, the standard
 * bootstrap block keyed off `default_test_*` constants. Builders call
 * `build_test_backend_paths(name)` internally when the optional `paths`
 * is omitted.
 *
 * @module
 */

import type {BackendBootstrapConfig, BackendConfig} from './backend_config.js';
import type {BackendCapabilities} from './capabilities.js';
import {build_test_backend_paths, type TestBackendPaths} from './build_test_backend_paths.js';
import {
	default_test_bootstrap_token,
	default_test_cookie_keys,
	default_test_keeper_password,
	default_test_keeper_username,
} from './default_secrets.js';

/**
 * Capabilities shared by TS-family backends — same canonical
 * implementation, same feature set. No trusted-proxy phase (the test
 * binary doesn't enable proxy parsing) and no per-account login rate
 * limit (the TS canonical path leaves the limiter null in test mode).
 */
export const ts_default_capabilities: BackendCapabilities = Object.freeze({
	bearer_auth: true,
	trusted_proxy: false,
	login_rate_limit: false,
	ws: true,
	sse: false,
	cell_crud: true,
	cell_relations: true,
	account_lifecycle: true,
	fact_serving: true,
	// Off by default like `sse` — a generic TS consumer backend may not mount
	// `/ready`. fuz_app's own spine configs (`ts_spine_*`) opt in.
	ready: false,
	// `GET /api/account/status` is bundled into `create_account_route_specs`, so
	// every TS backend mounting account routes serves it.
	account_status: true,
	// Node/Deno close the socket on an oversized-body reject (the default
	// posture). A Bun-served consumer overrides to `false` (see the bun spine
	// config) — fail-loud rather than silently skipping the smuggle detector.
	oversized_reject_closes_connection: true,
});

/**
 * Capabilities for the Rust family. Adds `trusted_proxy: true` (the
 * Rust spine's client-IP middleware is always wired; the env-gate just
 * controls whether XFF is consulted vs the TCP peer IP) and
 * `login_rate_limit: true` (env-gated bucket on `/login` + `/password`).
 */
export const rust_default_capabilities: BackendCapabilities = Object.freeze({
	bearer_auth: true,
	trusted_proxy: true,
	login_rate_limit: true,
	ws: true,
	sse: false,
	cell_crud: true,
	cell_relations: true,
	account_lifecycle: true,
	fact_serving: true,
	// Off by default like `sse`; the spine-stub preset opts in (it mounts
	// `/ready` over the env-supplied fixture path).
	ready: false,
	// The Rust `account_router` bundles `/status` into the account routes, so
	// every Rust spine serving the account surface serves it.
	account_status: true,
	// hyper sends an RST on the oversized-body reject — the connection closes
	// and the pipelined request is never reached.
	oversized_reject_closes_connection: true,
});

/** Bootstrap block built from the default secrets + supplied paths. */
const build_default_bootstrap = (
	paths: TestBackendPaths,
	overrides?: Partial<BackendBootstrapConfig>,
): BackendBootstrapConfig => ({
	token_path: paths.bootstrap_token_path,
	token: default_test_bootstrap_token,
	username: default_test_keeper_username,
	password: default_test_keeper_password,
	daemon_token_path: paths.daemon_token_path,
	...overrides,
});

export interface MakeDefaultTsBackendConfigOptions {
	/** Diagnostic label; also used as the tmpdir prefix when `paths` is omitted. */
	readonly name: string;
	/** TCP port the binary listens on. */
	readonly port: number;
	/** argv passed to the spawn (first entry is the binary). */
	readonly start_command: ReadonlyArray<string>;
	/** Defaults to `'memory://'` (in-memory PGlite). */
	readonly database_url?: string;
	/** Merged on top of the generic env baseline; later keys win. */
	readonly extra_env?: Readonly<Record<string, string>>;
	/** Defaults to `ts_default_capabilities`. */
	readonly capabilities?: BackendCapabilities;
	/** Pre-computed paths; defaults to `build_test_backend_paths(name)`. */
	readonly paths?: TestBackendPaths;
	/** Override individual bootstrap fields (username/password/token). */
	readonly bootstrap_overrides?: Partial<BackendBootstrapConfig>;
	/**
	 * Env-var name the binary reads for its port. Defaults to `'PORT'`.
	 * Consumers whose binary reads a different name (e.g. `'ZZZ_PORT'`)
	 * override.
	 */
	readonly port_env_var?: string;
	/**
	 * Session cookie name the binary's `create_session_config` uses.
	 * Defaults to `'fuz_session'`. Must match the consumer's session config
	 * — the harness threads the `_testing_reset`-returned keeper cookie into
	 * its jar under this name, so a mismatch surfaces as 401s on the
	 * `create_account` path (e.g. fuz_forge uses `'fuz_forge_session'`).
	 */
	readonly cookie_name?: string;
}

/**
 * Shared builder for TS-family backends (Deno + Node). Owns the common
 * env baseline (NODE_ENV, HOST, PORT, in-memory PGlite, cookie keys,
 * bootstrap token path) so per-backend factories only declare what
 * genuinely differs.
 */
export const make_default_ts_backend_config = (
	opts: MakeDefaultTsBackendConfigOptions,
): BackendConfig => {
	const {
		name,
		port,
		start_command,
		database_url = 'memory://',
		extra_env,
		capabilities = ts_default_capabilities,
		paths = build_test_backend_paths(name),
		bootstrap_overrides,
		port_env_var = 'PORT',
		cookie_name = 'fuz_session',
	} = opts;
	return {
		name,
		start_command,
		base_url: `http://localhost:${port}`,
		rpc_path: '/api/rpc',
		ws_path: '/api/ws',
		health_path: '/health',
		bootstrap_path: '/api/account/bootstrap',
		cookie_name,
		startup_timeout_ms: 30_000,
		env: {
			NODE_ENV: 'development',
			HOST: 'localhost',
			[port_env_var]: String(port),
			DATABASE_URL: database_url,
			SECRET_FUZ_COOKIE_KEYS: default_test_cookie_keys,
			FUZ_ALLOWED_ORIGINS: 'http://localhost:*',
			FUZ_BOOTSTRAP_TOKEN_PATH: paths.bootstrap_token_path,
			...extra_env,
		},
		bootstrap: build_default_bootstrap(paths, bootstrap_overrides),
		capabilities,
	};
};

export interface MakeDefaultRustBackendConfigOptions {
	/** Diagnostic label; also used as the tmpdir prefix when `paths` is omitted. */
	readonly name: string;
	/** TCP port the binary listens on. */
	readonly port: number;
	/** argv passed to the spawn (first entry is the binary). */
	readonly start_command: ReadonlyArray<string>;
	/**
	 * Required — Rust needs real Postgres (PGlite isn't reachable from
	 * `tokio-postgres`). Consumers typically supply
	 * `'postgres://localhost/{repo}_test_{name}'`.
	 */
	readonly database_url: string;
	/** Merged on top of the generic env baseline; later keys win. */
	readonly extra_env?: Readonly<Record<string, string>>;
	/** Defaults to `rust_default_capabilities`. */
	readonly capabilities?: BackendCapabilities;
	/** Pre-computed paths; defaults to `build_test_backend_paths(name)`. */
	readonly paths?: TestBackendPaths;
	/** Override individual bootstrap fields (username/password/token). */
	readonly bootstrap_overrides?: Partial<BackendBootstrapConfig>;
	/**
	 * Env-var name the binary reads for its port. Defaults to `'PORT'`.
	 * Consumers whose binary reads a different name (e.g. `'ZZZ_PORT'`)
	 * override.
	 */
	readonly port_env_var?: string;
	/**
	 * Initial value for `RUST_LOG`. Defaults to `'info'`. Consumers pass
	 * their binary-specific module filter
	 * (e.g. `'info,zzz_server=info,testing_zzz_server=info'`).
	 */
	readonly rust_log?: string;
	/**
	 * Session cookie name the binary uses. Defaults to `'fuz_session'`.
	 * Must match the consumer's session config (see the TS builder's note).
	 */
	readonly cookie_name?: string;
}

/**
 * Shared builder for Rust-family backends. Owns the common env baseline
 * (RUST_LOG, HOST, port, real Postgres, cookie keys, bootstrap token
 * path, the `FUZ_TESTING_RESET_DB_ON_STARTUP=true` self-wipe gate) plus
 * the 120s startup window for cargo's first-run build cost.
 */
export const make_default_rust_backend_config = (
	opts: MakeDefaultRustBackendConfigOptions,
): BackendConfig => {
	const {
		name,
		port,
		start_command,
		database_url,
		extra_env,
		capabilities = rust_default_capabilities,
		paths = build_test_backend_paths(name),
		bootstrap_overrides,
		port_env_var = 'PORT',
		rust_log = 'info',
		cookie_name = 'fuz_session',
	} = opts;
	return {
		name,
		start_command,
		base_url: `http://localhost:${port}`,
		rpc_path: '/api/rpc',
		ws_path: '/api/ws',
		health_path: '/health',
		bootstrap_path: '/api/account/bootstrap',
		cookie_name,
		startup_timeout_ms: 120_000,
		env: {
			RUST_LOG: rust_log,
			HOST: 'localhost',
			[port_env_var]: String(port),
			DATABASE_URL: database_url,
			SECRET_FUZ_COOKIE_KEYS: default_test_cookie_keys,
			FUZ_ALLOWED_ORIGINS: 'http://localhost:*',
			FUZ_BOOTSTRAP_TOKEN_PATH: paths.bootstrap_token_path,
			// Self-wipe the auth-namespace schema before migrations on every
			// boot. Read by `fuz_testing::reset_db_on_startup_if_env_set`,
			// which the consumer's test binary invokes from its
			// `pre_migration_hook` between pool creation and
			// `fuz_db::run_migrations`. The `_testing_reset` RPC action
			// (per-test reset) is orthogonal.
			FUZ_TESTING_RESET_DB_ON_STARTUP: 'true',
			...extra_env,
		},
		bootstrap: build_default_bootstrap(paths, bootstrap_overrides),
		capabilities,
	};
};
