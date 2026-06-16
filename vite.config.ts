import {availableParallelism} from 'node:os';
import {defineConfig} from 'vitest/config';
import {sveltekit} from '@sveltejs/kit/vite';
import {vite_plugin_fuz_css} from '@fuzdev/fuz_css/vite_plugin_fuz_css.js';
import svelte_docinfo from 'svelte-docinfo/vite.js';
import {vite_plugin_pkg_json} from '@fuzdev/fuz_ui/vite_plugin_pkg_json.js';

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
 * - `cross_backend_rust_spine_stub` — Rust spine over real Postgres;
 *   additionally needs `FUZ_TESTING_RUST_SPINE_STUB_BIN` pointing at a prebuilt
 *   binary and a created DB (see `rust_spine_stub_backend_config`).
 */
const cross_backend_enabled = process.env.FUZ_TEST_CROSS_BACKEND === '1';

// The parity gates spawn BOTH backends in one run (their shared `globalSetup`
// provides `parity_handle_a` + `_b`), so their test files are excluded from
// the single-backend projects — those provide only `backend_handle` — and run
// in a later groupOrder to avoid contending for the stub's port with
// `cross_backend_rust_spine_stub`. One dual-spawn serves both gates: schema
// parity (live DDL) and action-manifest parity (live RPC method set + auth).
const PARITY_TESTS = [
	'src/test/cross_backend/schema_parity.cross.test.ts',
	'src/test/cross_backend/action_manifest_parity.cross.test.ts',
];

// The login-security gate spawns BOTH backends with the login limiters enabled
// — a config nothing else can share (the standard suites fire many loopback
// logins a live limiter would 429), so it runs under its own dual-spawn project
// (`cross_backend_security`) and is excluded from the single-backend glob.
const SECURITY_TESTS = ['src/test/cross_backend/login_security.cross.test.ts'];

const cross_backend_project = (name: string, global_setup: string) => ({
	extends: true as const,
	test: {
		name,
		include: ['src/test/cross_backend/*.cross.test.ts'],
		exclude: [...PARITY_TESTS, ...SECURITY_TESTS],
		globalSetup: [global_setup],
		isolate: false,
		fileParallelism: false,
		sequence: {groupOrder: 3},
	},
});

const cross_backend_parity_project = () => ({
	extends: true as const,
	test: {
		name: 'cross_backend_parity',
		include: PARITY_TESTS,
		globalSetup: ['./src/test/cross_backend/global_setup_schema_parity.ts'],
		isolate: false,
		fileParallelism: false,
		sequence: {groupOrder: 4},
	},
});

// Dual-spawn login-security gate (TS spine + Rust stub, login limiters on).
// Reuses the parity / single-backend ports + the stub DB, so — like every cross
// project — it's invoked as its own script (`npm run test:cross:security`), never
// alongside the other Rust projects in one `vitest` run (vitest initializes all
// projects' globalSetups upfront, so two port-sharing dual-spawns can't share an
// invocation). `groupOrder: 5` only orders it last if it ever is in a shared run.
const cross_backend_security_project = () => ({
	extends: true as const,
	test: {
		name: 'cross_backend_security',
		include: SECURITY_TESTS,
		globalSetup: ['./src/test/cross_backend/global_setup_login_security.ts'],
		isolate: false,
		fileParallelism: false,
		sequence: {groupOrder: 5},
	},
});

export default defineConfig({
	plugins: [sveltekit(), svelte_docinfo(), vite_plugin_fuz_css(), vite_plugin_pkg_json()],
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
							'cross_backend_rust_spine_stub',
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
						cross_backend_parity_project(),
						cross_backend_security_project(),
					]
				: []),
		],
	},
});
