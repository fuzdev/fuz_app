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
 * `cargo build -p testing_spine_stub --release` and point the env var at
 * the resulting `target/release/testing_spine_stub`; operators / CI cache
 * the binary across runs for fast spawns.
 *
 * **Operator setup** — the target Postgres database must exist before the
 * harness runs (the harness never issues `CREATE DATABASE`, to avoid
 * forcing a `CREATEDB` grant on the test role):
 *
 * ```bash
 * createdb fuz_app_test_rust_spine_stub 2>/dev/null || true
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

import { fileURLToPath } from 'node:url';

import type { BackendConfig } from './backend_config.ts';
import { build_test_backend_paths } from './build_test_backend_paths.ts';
import { SPINE_EXPECTED_SCHEMA_URL } from './spine_surface_constants.ts';
import {
	LOGIN_RATE_LIMIT_ENABLED_ENV,
	make_default_rust_backend_config,
	rust_default_capabilities
} from './default_backend_configs.ts';

/** Env var naming the prebuilt `testing_spine_stub` binary. Required when `binary_path` is omitted. */
export const RUST_SPINE_STUB_BIN_ENV = 'FUZ_TESTING_RUST_SPINE_STUB_BIN';

/**
 * Env var the stub reads for the absolute path of the committed
 * `expected_schema.json` its `/ready` gate introspects against. Pointed at the
 * **same** fixture the TS spine reads ({@link SPINE_EXPECTED_SCHEMA_URL}) —
 * column-presence is engine-portable, so one file is the cross-impl contract.
 */
export const RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH_ENV = 'FUZ_RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH';

/**
 * Capabilities for the Rust `testing_spine_stub` — `rust_default_capabilities`
 * plus `sse` (the stub serves `GET /api/admin/audit/stream` over the spine
 * `fuz_realtime::SseRegistry` + audit listener), `ready` (it live-mounts
 * `/ready` over the env-supplied fixture path), and `cell_gated_create` (it
 * mounts the `TestCellGatedCreateAuthorize` policy on its cell layer). Named
 * (not inline) so every spine preset is greppable, mirroring
 * `ts_spine_capabilities`.
 */
const rust_spine_stub_capabilities = Object.freeze({
	...rust_default_capabilities,
	sse: true,
	ready: true,
	cell_gated_create: true
});

/** Default listening port — slots beside zzz's 1175/1176; matches the binary's `DEFAULT_PORT`. */
export const RUST_SPINE_STUB_DEFAULT_PORT = 1177;

/** Default Postgres database — real PG (PGlite isn't reachable from `tokio-postgres`). */
export const RUST_SPINE_STUB_DEFAULT_DATABASE_URL =
	'postgres://localhost/fuz_app_test_rust_spine_stub';

export interface SpineStubBackendConfigOptions {
	/** Listening port. Default `RUST_SPINE_STUB_DEFAULT_PORT`. */
	readonly port?: number;
	/** Postgres connection URL. Default `RUST_SPINE_STUB_DEFAULT_DATABASE_URL`. */
	readonly database_url?: string;
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
	 * (e.g. `'127.0.0.1,::1'`). Unset by default (the stub leaves XFF parsing
	 * off, keying on the raw TCP peer). The login-security project sets the
	 * loopback set so the limiter keys on the `X-Forwarded-For` client IP — the
	 * TS spine binary wires the equivalent set unconditionally.
	 */
	readonly trusted_proxies?: string;
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
		database_url = RUST_SPINE_STUB_DEFAULT_DATABASE_URL,
		binary_path = process.env[RUST_SPINE_STUB_BIN_ENV],
		enable_login_rate_limit,
		trusted_proxies
	} = options;
	if (!binary_path) {
		throw new Error(
			`rust_spine_stub_backend_config: no binary path — set ${
				RUST_SPINE_STUB_BIN_ENV
			} to a prebuilt ` +
				'`testing_spine_stub` binary (build it with `cargo build -p testing_spine_stub --release`) ' +
				'or pass `binary_path`.'
		);
	}
	const name = 'spine_stub';
	const paths = build_test_backend_paths(name);
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
		extra_env: {
			// The binary writes its daemon-token JSON to
			// `{FUZ_RUST_SPINE_STUB_DIR}/run/daemon_token`; anchoring the dir to
			// `paths.root` makes that equal `paths.daemon_token_path`, which
			// `spawn_backend` reads after the health probe.
			FUZ_RUST_SPINE_STUB_DIR: paths.root,
			// Absolute path to the committed spine `expected_schema.json` — the
			// stub's `/ready` gate introspects the live DB against it. The SAME
			// file the TS spine reads, so the two backends share one cross-impl
			// contract.
			[RUST_SPINE_STUB_EXPECTED_SCHEMA_PATH_ENV]: fileURLToPath(SPINE_EXPECTED_SCHEMA_URL),
			// Login-security project opt-ins (off by default): enable the login
			// limiters + trust the loopback proxy so the limiter keys on the
			// resolved `X-Forwarded-For` IP. The stub reads both directly.
			...(enable_login_rate_limit ? { [LOGIN_RATE_LIMIT_ENABLED_ENV]: 'true' } : {}),
			...(trusted_proxies !== undefined ? { FUZ_TRUSTED_PROXIES: trusted_proxies } : {})
		}
	});
};
