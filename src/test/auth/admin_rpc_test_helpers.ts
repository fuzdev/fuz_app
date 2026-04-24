/**
 * Shared scaffolding for admin-RPC integration suites that follow the
 * `describe_db` + single `/api/rpc` mount pattern —
 * `admin_actions.failure_audit.db.test.ts`, `invite_actions.db.test.ts`,
 * and `app_settings_actions.db.test.ts`.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick it
 * up. Mirrors the pattern in `./permit_offer_test_helpers.ts` and
 * `./notification_helpers.ts`.
 *
 * Files that don't fit this pattern (and should not be migrated):
 *
 * - `admin_actions.rpc_suites.db.test.ts` — uses composable RPC suites
 *   (`describe_rpc_attack_surface_tests` + `describe_rpc_round_trip_tests`)
 *   with its own session cookie name; shares no DB scaffolding.
 * - `audit_log_completeness.db.test.ts` — uses the project `db_factories`
 *   from `../db_fixture.js` and composes multiple action factories
 *   (permit-offer + admin + account) alongside REST account/signup/audit
 *   routes; fundamentally different shape.
 *
 * @module
 */

import {create_session_config} from '$lib/auth/session_cookie.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

/** Shared cookie name for the admin-RPC integration suites. */
export const session_options = create_session_config('test_session');

/** The RPC mount path used across every admin-RPC integration suite. */
export const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};

const factory = create_pglite_factory(init_schema);

/**
 * `describe_db` bound to the suite's PGlite factory + auth truncate list.
 * Use as the outer `describe_db(name, (get_db) => {...})` wrapper.
 */
export const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

/**
 * Default `create_route_specs` — mounts the admin RPC endpoint with the
 * server context's deps unchanged and threads `ctx.app_settings` into
 * `create_admin_actions` so handlers share the mutable settings ref that
 * signup middleware reads.
 */
export const create_admin_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_admin_actions(ctx.deps, {app_settings: ctx.app_settings}),
		log: ctx.deps.log,
	}),
];

/**
 * `create_route_specs` factory for suites that need extra REST route
 * specs alongside the admin RPC endpoint (e.g. `create_account_route_specs`
 * for end-to-end signup coverage).
 *
 * The extra specs are emitted **before** the RPC endpoint so consumer
 * prefix mounts (`prefix_route_specs('/api/account', ...)`) do not
 * conflict with `/api/rpc`.
 */
export const create_admin_route_specs_with =
	(build_extra: (ctx: AppServerContext) => Array<RouteSpec>) =>
	(ctx: AppServerContext): Array<RouteSpec> => [
		...build_extra(ctx),
		...create_admin_route_specs(ctx),
	];
