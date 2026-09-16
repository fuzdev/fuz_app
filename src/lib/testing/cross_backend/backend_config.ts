import '../assert_dev_env.ts';

/**
 * Cross-process backend configuration.
 *
 * `BackendConfig` describes a spawnable test binary — argv, mount paths,
 * env vars, bootstrap credentials, daemon-token discovery path, declared
 * capabilities. Consumer projects ship per-backend factories
 * (`deno_backend_config()`, `rust_backend_config()`,
 * `rust_spine_stub_backend_config()`) that produce this shape; `spawn_backend`
 * consumes it.
 *
 * fuz_app ships `rust_spine_stub_backend_config()` as a convenience preset
 * (operational dep on `testing_spine_stub` — path-based discovery, no
 * `package.json` coupling to the stub's source package). Otherwise backend-specific
 * knowledge (binary paths, port choices, env vars) is a consumer
 * concern; fuz_app's testing library knows nothing about Deno, Cargo, or
 * any specific runtime beyond that preset.
 *
 * @module
 */

import type { BackendCapabilities } from './capabilities.ts';

/**
 * Auth-bootstrap configuration for a spawnable test binary. The runner
 * writes `token` to `token_path` before launching the child, then POSTs
 * `bootstrap_path` (default `/api/account/bootstrap`) with the token plus
 * the `username` / `password` to mint the keeper account and capture the
 * session cookie. After health-probe, the runner reads
 * `daemon_token_path` to load the binary's deterministic daemon token,
 * which `default_cross_process_setup` threads onto the per-test
 * `TestFixture` for `_testing_reset` calls and other keeper-credential
 * operations.
 */
export interface BackendBootstrapConfig {
	/** Path the binary reads for the bootstrap token (env: `*_BOOTSTRAP_TOKEN_PATH`). */
	readonly token_path: string;
	/** Token text written to `token_path` before spawn. */
	readonly token: string;
	/** Username for the bootstrapped keeper. */
	readonly username: string;
	/** Password for the bootstrapped keeper. */
	readonly password: string;
	/**
	 * Path the test binary writes its daemon-token JSON to on boot
	 * (env: `*_DAEMON_TOKEN_PATH`). `spawn_backend` reads this file once
	 * after the health probe succeeds and threads the token onto
	 * `BackendHandle.daemon_token` for `_testing_reset` calls plus any
	 * other admin/keeper-gated cross-process tests.
	 */
	readonly daemon_token_path: string;
}

/**
 * Configuration for one spawnable test backend. Consumer factories
 * (`deno_backend_config()`, `rust_backend_config()`) produce these and
 * the runner consumes them through `spawn_backend`.
 *
 * Path defaults match the standard fuz_app surface — Deno + Rust spine
 * (`zzz_server`, `fuz_forge_server`, `testing_spine_stub`) all converge on
 * `/api/account/{bootstrap,login,logout,password}`,
 * `/api/rpc`, `/api/ws`, `/health`. Override only when a backend
 * deliberately diverges (which it shouldn't, per the contract).
 */
export interface BackendConfig {
	/** Diagnostic label (`"deno"`, `"rust"`, `"spine_stub"`). Surfaces in test output. */
	readonly name: string;
	/** argv passed to the spawn. The first entry is the binary path. */
	readonly start_command: ReadonlyArray<string>;
	/** Base URL for HTTP requests, including port (e.g. `http://localhost:8788`). */
	readonly base_url: string;
	/** JSON-RPC endpoint mount point. Default `/api/rpc`. */
	readonly rpc_path: string;
	/** WebSocket endpoint mount point. Default `/api/ws`. */
	readonly ws_path: string;
	/**
	 * SSE stream mount point — drives the cross-process SSE suite's stream
	 * path. Optional: only backends advertising `capabilities.sse` serve a
	 * stream, and the suite defaults to `/api/admin/audit/stream` (the
	 * standard fuz_app audit-log stream) when omitted. Set it only when a
	 * backend mounts its stream elsewhere.
	 */
	readonly sse_path?: string;
	/** Readiness probe path. Default `/health`. */
	readonly health_path: string;
	/** Bootstrap POST path. Default `/api/account/bootstrap`. */
	readonly bootstrap_path: string;
	/**
	 * Session cookie name the backend issues. Default `fuz_session` per
	 * the ecosystem convergence; consumers using a custom session name
	 * (legacy `zzz_session`, etc.) override. `default_cross_process_setup`
	 * extracts the per-account session value from the transport jar by
	 * this name so the cross-process `TestAccount.session_cookie` matches
	 * the in-process shape.
	 */
	readonly cookie_name: string;
	/** How long to wait for the health probe (ms) before giving up. */
	readonly startup_timeout_ms: number;
	/**
	 * Env vars merged into the child process. Must include the binary's
	 * `*_BOOTSTRAP_TOKEN_PATH` + `*_DAEMON_TOKEN_PATH` env var names so
	 * the binary reads/writes the right files. Also must include the
	 * binary's `*_ALLOWED_ORIGINS` (typically
	 * `'http://localhost:*'` for cross-process tests).
	 */
	readonly env: Readonly<Record<string, string>>;
	/** Auth bootstrap details — see `BackendBootstrapConfig`. */
	readonly bootstrap: BackendBootstrapConfig;
	/**
	 * Capabilities this backend supports — drives `test_if(capabilities.X, ...)`
	 * gating in suite bodies. See `testing/cross_backend/capabilities.ts` for the vocabulary and
	 * existing flags.
	 */
	readonly capabilities: BackendCapabilities;
}
