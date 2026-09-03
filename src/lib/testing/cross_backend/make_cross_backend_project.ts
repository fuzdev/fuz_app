/**
 * Generic vitest project factory for cross-backend integration suites.
 *
 * One vitest project per spawned backend; each runs the consumer's shared
 * `*.cross.test.ts` files against its own bootstrapped binary. The paired
 * `create_cross_backend_global_setup` (in `global_setup.ts`) reads the
 * project's `name` to pick which `BackendConfig` to spawn, so the project
 * name is the single source of truth for backend selection.
 *
 * Consumers compose these into their `vite.config.ts`:
 *
 * ```ts
 * const cross_backend_projects = process.env.FUZ_TEST_CROSS_BACKEND
 *   ? [
 *       make_cross_backend_project({name: 'cross_backend_ts_deno', global_setup: GLOBAL_SETUP}),
 *       make_cross_backend_project({name: 'cross_backend_rust', global_setup: GLOBAL_SETUP}),
 *     ]
 *   : [];
 * ```
 *
 * where `GLOBAL_SETUP = './src/test/cross_backend/global_setup.ts'`.
 *
 * This module is intentionally dependency-free and `assert_dev_env`-free:
 * it runs at vite **config** time (including production builds, where the
 * consumer gates the projects behind an env flag), so it must not pull in
 * the DEV-only test runtime.
 *
 * @module
 */

/** Default test-file globs — the convention is `src/test/cross_backend/*.cross.test.ts`. */
const DEFAULT_INCLUDE: ReadonlyArray<string> = ['src/test/cross_backend/*.cross.test.ts'];

/** vitest `sequence.groupOrder` for cross-backend projects — after unit (1) + db (2). */
const DEFAULT_GROUP_ORDER = 3;

/**
 * Per-test timeout (ms). vitest's 5 s default is far too tight here: a
 * cross-backend case talks to a spawned backend over a real socket and most
 * begin with a full `_testing_reset` (truncate + reseed the auth tables,
 * mint a session), which alone can outlast 5 s on a cold pool or a loaded
 * machine. 30 s is the ecosystem's convention for backend-spawning suites —
 * long enough that no honest case flakes, short enough that a hung socket
 * still fails the run rather than stalling CI.
 */
const DEFAULT_TEST_TIMEOUT = 30_000;

/**
 * Per-hook timeout (ms). `beforeAll` / `afterAll` in these suites do the
 * heaviest work in the project — bootstrap fixtures, seeded accounts, file
 * uploads — so hooks get the same 30 s budget as tests rather than vitest's
 * 10 s default.
 */
const DEFAULT_HOOK_TIMEOUT = 30_000;

export interface CrossBackendProjectOptions {
	/**
	 * vitest project name. `create_cross_backend_global_setup` derives the
	 * backend name from it (by default stripping a `cross_backend_(ts_)?`
	 * prefix), so name projects `cross_backend_<backend>` (e.g.
	 * `cross_backend_rust`, `cross_backend_ts_deno`).
	 */
	readonly name: string;
	/**
	 * Path to the consumer's vitest `globalSetup` module, relative to the
	 * consumer repo root (e.g. `'./src/test/cross_backend/global_setup.ts'`).
	 * That module is expected to export a `create_cross_backend_global_setup`
	 * result as its default.
	 */
	readonly global_setup: string;
	/** Test-file globs. Default: `['src/test/cross_backend/*.cross.test.ts']`. */
	readonly include?: ReadonlyArray<string>;
	/** Globs to exclude from `include` (e.g. a backend-specific variant file). Default: `[]`. */
	readonly exclude?: ReadonlyArray<string>;
	/** vitest `sequence.groupOrder`. Default: `3` (runs after unit + db). */
	readonly group_order?: number;
	/**
	 * Per-test timeout in ms. Default: `30_000` — see `DEFAULT_TEST_TIMEOUT`
	 * for why the 5 s vitest default does not fit a spawned-backend suite.
	 * Always emitted, so a consumer's root `testTimeout` never leaks in.
	 */
	readonly test_timeout?: number;
	/**
	 * Per-hook timeout in ms for `beforeAll` / `afterAll` etc. Default:
	 * `30_000`. Always emitted, so a consumer's root `hookTimeout` never
	 * leaks in.
	 */
	readonly hook_timeout?: number;
}

/**
 * Build a single cross-backend vitest project config. Spread the results
 * into `test.projects` in the consumer's `vite.config.ts`. `isolate: false`
 * + `fileParallelism: false` because a project shares one spawned backend
 * across its files, and `testTimeout` / `hookTimeout` are always emitted so
 * a spawned-backend case is never held to vitest's 5 s / 10 s defaults.
 */
export const make_cross_backend_project = ({
	name,
	global_setup,
	include = DEFAULT_INCLUDE,
	exclude = [],
	group_order = DEFAULT_GROUP_ORDER,
	test_timeout = DEFAULT_TEST_TIMEOUT,
	hook_timeout = DEFAULT_HOOK_TIMEOUT
}: CrossBackendProjectOptions): {
	extends: true;
	test: {
		name: string;
		include: Array<string>;
		exclude: Array<string>;
		globalSetup: Array<string>;
		isolate: false;
		fileParallelism: false;
		sequence: { groupOrder: number };
		testTimeout: number;
		hookTimeout: number;
	};
} => ({
	extends: true,
	test: {
		name,
		include: [...include],
		exclude: [...exclude],
		globalSetup: [global_setup],
		isolate: false,
		fileParallelism: false,
		sequence: { groupOrder: group_order },
		testTimeout: test_timeout,
		hookTimeout: hook_timeout
	}
});
