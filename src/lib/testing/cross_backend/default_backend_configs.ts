import '../assert_dev_env.ts';

/**
 * Family-shared `BackendConfig` builders for cross-process test backends.
 *
 * Two consumer-facing factories — `make_default_ts_backend_config`
 * and `make_default_rust_backend_config` — own the common shape
 * for the JS-runtime (Deno/Node on V8) and Rust families respectively.
 * Per-backend factories in consumer projects compose a small
 * declaration against one of these and add consumer-specific env vars
 * via `extra_env`.
 *
 * Defaults baked in by family:
 *
 * - **TS** — `'memory://'` (in-memory pglet), 30s startup window.
 * - **Rust** — caller-supplied real Postgres URL (an in-process WASM database isn't reachable
 *   from `tokio-postgres`), 120s startup window (cargo first-build cost),
 *   and the `FUZ_TESTING_RESET_DB_ON_STARTUP=true` self-wipe gate.
 *
 * Both builders default `port_env_var` to `'PORT'`. Consumers whose
 * binary reads a different name (e.g. zzz's `ZZZ_PORT`) override. Both bind
 * `HOST` to `DEFAULT_TEST_BACKEND_HOST` (`127.0.0.1`), and, given the name of
 * the binary's daemon-token directory env var (`daemon_token_dir_env`), set it
 * to the `{dir}` whose `{dir}/run/daemon_token` is the bootstrap's
 * `daemon_token_path` (`to_daemon_token_dir`).
 *
 * Common across both families: `/api/rpc`, `/api/ws`, `/health`,
 * `/api/account/bootstrap`, `cookie_name: 'fuz_session'`, the standard
 * bootstrap block keyed off `default_test_*` constants. Builders call
 * `build_test_backend_paths(name)` internally when the optional `paths`
 * is omitted.
 *
 * @module
 */

import { basename, dirname } from 'node:path';

import type { BackendBootstrapConfig, BackendConfig } from './backend_config.ts';
import type { BackendCapabilities, FamilyDefaultCapabilities } from './capabilities.ts';
import { build_test_backend_paths, type TestBackendPaths } from './build_test_backend_paths.ts';
import {
	default_test_bootstrap_token,
	default_test_cookie_keys,
	default_test_keeper_password,
	default_test_keeper_username
} from './default_secrets.ts';
import {
	ACTION_RATE_LIMIT_ENABLED_ENV,
	ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV,
	SPINE_ACCOUNT_BOOTSTRAP_PATH,
	SPINE_RPC_PATH,
	SPINE_WS_PATH
} from './spine_surface_constants.ts';

/**
 * The `HOST` both builders bind a backend to — loopback IPv4, since
 * `localhost` can resolve to `::1` and a backend bound there misses a client
 * that connects to `127.0.0.1` (the raw-socket suites, a git hook calling
 * back). `base_url` stays `http://localhost:<port>`, which reaches it.
 */
export const DEFAULT_TEST_BACKEND_HOST = '127.0.0.1';

/**
 * The directory a binary writing its daemon token to `{dir}/run/daemon_token`
 * is given, so the token lands at `daemon_token_path`.
 *
 * @param daemon_token_path - where the harness reads the token
 * @returns the `{dir}` of that layout
 * @throws Error when the path is not `.../run/daemon_token`, which no such
 *   directory can produce
 */
export const to_daemon_token_dir = (daemon_token_path: string): string => {
	const run_dir = dirname(daemon_token_path);
	if (basename(daemon_token_path) !== 'daemon_token' || basename(run_dir) !== 'run') {
		throw new Error(
			`daemon_token_dir_env needs a daemon_token_path of the form {dir}/run/daemon_token, ` +
				`got ${daemon_token_path}`
		);
	}
	return dirname(run_dir);
};

/**
 * The env entry `daemon_token_dir_env` names, pointing the binary at the
 * directory whose layout puts the token at the bootstrap's `daemon_token_path`.
 */
const daemon_token_dir_entry = (
	daemon_token_dir_env: string | undefined,
	bootstrap: BackendBootstrapConfig
): Record<string, string> =>
	daemon_token_dir_env === undefined
		? {}
		: { [daemon_token_dir_env]: to_daemon_token_dir(bootstrap.daemon_token_path) };

/** Options for `action_rate_limit_env`. */
export interface ActionRateLimitEnvOptions {
	readonly enable_action_rate_limit?: boolean;
	readonly action_rate_limit_max_attempts?: number;
}

/**
 * The `extra_env` entries carrying the action rate-limit toggles, shared by the
 * TS and Rust backend configs so one option pair drives both impls.
 * `action_rate_limit_max_attempts` is passed through even without the enable
 * flag, so the binary refuses the combination instead of the harness hiding it.
 */
export const action_rate_limit_env = (
	options: ActionRateLimitEnvOptions
): Record<string, string> => ({
	...(options.enable_action_rate_limit ? { [ACTION_RATE_LIMIT_ENABLED_ENV]: 'true' } : {}),
	...(options.action_rate_limit_max_attempts !== undefined
		? { [ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV]: String(options.action_rate_limit_max_attempts) }
		: {})
});

/**
 * Capabilities shared by TS-family backends — only what the family
 * guarantees: the declared spine surface's mounts and the behavior of its
 * reference runtime, Node. Carries no `MountFlag`; each backend config states
 * those itself (`FamilyDefaultCapabilities`).
 */
export const ts_default_capabilities: FamilyDefaultCapabilities = Object.freeze({
	// The account-lifecycle verbs are on the declared surface
	// (`create_admin_actions`), which every TS backend running the standard
	// suites mounts.
	account_lifecycle: true,
	// `GET /api/account/status` is bundled into `create_account_route_specs`, so
	// every TS backend mounting account routes serves it.
	account_status: true,
	// Node (`ws`) and Deno hand frames pipelined with the upgrade request to the
	// socket. A Bun-served backend overrides to `false` (see the bun spine
	// config) — `Bun.serve` answers such a request `400` when the upgrade
	// follows an asynchronous check.
	ws_handshake_pipelining: true,
	// `@hono/node-ws` drops a refused upgrade's body, so a Node-served backend
	// sends none. A Deno- or Bun-served one overrides to `true`.
	ws_refusal_body: false
});

/**
 * Capabilities for the Rust family — only what the family guarantees, as with
 * `ts_default_capabilities`: the declared spine surface's mounts and the
 * behavior of hyper. Carries no `MountFlag`.
 */
export const rust_default_capabilities: FamilyDefaultCapabilities = Object.freeze({
	// The account-lifecycle verbs are in the spine's admin action set, on the
	// declared surface every Rust spine backend running the standard suites
	// mounts.
	account_lifecycle: true,
	// The Rust `account_router` bundles `/status` into the account routes, so
	// every Rust spine serving the account surface serves it.
	account_status: true,
	// hyper hands bytes pipelined after the upgrade request to the upgraded
	// stream, where they wait for the read loop that starts at admission.
	ws_handshake_pipelining: true,
	// axum sends a refused upgrade's response as built, body included.
	ws_refusal_body: true
});

/** Bootstrap block built from the default secrets + supplied paths. */
const build_default_bootstrap = (
	paths: TestBackendPaths,
	overrides?: Partial<BackendBootstrapConfig>
): BackendBootstrapConfig => ({
	token_path: paths.bootstrap_token_path,
	token: default_test_bootstrap_token,
	username: default_test_keeper_username,
	password: default_test_keeper_password,
	daemon_token_path: paths.daemon_token_path,
	...overrides
});

export interface MakeDefaultTsBackendConfigOptions {
	/** Diagnostic label; also used as the tmpdir prefix when `paths` is omitted. */
	readonly name: string;
	/** TCP port the binary listens on. */
	readonly port: number;
	/** argv passed to the spawn (first entry is the binary). */
	readonly start_command: ReadonlyArray<string>;
	/** Defaults to `'memory://'` (in-memory pglet). */
	readonly database_url?: string;
	/** Merged on top of the generic env baseline; later keys win. */
	readonly extra_env?: Readonly<Record<string, string>>;
	/**
	 * Every capability, stated: spread `ts_default_capabilities` and add each
	 * `MountFlag`. Required, so a mount flag left out is a type error rather
	 * than a suite that silently skips.
	 */
	readonly capabilities: BackendCapabilities;
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
	/**
	 * Env var naming the directory the binary writes its daemon token under
	 * (`{dir}/run/daemon_token`), e.g. `'MY_APP_DAEMON_TOKEN_DIR'`. Given, it
	 * is set to the directory that layout puts the token at the bootstrap's
	 * `daemon_token_path` (`to_daemon_token_dir`) — the file `spawn_backend`
	 * reads — and a path in another layout throws. Omit it for a binary that
	 * derives the path otherwise.
	 */
	readonly daemon_token_dir_env?: string;
}

/**
 * Shared builder for TS-family backends (Deno + Node). Owns the common
 * env baseline (NODE_ENV, HOST, PORT, in-memory pglet, cookie keys,
 * bootstrap token path) so per-backend factories only declare what
 * genuinely differs.
 */
export const make_default_ts_backend_config = (
	opts: MakeDefaultTsBackendConfigOptions
): BackendConfig => {
	const {
		name,
		port,
		start_command,
		database_url = 'memory://',
		extra_env,
		capabilities,
		paths = build_test_backend_paths(name),
		bootstrap_overrides,
		port_env_var = 'PORT',
		cookie_name = 'fuz_session',
		daemon_token_dir_env
	} = opts;
	const bootstrap = build_default_bootstrap(paths, bootstrap_overrides);
	return {
		name,
		start_command,
		base_url: `http://localhost:${port}`,
		rpc_path: SPINE_RPC_PATH,
		ws_path: SPINE_WS_PATH,
		health_path: '/health',
		bootstrap_path: SPINE_ACCOUNT_BOOTSTRAP_PATH,
		cookie_name,
		startup_timeout_ms: 30_000,
		env: {
			NODE_ENV: 'development',
			HOST: DEFAULT_TEST_BACKEND_HOST,
			[port_env_var]: String(port),
			DATABASE_URL: database_url,
			SECRET_FUZ_COOKIE_KEYS: default_test_cookie_keys,
			FUZ_ALLOWED_ORIGINS: 'http://localhost:*',
			FUZ_BOOTSTRAP_TOKEN_PATH: paths.bootstrap_token_path,
			...daemon_token_dir_entry(daemon_token_dir_env, bootstrap),
			...extra_env
		},
		bootstrap,
		capabilities
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
	 * Required — Rust needs real Postgres (an in-process WASM database isn't reachable from
	 * `tokio-postgres`). Consumers typically supply
	 * `'postgres://localhost/{repo}_test_{name}'`.
	 */
	readonly database_url: string;
	/** Merged on top of the generic env baseline; later keys win. */
	readonly extra_env?: Readonly<Record<string, string>>;
	/**
	 * Every capability, stated: spread `rust_default_capabilities` and add each
	 * `MountFlag`. Required, so a mount flag left out is a type error rather
	 * than a suite that silently skips.
	 */
	readonly capabilities: BackendCapabilities;
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
	/**
	 * Env var naming the directory the binary writes its daemon token under
	 * (`{dir}/run/daemon_token`), e.g. `'MY_APP_DAEMON_TOKEN_DIR'`. Given, it
	 * is set to the directory that layout puts the token at the bootstrap's
	 * `daemon_token_path` (`to_daemon_token_dir`) — the file `spawn_backend`
	 * reads — and a path in another layout throws. Omit it for a binary that
	 * derives the path otherwise.
	 */
	readonly daemon_token_dir_env?: string;
}

/**
 * Shared builder for Rust-family backends. Owns the common env baseline
 * (RUST_LOG, HOST, port, real Postgres, cookie keys, bootstrap token
 * path, the `FUZ_TESTING_RESET_DB_ON_STARTUP=true` self-wipe gate) plus
 * the 120s startup window for cargo's first-run build cost.
 */
export const make_default_rust_backend_config = (
	opts: MakeDefaultRustBackendConfigOptions
): BackendConfig => {
	const {
		name,
		port,
		start_command,
		database_url,
		extra_env,
		capabilities,
		paths = build_test_backend_paths(name),
		bootstrap_overrides,
		port_env_var = 'PORT',
		rust_log = 'info',
		cookie_name = 'fuz_session',
		daemon_token_dir_env
	} = opts;
	const bootstrap = build_default_bootstrap(paths, bootstrap_overrides);
	return {
		name,
		start_command,
		base_url: `http://localhost:${port}`,
		rpc_path: SPINE_RPC_PATH,
		ws_path: SPINE_WS_PATH,
		health_path: '/health',
		bootstrap_path: SPINE_ACCOUNT_BOOTSTRAP_PATH,
		cookie_name,
		startup_timeout_ms: 120_000,
		env: {
			RUST_LOG: rust_log,
			HOST: DEFAULT_TEST_BACKEND_HOST,
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
			...daemon_token_dir_entry(daemon_token_dir_env, bootstrap),
			...extra_env
		},
		bootstrap,
		capabilities
	};
};
