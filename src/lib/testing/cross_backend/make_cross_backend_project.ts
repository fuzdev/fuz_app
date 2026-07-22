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
}

/**
 * Build a single cross-backend vitest project config. Spread the results
 * into `test.projects` in the consumer's `vite.config.ts`. `isolate: false`
 * + `fileParallelism: false` because a project shares one spawned backend
 * across its files.
 */
export const make_cross_backend_project = ({
	name,
	global_setup,
	include = DEFAULT_INCLUDE,
	exclude = [],
	group_order = DEFAULT_GROUP_ORDER
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
		sequence: { groupOrder: group_order }
	}
});
