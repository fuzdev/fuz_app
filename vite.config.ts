import {availableParallelism} from 'node:os';
import {defineConfig} from 'vitest/config';
import {sveltekit} from '@sveltejs/kit/vite';

const max_threads = Math.max(1, Math.ceil(availableParallelism() / 2));

/**
 * The `cross_backend_*` projects each spawn one backend in their own
 * `globalSetup` and run the same `*.cross.test.ts` bodies against it
 * (`isolate` + `fileParallelism` off so the single spawned instance is
 * shared across files in a run).
 *
 * They are **opt-in** — excluded from the default run (so a bare `gro test`
 * is just `unit` + `db`) because they spawn external backends: the TS ones
 * recursively spawn `gro run` / `deno` / `bun`, the Rust one needs Postgres
 * + a prebuilt binary. Enable them with `FUZ_TEST_CROSS_BACKEND=1`, then
 * select one, e.g.:
 *
 *   FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node
 *
 * - `cross_backend_ts_node` / `cross_backend_ts_deno` / `cross_backend_ts_bun`
 *   — fuz_app's own TS impl over real HTTP, in-memory PGlite, no external
 *   infra (the `ts_deno` / `ts_bun` ones need `deno` / `bun` on PATH).
 * - `cross_backend_spine_stub` — Rust spine over real Postgres; additionally
 *   needs `FUZ_TESTING_SPINE_STUB_BIN` pointing at a prebuilt binary and a
 *   created DB (see `spine_stub_backend_config`).
 */
const cross_backend_enabled = process.env.FUZ_TEST_CROSS_BACKEND === '1';

const cross_backend_project = (name: string, global_setup: string) => ({
	extends: true as const,
	test: {
		name,
		include: ['src/test/cross_backend/*.cross.test.ts'],
		globalSetup: [global_setup],
		isolate: false,
		fileParallelism: false,
		sequence: {groupOrder: 3},
	},
});

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {exclude: ['@fuzdev/blake3_wasm']},
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
					maxWorkers: max_threads,
					sequence: {groupOrder: 1},
				},
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['src/test/**/*.db.test.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 2},
				},
			},
			...(cross_backend_enabled
				? [
						cross_backend_project(
							'cross_backend_spine_stub',
							'./src/test/cross_backend/global_setup.ts',
						),
						cross_backend_project(
							'cross_backend_ts_node',
							'./src/test/cross_backend/global_setup_ts_node.ts',
						),
						cross_backend_project(
							'cross_backend_ts_deno',
							'./src/test/cross_backend/global_setup_ts_deno.ts',
						),
						cross_backend_project(
							'cross_backend_ts_bun',
							'./src/test/cross_backend/global_setup_ts_bun.ts',
						),
					]
				: []),
		],
	},
});
