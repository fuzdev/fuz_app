/**
 * Shared scaffolding for the `role_grant_offer_actions.*.db.test.ts` suites.
 * Each suite needs the same PGlite factory + `describe_db` and the same
 * `/api/rpc` mount with `create_role_grant_offer_actions`; extracting them
 * keeps the per-suite files focused on the assertions that actually differ.
 *
 * RPC calls go through `rpc_call_for_spec` from
 * `$lib/testing/rpc_helpers.js` — `params` is typed against `spec.input`
 * and the success `result` is validated against `spec.output`. Fall back
 * to the untyped `rpc_call` for adversarial tests that deliberately send
 * malformed params.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick
 * it up. Mirrors the pattern in ./notification_helpers.ts for the two
 * notification suites and ./admin_rpc_test_helpers.ts for the admin
 * RPC integration suites.
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
import {create_role_grant_offer_actions} from '$lib/auth/role_grant_offer_actions.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

/** Shared cookie name for the role-grant-offer integration suites. */
export const session_options = create_session_config('test_session');

/** The RPC mount path used across every role-grant-offer integration suite. */
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
 * Default `create_route_specs` — mounts the role-grant-offer RPC endpoint with
 * the server context's deps unchanged. Suites that need a custom `authorize`
 * callback or a `notification_sender` build their own factory inline.
 */
export const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_role_grant_offer_actions(ctx.deps),
		log: ctx.deps.log,
	}),
];
