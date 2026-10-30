import '../assert_dev_env.ts';

/**
 * Cross-process `BackendConfig` preset for the non-domain spine consumer,
 * `testing_spine_stub` — a Rust binary that mounts only the spine surface
 * (auth / account / admin / audit / role-grant offers) with no domain
 * layer. fuz_app drives it from `src/test/cross_backend/*.cross.test.ts`
 * to verify its TS spec against the Rust spine end-to-end with no domain
 * implementation in the loop — drift becomes a fuz_app failure rather than
 * a downstream consumer's failure with mixed signals.
 *
 * **Binary discovery — env-supplied, never hardcoded.** The binary lives
 * in a sibling Rust workspace, not in fuz_app, so the preset never bakes a
 * path in. `FUZ_TESTING_RUST_SPINE_STUB_BIN` (or the `binary_path` option) must
 * point at a prebuilt binary; the preset throws a clear error when neither
 * is set rather than guessing. Build once with
 * `cargo build -p testing_spine_stub --profile cross-test` (the workspace's
 * non-LTO test profile; `--release` works too, slower to rebuild) and point
 * the env var at the resulting `target/cross-test/testing_spine_stub`;
 * operators / CI cache the binary across runs for fast spawns.
 *
 * **Operator setup** — the target Postgres database must exist before the
 * stub boots. The harness creates it only when a setup asks
 * (`ensure_database_for_url`, or `create_cross_backend_global_setup`'s
 * `ensure_databases`), so a test role needs no `CREATEDB` grant otherwise.
 *
 * `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` points the stub at another
 * server (e.g. a scratch cluster on a spare port).
 *
 * The binary self-wipes the auth-namespace schema on every boot
 * (`FUZ_TESTING_RESET_DB_ON_STARTUP=true`, set by the Rust-family builder),
 * so no manual `DROP TABLE` between sessions is needed; per-test reset is
 * the orthogonal `_testing_reset` RPC action `default_cross_process_setup`
 * fires.
 *
 * @module
 */

import { fileURLToPath } from 'node:url';

import type { BackendConfig } from './backend_config.ts';
import type { BackendCapabilities } from './capabilities.ts';
import { default_test_backend_paths } from './build_test_backend_paths.ts';
import {
	LOGIN_RATE_LIMIT_ENABLED_ENV,
	SPINE_EXPECTED_SCHEMA_URL,
	TESTING_BACKDOOR_METHODS
} from './spine_surface_constants.ts';
import {
	action_rate_limit_env,
	make_default_rust_backend_config,
	rust_default_capabilities,
	timing_env
} from './default_backend_configs.ts';

/** Env var naming the prebuilt `testing_spine_stub` binary. Required when `binary_path` is omitted. */
export const RUST_SPINE_STUB_BIN_ENV = 'FUZ_TESTING_RUST_SPINE_STUB_BIN';

/**
 * Env var overriding the stub's Postgres URL when `database_url` is omitted —
 * e.g. a scratch cluster on a spare port, keeping the run off the machine's
 * default server. A runner that creates the stub's database before the spawn
 * must create the one this URL names, on the server it names.
 */
export const RUST_SPINE_STUB_DATABASE_URL_ENV = 'FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL';

/**
 * Env var the stub reads for the absolute path of the committed
 * `expected_schema.json` its `/ready` gate introspects against. Pointed at the
 * **same** fixture the TS spine reads (`SPINE_EXPECTED_SCHEMA_URL`) —
 * column-presence is engine-portable, so one file is the cross-impl contract.
 */
export const RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH_ENV = 'FUZ_RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH';

/**
 * Capabilities for the Rust `testing_spine_stub` — `rust_default_capabilities`
 * with every `MountFlag` stated, all `true`: `ws` (it mounts `/api/ws`), `peer_request` (its registry carries
 * `peer/ping` on both transports), `cell_crud` + `cell_relations` (it mounts the
 * full cell surface over the `fuz_cell` namespace), `fact_serving` (the
 * cell-gated serve route, the `fuz_facts` namespace and `_testing_put_fact`),
 * `fact_serving_admin_hash` (the admin bare-hash route), `sse` (the stub serves `GET /api/admin/audit/stream` over the spine
 * `fuz_realtime::SseRegistry` + audit listener), `ready` (it live-mounts
 * `/ready` over the env-supplied fixture path), `ws_account_actions` (it
 * serves one action registry on `/api/rpc` and `/api/ws`), `cell_gated_create`
 * (it mounts the `TestCellGatedCreateAuthorize` policy on its cell layer), and
 * `ws_role_gated` (it mounts the role-gated WS endpoint at
 * `SPINE_ROLE_GATED_WS_PATH`, sharing its connection registry), and every
 * `TESTING_BACKDOOR_METHODS` entry as `testing_backdoors` (it mounts them all,
 * on one registry for both transports). Named
 * (not inline) so every spine preset is greppable, mirroring
 * `ts_spine_capabilities`.
 */
const rust_spine_stub_capabilities: BackendCapabilities = Object.freeze({
	...rust_default_capabilities,
	ws: true,
	peer_request: true,
	sse: true,
	cell_crud: true,
	cell_relations: true,
	fact_serving: true,
	fact_serving_admin_hash: true,
	ready: true,
	ws_account_actions: true,
	cell_gated_create: true,
	ws_role_gated: true,
	testing_backdoors: TESTING_BACKDOOR_METHODS
});

/** Default listening port — slots beside zzz's 1175/1176; matches the binary's `DEFAULT_PORT`. */
export const RUST_SPINE_STUB_DEFAULT_PORT = 1177;

/** The preset's default backend name — its spawn label and temp directory. */
export const RUST_SPINE_STUB_DEFAULT_NAME = 'spine_stub';

/** Default Postgres database — real PG (PGlite isn't reachable from `tokio-postgres`). */
export const RUST_SPINE_STUB_DEFAULT_DATABASE_URL =
	'postgres://localhost/fuz_app_test_rust_spine_stub';

export interface SpineStubBackendConfigOptions {
	/** Listening port. Default `RUST_SPINE_STUB_DEFAULT_PORT`. */
	readonly port?: number;
	/**
	 * Postgres connection URL. Default `$FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL`,
	 * then `RUST_SPINE_STUB_DEFAULT_DATABASE_URL`.
	 */
	readonly database_url?: string;
	/**
	 * Backend name — labels the spawn in errors and logs, and names its
	 * directory under `os.tmpdir()` (`default_test_backend_paths`, namespaced
	 * by the running repo), which holds
	 * the bootstrap token, the daemon token and the fact store. Default
	 * `RUST_SPINE_STUB_DEFAULT_NAME`. Give each stub spawned alongside another its own name, so
	 * those files don't collide.
	 */
	readonly name?: string;
	/**
	 * Prebuilt binary path. Overrides the `FUZ_TESTING_RUST_SPINE_STUB_BIN` env
	 * var. When neither is set the preset throws.
	 */
	readonly binary_path?: string;
	/**
	 * Enable the per-IP + per-account login rate limiters on the stub
	 * (`FUZ_LOGIN_RATE_LIMIT_ENABLED=true`). Off by default — the standard cross
	 * suites fire many loopback logins a live limiter would 429. Set `true` only
	 * for the dedicated login-security cross project (`global_setup_login_security.ts`).
	 * Pair with `trusted_proxies` so the limiter keys on the resolved
	 * `X-Forwarded-For` client IP. Mirrors `TsSpineBackendConfigOptions.enable_login_rate_limit`.
	 */
	readonly enable_login_rate_limit?: boolean;
	/**
	 * Comma-separated trusted-proxy allowlist passed as `FUZ_TRUSTED_PROXIES`
	 * (e.g. `'127.0.0.1,::1'`). Unset, the stub trusts the loopback set
	 * (`127.0.0.1`, `::1`), as the TS spine binary does unconditionally, so a
	 * loopback caller's `X-Forwarded-For` names the client; `','` trusts none.
	 * The login-security project passes the loopback set explicitly.
	 */
	readonly trusted_proxies?: string;
	/**
	 * Enable the action rate limiters (`FUZ_ACTION_RATE_LIMIT_ENABLED=true`) —
	 * one per-IP and one per-account limiter shared by the RPC and WS
	 * endpoints. Off by default, like `enable_login_rate_limit`; set only for
	 * the dedicated security cross project, which drives them through
	 * `ws_action_rate_limit.ts`. Mirrors `TsSpineBackendConfigOptions.enable_action_rate_limit`.
	 */
	readonly enable_action_rate_limit?: boolean;
	/**
	 * Replace both action limiters' `max_attempts`
	 * (`FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`) so a suite reaches the cap in a few
	 * calls. Requires `enable_action_rate_limit` — the binary refuses to boot
	 * otherwise. Mirrors `TsSpineBackendConfigOptions.action_rate_limit_max_attempts`.
	 */
	readonly action_rate_limit_max_attempts?: number;
	/**
	 * Replace the audit stream's keep-alive interval
	 * (`FUZ_AUDIT_SSE_KEEP_ALIVE_MS`). Mirrors
	 * `TsSpineBackendConfigOptions.audit_sse_keep_alive_ms`.
	 */
	readonly audit_sse_keep_alive_ms?: number;
	/**
	 * Replace the WS endpoints' receive timeout (`FUZ_WS_RECEIVE_TIMEOUT_MS`).
	 * Mirrors `TsSpineBackendConfigOptions.ws_receive_timeout_ms`.
	 */
	readonly ws_receive_timeout_ms?: number;
	/**
	 * Replace the request pool checkout bound (`FUZ_DB_CHECKOUT_TIMEOUT_MS`).
	 * Mirrors `TsSpineBackendConfigOptions.db_checkout_timeout_ms`.
	 */
	readonly db_checkout_timeout_ms?: number;
	/**
	 * Replace the audit write pool checkout bound
	 * (`FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`). Mirrors
	 * `TsSpineBackendConfigOptions.db_audit_checkout_timeout_ms`.
	 */
	readonly db_audit_checkout_timeout_ms?: number;
}

/**
 * Build the `BackendConfig` for `testing_spine_stub`. Resolves the binary
 * from `options.binary_path` or `FUZ_TESTING_RUST_SPINE_STUB_BIN`; throws when
 * neither is set so a missing build surfaces as a clear error rather than
 * a confusing spawn failure. Reconciles the binary's env contract: port
 * via `--port` (and `FUZ_RUST_SPINE_STUB_PORT`), daemon-token dir via
 * `FUZ_RUST_SPINE_STUB_DIR` (anchored to `paths.root` so the written
 * `{dir}/run/daemon_token` matches the path `spawn_backend` reads).
 *
 * @throws Error when no binary path is available.
 */
export const rust_spine_stub_backend_config = (
	options: SpineStubBackendConfigOptions = {}
): BackendConfig => {
	const {
		port = RUST_SPINE_STUB_DEFAULT_PORT,
		database_url = process.env[RUST_SPINE_STUB_DATABASE_URL_ENV] ||
			RUST_SPINE_STUB_DEFAULT_DATABASE_URL,
		binary_path = process.env[RUST_SPINE_STUB_BIN_ENV],
		enable_login_rate_limit,
		trusted_proxies,
		name = RUST_SPINE_STUB_DEFAULT_NAME
	} = options;
	if (!binary_path) {
		throw new Error(
			`rust_spine_stub_backend_config: no binary path — set ${
				RUST_SPINE_STUB_BIN_ENV
			} to a prebuilt ` +
				'`testing_spine_stub` binary (build it with `cargo build -p testing_spine_stub --profile cross-test`) ' +
				'or pass `binary_path`.'
		);
	}
	const paths = default_test_backend_paths(name);
	return make_default_rust_backend_config({
		name,
		port,
		// `--port` is the binary's authoritative port input; the
		// `FUZ_RUST_SPINE_STUB_PORT` env the builder also sets (via `port_env_var`)
		// is the lower-precedence fallback — both carry the same value.
		start_command: [binary_path, '--port', String(port)],
		database_url,
		capabilities: rust_spine_stub_capabilities,
		port_env_var: 'FUZ_RUST_SPINE_STUB_PORT',
		rust_log: 'info,testing_spine_stub=info',
		paths,
		// The binary writes its daemon-token JSON to
		// `{FUZ_RUST_SPINE_STUB_DIR}/run/daemon_token`; the builder anchors the
		// dir to `paths.root`, which makes that `paths.daemon_token_path`, the
		// file `spawn_backend` reads after the health probe.
		daemon_token_dir_env: 'FUZ_RUST_SPINE_STUB_DIR',
		extra_env: {
			// Absolute path to the committed spine `expected_schema.json` — the
			// stub's `/ready` gate introspects the live DB against it. The SAME
			// file the TS spine reads, so the two backends share one cross-impl
			// contract.
			[RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH_ENV]: fileURLToPath(SPINE_EXPECTED_SCHEMA_URL),
			// Login-security project opt-ins (off by default): enable the login
			// limiters + trust the loopback proxy so the limiter keys on the
			// resolved `X-Forwarded-For` IP. The stub reads both directly.
			...(enable_login_rate_limit ? { [LOGIN_RATE_LIMIT_ENABLED_ENV]: 'true' } : {}),
			...(trusted_proxies !== undefined ? { FUZ_TRUSTED_PROXIES: trusted_proxies } : {}),
			...action_rate_limit_env(options),
			...timing_env(options)
		}
	});
};
