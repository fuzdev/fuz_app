import '../assert_dev_env.js';

/**
 * Per-backend filesystem layout under `os.tmpdir()` for cross-process
 * tests.
 *
 * Isolation matters because vitest projects can run in parallel — a
 * shared `root` would mix daemon tokens across concurrently-running
 * backends. Each backend gets its own subtree via the `prefix` arg
 * (typically the `BackendConfig.name`).
 *
 * Consumers compose: take the generic paths from
 * `build_test_backend_paths(name)`, add domain-specific dirs (e.g.
 * `zzz_dir`, `scoped_dir`) under the returned `root`.
 *
 * @module
 */

import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * Generic per-backend paths every cross-process test binary needs.
 * Consumers extend this with their own domain paths.
 *
 * - `root` — the per-backend subtree under `os.tmpdir()`. Compose
 *   consumer-specific paths under here.
 * - `bootstrap_token_path` — `FUZ_BOOTSTRAP_TOKEN_PATH`; harness writes
 *   the bootstrap token here before spawn.
 * - `daemon_token_path` — where `init_daemon_token` (Rust) and the TS
 *   server's daemon-token writer land the token (under `{root}/run/`).
 */
export interface TestBackendPaths {
	readonly root: string;
	readonly bootstrap_token_path: string;
	readonly daemon_token_path: string;
}

/**
 * Build the generic path layout for a cross-process test backend.
 * `prefix` is typically the `BackendConfig.name` (e.g. `'deno'`,
 * `'rust'`, `'spine_stub'`).
 */
export const build_test_backend_paths = (prefix: string): TestBackendPaths => {
	const root = join(tmpdir(), prefix);
	return {
		root,
		bootstrap_token_path: join(root, 'bootstrap_token'),
		// `init_daemon_token` (Rust) and the TS server's daemon-token
		// writer both land the token at `{root}/run/daemon_token`.
		daemon_token_path: join(root, 'run', 'daemon_token'),
	};
};
