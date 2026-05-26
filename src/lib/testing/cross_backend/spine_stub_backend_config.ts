import '../assert_dev_env.js';

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
 * path in. `FUZ_TESTING_SPINE_STUB_BIN` (or the `binary_path` option) must
 * point at a prebuilt binary; the preset throws a clear error when neither
 * is set rather than guessing. Build once with
 * `cargo build -p testing_spine_stub --release` and point the env var at
 * the resulting `target/release/testing_spine_stub`; operators / CI cache
 * the binary across runs for fast spawns.
 *
 * **Operator setup** — the target Postgres database must exist before the
 * harness runs (the harness never issues `CREATE DATABASE`, to avoid
 * forcing a `CREATEDB` grant on the test role):
 *
 * ```bash
 * createdb fuz_app_test_spine_stub 2>/dev/null || true
 * ```
 *
 * The binary self-wipes the auth-namespace schema on every boot
 * (`FUZ_TESTING_RESET_DB_ON_STARTUP=true`, set by the Rust-family builder),
 * so no manual `DROP TABLE` between sessions is needed; per-test reset is
 * the orthogonal `_testing_reset` RPC action `default_cross_process_setup`
 * fires.
 *
 * @module
 */

import type {BackendConfig} from './backend_config.js';
import {build_test_backend_paths} from './build_test_backend_paths.js';
import {make_default_rust_backend_config} from './default_backend_configs.js';

/** Env var naming the prebuilt `testing_spine_stub` binary. Required when `binary_path` is omitted. */
export const SPINE_STUB_BIN_ENV = 'FUZ_TESTING_SPINE_STUB_BIN';

/** Default listening port — slots beside zzz's 1175/1176; matches the binary's `DEFAULT_PORT`. */
export const SPINE_STUB_DEFAULT_PORT = 1177;

/** Default Postgres database — real PG (PGlite isn't reachable from `tokio-postgres`). */
export const SPINE_STUB_DEFAULT_DATABASE_URL = 'postgres://localhost/fuz_app_test_spine_stub';

export interface SpineStubBackendConfigOptions {
	/** Listening port. Default `SPINE_STUB_DEFAULT_PORT`. */
	readonly port?: number;
	/** Postgres connection URL. Default `SPINE_STUB_DEFAULT_DATABASE_URL`. */
	readonly database_url?: string;
	/**
	 * Prebuilt binary path. Overrides the `FUZ_TESTING_SPINE_STUB_BIN` env
	 * var. When neither is set the preset throws.
	 */
	readonly binary_path?: string;
}

/**
 * Build the `BackendConfig` for `testing_spine_stub`. Resolves the binary
 * from `options.binary_path` or `FUZ_TESTING_SPINE_STUB_BIN`; throws when
 * neither is set so a missing build surfaces as a clear error rather than
 * a confusing spawn failure. Reconciles the binary's env contract: port
 * via `--port` (and `FUZ_SPINE_STUB_PORT`), daemon-token dir via
 * `FUZ_SPINE_STUB_DIR` (anchored to `paths.root` so the written
 * `{dir}/run/daemon_token` matches the path `spawn_backend` reads).
 *
 * @throws Error when no binary path is available.
 */
export const spine_stub_backend_config = (
	options: SpineStubBackendConfigOptions = {},
): BackendConfig => {
	const {
		port = SPINE_STUB_DEFAULT_PORT,
		database_url = SPINE_STUB_DEFAULT_DATABASE_URL,
		binary_path = process.env[SPINE_STUB_BIN_ENV],
	} = options;
	if (!binary_path) {
		throw new Error(
			`spine_stub_backend_config: no binary path — set ${SPINE_STUB_BIN_ENV} to a prebuilt ` +
				'`testing_spine_stub` binary (build it with `cargo build -p testing_spine_stub --release`) ' +
				'or pass `binary_path`.',
		);
	}
	const name = 'spine_stub';
	const paths = build_test_backend_paths(name);
	return make_default_rust_backend_config({
		name,
		port,
		// `--port` is the binary's authoritative port input; the
		// `FUZ_SPINE_STUB_PORT` env the builder also sets (via `port_env_var`)
		// is the lower-precedence fallback — both carry the same value.
		start_command: [binary_path, '--port', String(port)],
		database_url,
		port_env_var: 'FUZ_SPINE_STUB_PORT',
		rust_log: 'info,testing_spine_stub=info',
		paths,
		extra_env: {
			// The binary writes its daemon-token JSON to
			// `{FUZ_SPINE_STUB_DIR}/run/daemon_token`; anchoring the dir to
			// `paths.root` makes that equal `paths.daemon_token_path`, which
			// `spawn_backend` reads after the health probe.
			FUZ_SPINE_STUB_DIR: paths.root,
		},
	});
};
