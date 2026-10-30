/**
 * The `cross_backend_*` vitest projects — one list read by `vite.config.ts`
 * (which builds each with `make_cross_backend_project`) and by `run_cross.ts`
 * (`npm run test:cross`, which runs each in a `vitest` invocation of its own).
 *
 * Every project spawns its backends on ports, Postgres databases and temp
 * directories no other project uses, so any set of them can run at once. The
 * claims live in one table, `CROSS_PROJECT_RESOURCES`: each project's global
 * setup reads its backends' names, ports and databases from it, and
 * `cross_backend_projects.test.ts` holds every port, database and temp
 * directory unique across the table. A backend's name (prefixed with the repo
 * directory) is also its directory under `os.tmpdir()`.
 *
 * The single-backend Rust stub's database is the one
 * `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` names when it is set. The other
 * stub databases, and the parity project's TS one, sit on the server that URL
 * names (else the local default); each project's `globalSetup` creates the
 * ones it uses.
 *
 * Config-time module: dependency-free, like `make_cross_backend_project`.
 *
 * @module
 */

import type { CrossBackendProjectOptions } from '#lib/testing/cross_backend/make_cross_backend_project.ts';

/** What one spawned backend of a cross project claims. */
export interface CrossBackendResources {
	/**
	 * Backend name — its spawn label, and (prefixed with the repo directory)
	 * its directory under `os.tmpdir()`.
	 */
	readonly name: string;
	/** Listening port. */
	readonly port: number;
	/** The Postgres database it runs over, `null` on `memory://`. */
	readonly database: string | null;
}

/**
 * Every cross project's backends, keyed by project name and then by the
 * backend's role in it — the one place a port, database or backend name is
 * chosen. A project added to `CROSS_BACKEND_PROJECTS` takes its row here.
 */
export const CROSS_PROJECT_RESOURCES = {
	cross_backend_rust_spine_stub: {
		stub: { name: 'spine_stub', port: 1177, database: 'fuz_app_test_rust_spine_stub' }
	},
	cross_backend_ts_node: { node: { name: 'ts_spine_node', port: 1178, database: null } },
	cross_backend_ts_deno: { deno: { name: 'ts_spine_deno', port: 1179, database: null } },
	cross_backend_ts_bun: { bun: { name: 'ts_spine_bun', port: 1180, database: null } },
	cross_backend_parity: {
		ts: { name: 'ts_spine_node_parity', port: 1181, database: 'fuz_app_test_ts_spine_parity' },
		stub: {
			name: 'spine_stub_parity',
			port: 1182,
			database: 'fuz_app_test_rust_spine_stub_parity'
		}
	},
	cross_backend_security: {
		ts: { name: 'ts_spine_node_security', port: 1183, database: null },
		stub: {
			name: 'spine_stub_security',
			port: 1184,
			database: 'fuz_app_test_rust_spine_stub_security'
		}
	},
	cross_backend_ts_differential: {
		node: { name: 'ts_spine_node_differential', port: 1185, database: null },
		bun: { name: 'ts_spine_bun_differential', port: 1186, database: null }
	},
	cross_backend_timing: {
		ts: { name: 'ts_spine_node_timing', port: 1187, database: null },
		stub: {
			name: 'spine_stub_timing',
			port: 1188,
			database: 'fuz_app_test_rust_spine_stub_timing'
		}
	}
} as const satisfies Record<string, Record<string, CrossBackendResources>>;

/** A cross project's name — a key of `CROSS_PROJECT_RESOURCES`. */
export type CrossProjectName = keyof typeof CROSS_PROJECT_RESOURCES;

/**
 * The env var that turns the cross projects on: `vite.config.ts` defines them
 * only when it is `1`, and `run_cross.ts` sets it for each invocation.
 */
export const CROSS_BACKEND_ENV = 'FUZ_TEST_CROSS_BACKEND';

/** The single-backend projects' test files. */
const CROSS_BACKEND_TESTS = ['src/test/cross_backend/*.cross.test.ts'];

/** A dual-spawn project's options, named by its `CROSS_PROJECT_RESOURCES` row. */
type DualSpawnProject = CrossBackendProjectOptions & { name: CrossProjectName };

/**
 * The dual-spawn projects — each spawns BOTH backends in its own `globalSetup`
 * and provides two handles instead of `backend_handle`, so its files are
 * excluded from the single-backend projects (`DUAL_SPAWN_TESTS`, derived
 * here).
 */
const DUAL_SPAWN_PROJECTS: ReadonlyArray<DualSpawnProject> = [
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
	// The timing gates spawn both backends with the audit stream's keep-alive
	// interval, the WS receive timeout and the pool checkout bounds shortened —
	// a config nothing else can share (a short receive timeout would close the
	// standard suites' idle sockets mid-case).
	{
		name: 'cross_backend_timing',
		global_setup: './src/test/cross_backend/global_setup_timing.ts',
		include: [
			'src/test/cross_backend/sse_keep_alive.cross.test.ts',
			'src/test/cross_backend/ws_receive_timeout.cross.test.ts',
			'src/test/cross_backend/db_checkout_timeout.cross.test.ts'
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
	name: CrossProjectName,
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
