/**
 * The `cross_backend_*` vitest projects — one list read by `vite.config.ts`
 * (which builds each with `make_cross_backend_project`) and by `run_cross.ts`
 * (`npm run test:cross`, which runs each in a `vitest` invocation of its own).
 *
 * Every project spawns its backends on ports, Postgres databases and temp
 * directories no other project uses, so any set of them can run at once:
 *
 * - `cross_backend_rust_spine_stub` — `spine_stub` on 1177, over
 *   `fuz_app_test_rust_spine_stub` (or whatever database
 *   `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` names)
 * - `cross_backend_ts_node` / `_ts_deno` / `_ts_bun` — `ts_spine_node` on
 *   1178, `ts_spine_deno` on 1179, `ts_spine_bun` on 1180, each on `memory://`
 * - `cross_backend_parity` — `ts_spine_node_parity` on 1181 over
 *   `fuz_app_test_ts_spine_parity`, `spine_stub_parity` on 1182 over
 *   `fuz_app_test_rust_spine_stub_parity`
 * - `cross_backend_security` — `ts_spine_node_security` on 1183 on
 *   `memory://`, `spine_stub_security` on 1184 over
 *   `fuz_app_test_rust_spine_stub_security`
 * - `cross_backend_ts_differential` — `ts_spine_node_differential` on 1185,
 *   `ts_spine_bun_differential` on 1186, each on `memory://`
 *
 * A backend's name is also its directory under `os.tmpdir()`.
 *
 * The parity and security databases sit on the server the stub's URL names
 * (`FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL`, else the local default); each
 * project's `globalSetup` creates the ones it uses.
 *
 * Config-time module: dependency-free, like `make_cross_backend_project`.
 *
 * @module
 */

import type { CrossBackendProjectOptions } from '#lib/testing/cross_backend/make_cross_backend_project.ts';

/**
 * The env var that turns the cross projects on: `vite.config.ts` defines them
 * only when it is `1`, and `run_cross.ts` sets it for each invocation.
 */
export const CROSS_BACKEND_ENV = 'FUZ_TEST_CROSS_BACKEND';

/** The single-backend projects' test files. */
const CROSS_BACKEND_TESTS = ['src/test/cross_backend/*.cross.test.ts'];

/**
 * The dual-spawn projects — each spawns BOTH backends in its own `globalSetup`
 * and provides two handles instead of `backend_handle`, so its files are
 * excluded from the single-backend projects (`DUAL_SPAWN_TESTS`, derived
 * here).
 */
const DUAL_SPAWN_PROJECTS: ReadonlyArray<CrossBackendProjectOptions> = [
	// One dual-spawn serves the parity gates: schema parity (live DDL),
	// action-manifest parity (live RPC method set + auth), and the differential
	// (every conformance case sent to both, the answers compared).
	{
		name: 'cross_backend_parity',
		global_setup: './src/test/cross_backend/global_setup_schema_parity.ts',
		include: [
			'src/test/cross_backend/schema_parity.cross.test.ts',
			'src/test/cross_backend/action_manifest_parity.cross.test.ts',
			'src/test/cross_backend/differential.cross.test.ts'
		]
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
		]
	},
	// The differential again, between two JS runtimes: the TS spine on Node and
	// on Bun, both on `memory://` — no Rust, no Postgres, so it runs in CI.
	{
		name: 'cross_backend_ts_differential',
		global_setup: './src/test/cross_backend/global_setup_ts_differential.ts',
		include: ['src/test/cross_backend/differential_ts.cross.test.ts']
	}
];

const DUAL_SPAWN_TESTS = DUAL_SPAWN_PROJECTS.flatMap((project) => project.include ?? []);

/**
 * Single-backend files that run under `cross_backend_ts_node` alone: they pin
 * harness option paths that are the same on every backend, which the
 * per-backend suites already cover there.
 */
const NODE_ONLY_CROSS_TESTS = ['src/test/cross_backend/builtin_roles.cross.test.ts'];

const single_backend_project = (
	name: string,
	global_setup: string,
	{ with_node_only = false }: { with_node_only?: boolean } = {}
): CrossBackendProjectOptions => ({
	name,
	global_setup,
	include: CROSS_BACKEND_TESTS,
	exclude: with_node_only ? DUAL_SPAWN_TESTS : [...DUAL_SPAWN_TESTS, ...NODE_ONLY_CROSS_TESTS]
});

/** Every cross project, in the order `run_cross.ts` reports them. */
export const CROSS_BACKEND_PROJECTS: ReadonlyArray<CrossBackendProjectOptions> = [
	single_backend_project(
		'cross_backend_rust_spine_stub',
		'./src/test/cross_backend/global_setup.ts'
	),
	single_backend_project(
		'cross_backend_ts_node',
		'./src/test/cross_backend/global_setup_ts_node.ts',
		{ with_node_only: true }
	),
	single_backend_project(
		'cross_backend_ts_deno',
		'./src/test/cross_backend/global_setup_ts_deno.ts'
	),
	single_backend_project('cross_backend_ts_bun', './src/test/cross_backend/global_setup_ts_bun.ts'),
	...DUAL_SPAWN_PROJECTS
];
