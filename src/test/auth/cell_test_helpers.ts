/**
 * Shared scaffolding for the `cell_*` RPC integration suites.
 *
 * Provides the PGlite factory + `describe_db` carrying the cell migration
 * namespaces, a `create_route_specs` that mounts the full cell RPC surface
 * (cell / grant / field / item / audit) on `/api/rpc`, a `create_test_app`
 * wrapper that threads `cell_audit_events` through the audit factory so the
 * cell mutation events validate, and the three call-site primitives
 * (`call`, `error_reason`, `create_cell`).
 *
 * Not itself a test file — no `.test.` infix, so vitest skips it. Mirrors
 * `./role_grant_offer_test_helpers.ts`.
 *
 * @module
 */

import {assert} from 'vitest';
import {z} from 'zod';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {
	create_serve_fact_route_spec,
	create_serve_cell_fact_route_spec,
} from '$lib/server/serve_fact_route.js';
import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	auth_integration_truncate_tables,
	log_db_factory_status,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {auth_migration_ns} from '$lib/auth/migrations.js';
import {CELL_MIGRATION_NS, CELL_DROP_TABLES} from '$lib/db/cell_ddl.js';
import {FACT_MIGRATION_NS, FACT_DROP_TABLES} from '$lib/db/fact_ddl.js';
import {CELL_HISTORY_MIGRATION_NS} from '$lib/db/cell_history_ddl.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_role_schema, ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {create_audit_emitter} from '$lib/auth/audit_emitter.js';
import {create_audit_log_config} from '$lib/auth/audit_log_schema.js';
import {create_cell_actions} from '$lib/auth/cell_actions.js';
import {create_cell_grant_actions} from '$lib/auth/cell_grant_actions.js';
import {create_cell_field_actions} from '$lib/auth/cell_field_actions.js';
import {create_cell_item_actions} from '$lib/auth/cell_item_actions.js';
import {create_cell_audit_actions} from '$lib/auth/cell_audit_actions.js';
import {cell_audit_events} from '$lib/auth/cell_audit_events.js';
import {
	cell_create_action_spec,
	type CellCreateInput,
	type CellPath,
	type CellVisibility,
} from '$lib/auth/cell_action_specs.js';
import {
	cell_item_insert_action_spec,
	type CellItemPosition,
} from '$lib/auth/cell_item_action_specs.js';
import {fractional_indices_between} from '@fuzdev/fuz_util/fractional_index.js';
import {create_test_app, type TestApp} from '$lib/testing/app_server.js';
import {rpc_call_for_spec, type RpcCallResultForSpec} from '$lib/testing/rpc_helpers.js';
import type {RequestResponseActionSpec} from '$lib/actions/action_spec.js';
import type {AppServerContext} from '$lib/server/app_server_context.js';
import type {AuditFactory} from '$lib/server/app_backend.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {Db} from '$lib/db/db.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

/** Shared cookie config for the cell integration suites. */
export const session_options = create_session_config('test_session');

/** RPC mount path used across every cell integration suite. */
export const RPC_PATH = '/api/rpc';

/**
 * Role schema for the cell suites. `member` is a consumer role registered
 * so role-shaped `cell_grant` principals have a valid role to reference
 * (the unknown-role gate reads `roles.role_specs`).
 */
export const cell_test_roles = create_role_schema([{name: 'member'}]);

/** Consumer role registered in `cell_test_roles`. */
export const ROLE_MEMBER = 'member';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [
		auth_migration_ns,
		CELL_MIGRATION_NS,
		FACT_MIGRATION_NS,
		CELL_HISTORY_MIGRATION_NS,
	]);
};

// Both drivers — pg auto-skips when `TEST_DATABASE_URL` is unset. The cell
// migration is idempotent (guarded `CREATE TYPE` + `CREATE TABLE IF NOT
// EXISTS`), so re-running against a persistent pg after `create_pg_factory`
// resets `schema_version` is safe. Mirrors `../db_fixture.ts`.
const cell_factories = [
	create_pglite_factory(init_schema),
	create_pg_factory(init_schema, process.env.TEST_DATABASE_URL),
];
log_db_factory_status(cell_factories);

/**
 * `describe_db` bound to the cell factories. Truncates the cell tables
 * (children first) plus the auth integration tables (incl. `audit_log`)
 * between tests.
 */
export const describe_db = create_describe_db(cell_factories, [
	...CELL_DROP_TABLES,
	...FACT_DROP_TABLES,
	...auth_integration_truncate_tables,
]);

/**
 * Per-suite-process temp facts directory. Embedded facts never touch it
 * (`serve_fact_route` only reads disk for external `file:` facts), but the
 * route factory requires a path; this gives it a real, writable one.
 */
export const cell_test_facts_dir = mkdtempSync(join(tmpdir(), 'fuz-cell-facts-'));

/**
 * Mounts the full cell RPC surface on `/api/rpc` plus both fact-serving
 * REST routes: the cell-scoped per-reference read
 * (`GET /api/cells/:cell_id/facts/:hash`) and the admin-only bare-hash read
 * (`GET /api/facts/:hash`). `validate_data` is left unset (pass-through) —
 * per-kind shape validation is sub-API and out of scope for the
 * generic-layer suites.
 */
export const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: [
			...create_cell_actions(ctx.deps),
			...create_cell_grant_actions({...ctx.deps, roles: cell_test_roles}),
			...create_cell_field_actions(ctx.deps),
			...create_cell_item_actions(ctx.deps),
			...create_cell_audit_actions(),
		],
		log: ctx.deps.log,
	}),
	create_serve_cell_fact_route_spec({
		deps: ctx.deps,
		facts_dir: cell_test_facts_dir,
		log: ctx.deps.log,
	}),
	create_serve_fact_route_spec({deps: ctx.deps, facts_dir: cell_test_facts_dir, log: ctx.deps.log}),
];

/**
 * Audit factory registering the cell event types so cell handlers'
 * `deps.audit.emit(...)` calls validate against the extended config
 * instead of tripping the unknown-event drift counter.
 */
const cell_audit_config = create_audit_log_config({extra_events: cell_audit_events});
const cell_audit_factory: AuditFactory = ({db, log}) =>
	create_audit_emitter({db, log, audit_log_config: cell_audit_config});

/** Create a cell test app bound to `get_db`, with cell events registered. */
export const create_cell_test_app = (get_db: () => Db, roles?: Array<string>): Promise<TestApp> =>
	create_test_app({
		session_options,
		create_route_specs,
		audit_factory: cell_audit_factory,
		db: get_db(),
		roles: roles ?? [],
	});

/**
 * Cell test app whose bootstrapped account holds `keeper` + `admin`.
 * Additional accounts via `test_app.create_account()` default to no roles.
 */
export const create_cell_admin_test_app = (get_db: () => Db): Promise<TestApp> =>
	create_cell_test_app(get_db, [ROLE_KEEPER, ROLE_ADMIN]);

/** `rpc_call_for_spec` with `app` + `path` pre-bound. */
export const call = <TSpec extends RequestResponseActionSpec>(
	test_app: TestApp,
	spec: TSpec,
	params: z.infer<TSpec['input']>,
	headers?: Record<string, string>,
): Promise<RpcCallResultForSpec<TSpec>> =>
	rpc_call_for_spec({app: test_app.app, path: RPC_PATH, spec, params, headers});

/**
 * Read the `reason` string off a JSON-RPC error response, past the
 * `data: unknown` cast.
 */
export const error_reason = (
	res: {ok: false; error: {data?: unknown}} | {ok: true},
): string | undefined => {
	if (res.ok) return undefined;
	return (res.error.data as {reason?: string} | undefined)?.reason;
};

/**
 * Create a cell via the public RPC and return its id. Asserts the create
 * succeeded. `items`, when given, are attached as ordered children at
 * evenly-spaced fractional-index positions (parent created first).
 */
export const create_cell = async (
	test_app: TestApp,
	params: {
		data: CellCreateInput['data'];
		visibility?: CellVisibility;
		items?: Array<Uuid>;
		path?: CellPath;
		headers?: Record<string, string>;
	},
): Promise<{id: Uuid}> => {
	const headers = params.headers ?? test_app.create_session_headers();
	const res = await call(
		test_app,
		cell_create_action_spec,
		{data: params.data, visibility: params.visibility, path: params.path},
		headers,
	);
	assert.ok(res.ok, `cell_create failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
	const id = res.result.cell.id;
	if (params.items && params.items.length > 0) {
		const positions = fractional_indices_between(null, null, params.items.length);
		for (let i = 0; i < params.items.length; i++) {
			const insert_res = await call(
				test_app,
				cell_item_insert_action_spec,
				{
					parent_id: id,
					child_id: params.items[i]!,
					position: positions[i]! as CellItemPosition,
				},
				headers,
			);
			assert.ok(
				insert_res.ok,
				`cell_item_insert failed: ${insert_res.ok ? '' : JSON.stringify(insert_res.error)}`,
			);
		}
	}
	return {id};
};
