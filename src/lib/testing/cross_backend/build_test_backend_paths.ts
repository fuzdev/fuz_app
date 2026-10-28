import '../assert_dev_env.ts';

/**
 * Per-backend filesystem layout under `os.tmpdir()` for cross-process
 * tests.
 *
 * Isolation matters because vitest projects can run in parallel, and other
 * repos' cross runs on the same machine share `os.tmpdir()` — a shared
 * `root` would mix bootstrap and daemon tokens across concurrently-running
 * backends. Each backend gets its own subtree: `default_test_backend_paths`
 * (what the default builders use) names it after the running repo's
 * directory plus the backend name, so two repos that both name a backend
 * `'rust'` don't collide; `build_test_backend_paths` takes an explicit,
 * already-unique prefix.
 *
 * Consumers compose: take the generic paths from either builder and add
 * domain-specific dirs (e.g. `zzz_dir`, `scoped_dir`) under the returned
 * `root`.
 *
 * @module
 */

import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Generic per-backend paths every cross-process test binary needs.
 * Consumers extend this with their own domain paths.
 *
 * - `root` — the per-backend subtree under `os.tmpdir()`. Compose
 *   consumer-specific paths under here.
 * - `bootstrap_token_path` — `FUZ_BOOTSTRAP_TOKEN_PATH`; harness writes
 *   the bootstrap token here before spawn.
 * - `daemon_token_path` — where `init_daemon_token` (Rust) and the TS
 *   server's daemon-token writer land the token (under `{root}/run/`);
 *   `spawn_backend` deletes it before each spawn, so a token a previous run
 *   left is never read.
 */
export interface TestBackendPaths {
	readonly root: string;
	readonly bootstrap_token_path: string;
	readonly daemon_token_path: string;
}

/**
 * Build the generic path layout for a cross-process test backend under
 * `os.tmpdir()/<prefix>`. `prefix` must be unique across every repo that
 * runs cross tests on the machine (e.g. `'my_app_cross_rust'`); for a
 * default derived from the backend name, use `default_test_backend_paths`.
 */
export const build_test_backend_paths = (prefix: string): TestBackendPaths => {
	const root = join(tmpdir(), prefix);
	return {
		root,
		bootstrap_token_path: join(root, 'bootstrap_token'),
		// `init_daemon_token` (Rust) and the TS server's daemon-token
		// writer both land the token at `{root}/run/daemon_token`.
		daemon_token_path: join(root, 'run', 'daemon_token')
	};
};

/**
 * The default per-backend tmpdir prefix: the running repo's directory name
 * (`process.cwd()`'s basename — so run the tests from the repo root) plus the
 * backend `name`, so the same backend name in two repos (`'rust'` in each)
 * lands in two directories.
 *
 * @param name - the backend name (`BackendConfig.name`)
 * @returns the prefix `default_test_backend_paths` passes to `build_test_backend_paths`
 */
export const default_test_backend_prefix = (name: string): string =>
	`${basename(process.cwd())}_${name}`;

/**
 * The generic path layout under the default, repo-namespaced prefix
 * (`default_test_backend_prefix`) — what the default backend builders use
 * when given no `paths`.
 *
 * @param name - the backend name (`BackendConfig.name`)
 */
export const default_test_backend_paths = (name: string): TestBackendPaths =>
	build_test_backend_paths(default_test_backend_prefix(name));
