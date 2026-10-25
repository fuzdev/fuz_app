import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import adapter from '@sveltejs/adapter-static';
import { execSync } from 'node:child_process';
import { svelte_preprocess_mdz } from '@fuzdev/mdz/svelte_preprocess_mdz.ts';
import { svelte_preprocess_fuz_code } from '@fuzdev/fuz_code/svelte_preprocess_fuz_code.ts';
import { vite_plugin_fuz_css } from '@fuzdev/fuz_css/vite_plugin_fuz_css.ts';
import svelte_docinfo from 'svelte-docinfo/vite.js';
import { vite_plugin_pkg_json } from '@fuzdev/fuz_ui/vite_plugin_pkg_json.ts';

import {
	make_cross_backend_project,
	type CrossBackendProjectOptions
} from './src/lib/testing/cross_backend/make_cross_backend_project.ts';

const max_threads = Math.max(1, Math.ceil(availableParallelism() / 2));

/**
 * The `cross_backend_*` projects each spawn one backend in their own
 * `globalSetup` and run the same `*.cross.test.ts` bodies against it, built
 * with the shipped `make_cross_backend_project` (`isolate` + `fileParallelism`
 * off so the single spawned instance is shared across files in a run, and a
 * 30 s test + hook budget in place of vitest's 5 s / 10 s defaults).
 *
 * They are **opt-in** — excluded from the default run (so a bare `gro test`
 * is just `unit` + `db`) because they spawn external backends: the TS ones
 * recursively spawn `gro run` / `deno` / `bun`, the Rust ones need a local
 * Postgres and a Cargo workspace to rebuild the stub from. Enable them with
 * `FUZ_TEST_CROSS_BACKEND=1`, then select one, e.g.:
 *
 *   FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node
 *
 * - `cross_backend_ts_node` / `cross_backend_ts_deno` / `cross_backend_ts_bun`
 *   — fuz_app's own TS impl over real HTTP, in-memory pglet, no external
 *   infra (the `ts_deno` / `ts_bun` ones need `deno` / `bun` on PATH).
 * - `cross_backend_rust_spine_stub` — Rust spine over real Postgres; its
 *   `globalSetup` rebuilds the `testing_spine_stub` binary and creates its
 *   database first (see `global_setup_helpers.ts`).
 * - `cross_backend_parity` / `cross_backend_security` — dual-spawn gates,
 *   below.
 */
const cross_backend_enabled = process.env.FUZ_TEST_CROSS_BACKEND === '1';

/** The single-backend projects' test files. */
const CROSS_BACKEND_TESTS = ['src/test/cross_backend/*.cross.test.ts'];

/**
 * The dual-spawn projects — each spawns BOTH backends in its own `globalSetup`
 * and provides two handles instead of `backend_handle`, so its files are
 * excluded from the single-backend projects (`DUAL_SPAWN_TESTS`, derived
 * here). Each runs in a later `groupOrder` and is invoked as its own script
 * (`npm run test:cross:parity` / `test:cross:security`), never alongside the
 * other Rust projects in one `vitest` run: they reuse the stub's port + DB,
 * and vitest initializes every project's `globalSetup` upfront, so two
 * port-sharing spawns can't share an invocation.
 */
const DUAL_SPAWN_PROJECTS: ReadonlyArray<CrossBackendProjectOptions> = [
	// One dual-spawn serves both parity gates: schema parity (live DDL) and
	// action-manifest parity (live RPC method set + auth).
	{
		name: 'cross_backend_parity',
		global_setup: './src/test/cross_backend/global_setup_schema_parity.ts',
		include: [
			'src/test/cross_backend/schema_parity.cross.test.ts',
			'src/test/cross_backend/action_manifest_parity.cross.test.ts'
		],
		group_order: 4
	},
	// The security gates spawn both backends with the login and action limiters
	// enabled — a config nothing else can share (the standard suites fire many
	// loopback logins and actions a live limiter would throttle).
	{
		name: 'cross_backend_security',
		global_setup: './src/test/cross_backend/global_setup_login_security.ts',
		include: [
			'src/test/cross_backend/login_security.cross.test.ts',
			'src/test/cross_backend/ws_action_rate_limit.cross.test.ts'
		],
		group_order: 5
	}
];

const DUAL_SPAWN_TESTS = DUAL_SPAWN_PROJECTS.flatMap((project) => project.include ?? []);

const single_backend_project = (name: string, global_setup: string) =>
	make_cross_backend_project({
		name,
		global_setup,
		include: CROSS_BACKEND_TESTS,
		exclude: DUAL_SPAWN_TESTS
	});

export default defineConfig({
	server: {
		// Vite watches the whole root, an inotify watch per file, and gro's `.gro/` output
		// needn't come out of the user's `max_user_watches` budget
		watch: { ignored: ['**/.gro/**'] }
	},
	plugins: [
		sveltekit({
			preprocess: [svelte_preprocess_mdz(), svelte_preprocess_fuz_code(), vitePreprocess()],
			compilerOptions: { runes: true },
			inspector: true,
			adapter: adapter(),
			paths: { relative: false }, // use root-absolute paths for SSR path comparison: https://svelte.dev/docs/kit/configuration#paths
			prerender: { handleUnseenRoutes: 'ignore' },
			version: { name: execSync('git rev-parse HEAD').toString().trim() }

			// Example CSP using https://ui.fuz.dev/docs/csp
			//
			// import {create_csp_directives} from '@fuzdev/fuz_ui/csp.ts';
			// import {csp_directives_of_fuzdev} from '@fuzdev/fuz_ui/csp_of_fuzdev.ts';
			// csp: {
			// 	directives: create_csp_directives({
			// 		extend: [csp_directives_of_fuzdev],
			// 	}),
			// },
		}),
		svelte_docinfo({ onDuplicates: 'throw' }),
		vite_plugin_fuz_css(),
		vite_plugin_pkg_json()
	],
	optimizeDeps: { exclude: ['@fuzdev/blake3-wasm'] },
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/test/**/*.test.ts'],
					// `*.cross.test.ts` run only under the `cross_backend_*` projects
					// (they need a spawned backend via `globalSetup`); `*.db.test.ts`
					// run under `db`.
					exclude: ['src/test/**/*.db.test.ts', 'src/test/**/*.cross.test.ts'],
					// refuses the default database factory, so a test that opens a
					// database without the `.db.test.ts` suffix fails loudly
					setupFiles: ['./src/test/unit_db_guard.ts'],
					maxWorkers: max_threads,
					sequence: { groupOrder: 1 }
				}
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['src/test/**/*.db.test.ts'],
					// installs the default driver `FUZ_TEST_DB_DEFAULT` selects (pglet-wasm
					// when unset); the `unit` project refuses the default factory instead
					setupFiles: ['./src/test/db_default.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: { groupOrder: 2 }
				}
			},
			...(cross_backend_enabled
				? [
						single_backend_project(
							'cross_backend_rust_spine_stub',
							'./src/test/cross_backend/global_setup.ts'
						),
						single_backend_project(
							'cross_backend_ts_node',
							'./src/test/cross_backend/global_setup_ts_node.ts'
						),
						single_backend_project(
							'cross_backend_ts_deno',
							'./src/test/cross_backend/global_setup_ts_deno.ts'
						),
						single_backend_project(
							'cross_backend_ts_bun',
							'./src/test/cross_backend/global_setup_ts_bun.ts'
						),
						...DUAL_SPAWN_PROJECTS.map(make_cross_backend_project)
					]
				: [])
		]
	}
});
