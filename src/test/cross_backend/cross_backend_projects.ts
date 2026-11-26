/**
 * The `cross_backend_*` vitest projects — one list read by `vite.config.ts`
 * (which builds each with `make_cross_backend_project`) and by `run_cross.ts`
 * (`npm run test:cross`, which runs each in a `vitest` invocation of its own).
 *
 * Every project spawns its backends on ports, databases and temp directories
 * no other project uses, so any set of them can run at once. The claims live
 * in one table, `CROSS_PROJECT_RESOURCES`: each project's global setup reads
 * its backends' names, ports and databases from it, and
 * `cross_backend_projects.test.ts` holds every port, database and temp
 * directory unique across the table — a database shared by the backends of
 * one project only where `SHARED_DATABASE_PROJECTS` names it. A backend's
 * name (prefixed with the repo directory) is also its directory under
 * `os.tmpdir()`.
 *
 * Each named database is opened by the project's `globalSetup`
 * (`open_rust_spine_database`, `create_dual_spawn_global_setup`'s
 * `databases`): a `pglet_server` of its own, or under `FUZ_TEST_POSTGRES_URL`
 * a PostgreSQL database named for it (`fuz_testing_fuz_app_<database>`), new
 * each run and dropped after it. A project in `POSTGRES_ONLY_PROJECTS` fails
 * naming the variable when it is unset.
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
	/**
	 * The database it runs over — `open_test_database`'s `name`: a
	 * `pglet_server`, or `fuz_testing_<repo>_<database>` on PostgreSQL —
	 * `null` on `memory://`.
	 */
	readonly database: string | null;
}

/**
 * Every cross project's backends, keyed by project name and then by the
 * backend's role in it — the one place a port, database or backend name is
 * chosen. A project added to `CROSS_BACKEND_PROJECTS` takes its row here.
 */
export const CROSS_PROJECT_RESOURCES = {
	cross_backend_rust_spine_stub: {
		stub: { name: 'spine_stub', port: 1177, database: 'spine_stub' }
	},
	cross_backend_ts_node: {
		node: { name: 'ts_spine_node', port: 1178, database: null },
		// the short-lived spine `shutdown_in_flight.cross.test.ts` spawns and stops
		shutdown: { name: 'ts_spine_node_shutdown', port: 1189, database: null }
	},
	cross_backend_ts_bun: {
		bun: { name: 'ts_spine_bun', port: 1180, database: null },
		shutdown: { name: 'ts_spine_bun_shutdown', port: 1190, database: null }
	},
	cross_backend_parity: {
		ts: { name: 'ts_spine_node_parity', port: 1181, database: 'ts_spine_node_parity' },
		stub: { name: 'spine_stub_parity', port: 1182, database: 'spine_stub_parity' }
	},
	cross_backend_security: {
		ts: { name: 'ts_spine_node_security', port: 1183, database: null },
		stub: { name: 'spine_stub_security', port: 1184, database: 'spine_stub_security' }
	},
	cross_backend_ts_differential: {
		node: { name: 'ts_spine_node_differential', port: 1185, database: null },
		bun: { name: 'ts_spine_bun_differential', port: 1186, database: null }
	},
	cross_backend_timing: {
		ts: { name: 'ts_spine_node_timing', port: 1187, database: null },
		stub: { name: 'spine_stub_timing', port: 1188, database: 'spine_stub_timing' }
	},
	// both on one database, never at once (`SHARED_DATABASE_PROJECTS`)
	cross_backend_swap: {
		ts: { name: 'ts_spine_node_swap', port: 1191, database: 'backend_swap' },
		stub: { name: 'spine_stub_swap', port: 1192, database: 'backend_swap' }
	},
	// both on one database at once (`SHARED_DATABASE_PROJECTS`)
	cross_backend_both_live: {
		ts: { name: 'ts_spine_node_both_live', port: 1193, database: 'backend_both_live' },
		stub: { name: 'spine_stub_both_live', port: 1194, database: 'backend_both_live' }
	}
} as const satisfies Record<string, Record<string, CrossBackendResources>>;

/** A cross project's name — a key of `CROSS_PROJECT_RESOURCES`. */
export type CrossProjectName = keyof typeof CROSS_PROJECT_RESOURCES;

/**
 * The projects whose backends share one Postgres database — the backend swap,
 * which boots each spine over what the other left, and both spines live, which
 * runs them over it at once. Every other database is claimed once, and none is
 * shared across projects (`cross_backend_projects.test.ts`).
 */
export const SHARED_DATABASE_PROJECTS: ReadonlySet<CrossProjectName> = new Set([
	'cross_backend_swap',
	'cross_backend_both_live'
]);

/**
 * The projects that run only on PostgreSQL — the parity gates (index
 * rendering, the lock pins, the invariant twin's direct reads), which pglet
 * can't answer. Their setup fails naming `FUZ_TEST_POSTGRES_URL` when it is
 * unset, and `run_cross.ts` reports them "not run (postgres-only)" then.
 */
export const POSTGRES_ONLY_PROJECTS: ReadonlySet<CrossProjectName> = new Set([
	'cross_backend_parity'
]);

/** The single-backend projects' test files. */
const CROSS_BACKEND_TESTS = ['src/test/cross_backend/*.cross.test.ts'];

/** A dual-spawn project's options, named by its `CROSS_PROJECT_RESOURCES` row. */
type DualSpawnProject = CrossBackendProjectOptions & { name: CrossProjectName };

/**
 * The dual-spawn projects — each spawns BOTH backends in its own `globalSetup`
 * and provides two handles instead of `backend_handle` (the swap provides two
 * configs, its tests spawning each in turn), so its files are excluded from
 * the single-backend projects (`DUAL_SPAWN_TESTS`, derived here).
 */
const DUAL_SPAWN_PROJECTS: ReadonlyArray<DualSpawnProject> = [
	// One dual-spawn serves the parity gates: schema parity (live DDL),
	// action-manifest parity (live RPC method set + auth), and the differential
	// (every conformance case sent to both, the answers compared), and the
	// transcript differential (the imperative suites run on each, every
	// request and answer diffed). The copy check of the twin conformance
	// tables rides here too: it reads the Rust checkout the stub was built from.
	// So do the lock pins, which need both spines on PostgreSQL, and the
	// invariant twin, which reads each spine's database directly — so the
	// project runs only on PostgreSQL (`POSTGRES_ONLY_PROJECTS`).
	{
		name: 'cross_backend_parity',
		global_setup: './src/test/cross_backend/global_setup_schema_parity.ts',
		include: [
			'src/test/cross_backend/schema_parity.cross.test.ts',
			'src/test/cross_backend/bootstrap_db_state.cross.test.ts',
			'src/test/cross_backend/action_manifest_parity.cross.test.ts',
			'src/test/cross_backend/differential.cross.test.ts',
			'src/test/cross_backend/conformance_table_copies.cross.test.ts',
			'src/test/cross_backend/transcript_differential.cross.test.ts',
			'src/test/cross_backend/lock_pins.cross.test.ts',
			'src/test/cross_backend/db_invariants_twin.cross.test.ts'
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
			'src/test/cross_backend/ws_action_rate_limit.cross.test.ts',
			'src/test/cross_backend/bootstrap_rate_limit.cross.test.ts'
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
	// The backend swap: the TS spine and the stub, one at a time over one
	// database, each honoring what the other wrote. Its tests spawn both
	// backends themselves, so its global setup only prepares them.
	{
		name: 'cross_backend_swap',
		global_setup: './src/test/cross_backend/global_setup_swap.ts',
		include: ['src/test/cross_backend/backend_swap.cross.test.ts']
	},
	// Both spines live: the TS spine and the stub over one database at once,
	// each honoring the other's credential revocations live, with the
	// per-process limits pinned. Its tests spawn both backends themselves.
	{
		name: 'cross_backend_both_live',
		global_setup: './src/test/cross_backend/global_setup_both_live.ts',
		include: ['src/test/cross_backend/backend_both_live.cross.test.ts']
	},
	// The differential and the transcript differential again, between two JS
	// runtimes: the TS spine on Node and on Bun, both on `memory://` — no Rust,
	// no database server, so it runs in CI.
	{
		name: 'cross_backend_ts_differential',
		global_setup: './src/test/cross_backend/global_setup_ts_differential.ts',
		include: [
			'src/test/cross_backend/differential_ts.cross.test.ts',
			'src/test/cross_backend/transcript_differential_ts.cross.test.ts'
		]
	}
];

const DUAL_SPAWN_TESTS = DUAL_SPAWN_PROJECTS.flatMap((project) => project.include ?? []);

/**
 * Single-backend files that run under `cross_backend_ts_node` alone: they pin
 * harness option paths that are the same on every backend, which the
 * per-backend suites already cover there.
 */
const NODE_ONLY_CROSS_TESTS = ['src/test/cross_backend/builtin_roles.cross.test.ts'];

/**
 * Single-backend files that run under the TS spine projects alone: they spawn
 * a TS spine binary of their own, on the project's runtime.
 */
const TS_ONLY_CROSS_TESTS = ['src/test/cross_backend/shutdown_in_flight.cross.test.ts'];

const single_backend_project = (
	name: CrossProjectName,
	global_setup: string,
	{
		with_node_only = false,
		with_ts_only = false
	}: { with_node_only?: boolean; with_ts_only?: boolean } = {}
): CrossBackendProjectOptions => ({
	name,
	global_setup,
	include: CROSS_BACKEND_TESTS,
	exclude: [
		...DUAL_SPAWN_TESTS,
		...(with_node_only ? [] : NODE_ONLY_CROSS_TESTS),
		...(with_ts_only ? [] : TS_ONLY_CROSS_TESTS)
	]
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
		{ with_node_only: true, with_ts_only: true }
	),
	single_backend_project(
		'cross_backend_ts_bun',
		'./src/test/cross_backend/global_setup_ts_bun.ts',
		{ with_ts_only: true }
	),
	...DUAL_SPAWN_PROJECTS
];
