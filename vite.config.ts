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

import { make_cross_backend_project } from './src/lib/testing/cross_backend/make_cross_backend_project.ts';
import {
	CROSS_BACKEND_ENV,
	CROSS_BACKEND_PROJECTS
} from './src/test/cross_backend/cross_backend_projects.ts';

const max_threads = Math.max(1, Math.ceil(availableParallelism() / 2));

/**
 * The `cross_backend_*` projects (listed in
 * `src/test/cross_backend/cross_backend_projects.ts`) each spawn their
 * backends in their own `globalSetup` and run `*.cross.test.ts` bodies against
 * them, built with the shipped `make_cross_backend_project` (`isolate` +
 * `fileParallelism` off so the spawned instance is shared across files in a
 * run, and a 30 s test + hook budget in place of vitest's 5 s / 10 s
 * defaults).
 *
 * They are **opt-in** — excluded from the default run (so a bare `gro test`
 * is just `unit` + `db`) because they spawn external backends: the TS ones
 * recursively spawn `gro run` / `deno` / `bun`, the Rust ones need a local
 * Postgres and a Cargo workspace to rebuild the stub from. Enable them with
 * `FUZ_TEST_CROSS_BACKEND=1`, then select some, e.g.:
 *
 *   FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node
 *
 * Every project has its own ports, databases and temp directories, so any set
 * of them can share an invocation. They all sit in one `groupOrder`, but vitest
 * still runs them one after another: a project with `fileParallelism` off has
 * one worker, a group runs on its projects' (equal) worker count, and vitest
 * awaits each project's `globalSetup` in turn. `npm run test:cross`
 * (`src/test/cross_backend/run_cross.ts`) gets the concurrency by running each
 * project in a `vitest` invocation of its own, at once, behind one summary.
 */
const cross_backend_enabled = process.env[CROSS_BACKEND_ENV] === '1';

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
			...(cross_backend_enabled ? CROSS_BACKEND_PROJECTS.map(make_cross_backend_project) : [])
		]
	}
});
