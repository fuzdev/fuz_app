/**
 * Shared in-process wiring for the cell cross-backend parity legs
 * (`cell_crud_parity.db.test.ts` + `cell_relations_parity.db.test.ts`).
 *
 * Mounts the **full** cell RPC surface (CRUD + grant + field + item + audit)
 * on the spine RPC path — matching what the TS spine binary and the Rust
 * `testing_spine_stub` mount — and threads `cell_audit_events` through the
 * audit factory so the cell handlers' `deps.audit.emit(...)` calls validate
 * instead of tripping the unknown-event drift counter. Cells stay off the
 * declared surface; the dedicated cross suites are their sole validators.
 *
 * Not itself a test file — no `.test.` infix, so vitest skips it.
 *
 * @module
 */

import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.ts';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.ts';
import {create_all_cell_actions} from '$lib/auth/all_cell_actions.ts';
import {create_testing_drain_effects_action} from '$lib/testing/cross_backend/testing_reset_actions.ts';
import {cell_audit_events} from '$lib/auth/cell_audit_events.ts';
import {create_audit_emitter} from '$lib/auth/audit_emitter.ts';
import {create_audit_log_config} from '$lib/auth/audit_log_schema.ts';
import {CELL_MIGRATION_NS} from '$lib/db/cell_ddl.ts';
import {
	SPINE_RPC_PATH,
	spine_roles,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.ts';
import {default_in_process_setup} from '$lib/testing/cross_backend/in_process_setup.ts';
import type {ExtraAccountSpec, SetupTest} from '$lib/testing/cross_backend/setup.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import type {AuditFactory} from '$lib/server/app_backend.ts';
import type {RpcEndpointSpec} from '$lib/http/surface.ts';

/**
 * The full cell RPC surface mounted on the spine RPC path, alongside the
 * standard spine surface + the `_testing_drain_effects` barrier — matching
 * what the TS spine binary and the Rust `testing_spine_stub` mount, so the
 * shared suite body can reach `audit_log_list` (the clone-D8 no-count-leak
 * check) and the drain barrier in-process exactly as it does cross-process.
 */
export const cell_parity_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: SPINE_RPC_PATH,
		actions: [
			// `spine_roles` carries the `cell_editor` app role so the
			// role-shaped-grant parity suite's role-validity gate admits it and
			// rejects unregistered roles — matching the spine binary + Rust stub.
			...create_standard_rpc_actions(ctx.deps, {roles: spine_roles}),
			...create_all_cell_actions(ctx.deps, {roles: spine_roles}),
			// `_testing_drain_effects` so the shared suite can call the audit
			// barrier in-process too (satisfied-by-construction here:
			// `create_test_app` runs `await_pending_effects: true`).
			create_testing_drain_effects_action(),
		],
	},
];

/** Audit factory registering the cell event types so cell emits validate. */
const cell_parity_audit_factory: AuditFactory = ({db, log}) =>
	create_audit_emitter({
		db,
		log,
		audit_log_config: create_audit_log_config({extra_events: cell_audit_events}),
	});

/**
 * `default_in_process_setup` configured with the full cell surface, the
 * keeper holding `[ROLE_KEEPER, ROLE_ADMIN]` (admin-reach + admin-only-path
 * cases), the `fuz_cell` migration namespace, and the cell audit factory.
 *
 * `extra_accounts` seeds bootstrap-cradle secondaries (e.g. a `cell_editor`
 * holder for the role-shaped-grant parity suite, whose role has no grant
 * path and so can't be offered).
 */
export const create_cell_parity_setup = (
	extra_accounts: ReadonlyArray<ExtraAccountSpec> = [],
): SetupTest =>
	default_in_process_setup({
		session_options: spine_session_options,
		create_route_specs: () => [],
		rpc_endpoints: cell_parity_rpc_endpoints,
		roles: [ROLE_KEEPER, ROLE_ADMIN],
		migration_namespaces: [CELL_MIGRATION_NS],
		audit_factory: cell_parity_audit_factory,
		extra_accounts,
	});
