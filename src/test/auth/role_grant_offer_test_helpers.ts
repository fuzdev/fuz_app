/**
 * Shared scaffolding for the `role_grant_offer_actions.*.db.test.ts` suites.
 * Each suite needs the same PGlite factory + `describe_db` and the same
 * `/api/rpc` mount with `create_role_grant_offer_actions`; extracting them
 * keeps the per-suite files focused on the assertions that actually differ.
 *
 * RPC calls go through `rpc_call_for_spec` from
 * `$lib/testing/rpc_helpers.ts` — `params` is typed against `spec.input`
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

import { create_session_config } from '$lib/auth/session_cookie.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables
} from '$lib/testing/db.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import { create_rpc_endpoint } from '$lib/actions/action_rpc.ts';
import {
	create_role_grant_offer_actions,
	type RoleGrantOfferCreateAuthorize
} from '$lib/auth/role_grant_offer_actions.ts';
import { create_role_schema, type RoleSchemaResult } from '$lib/auth/role_schema.ts';
import { GRANT_PATH_ADMIN } from '$lib/auth/grant_path_schema.ts';
import type { Db } from '$lib/db/db.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import type { RouteSpec } from '$lib/http/route_spec.ts';

/** Shared cookie name for the role-grant-offer integration suites. */
export const session_options = create_session_config('test_session');

/** The RPC mount path used across every role-grant-offer integration suite. */
export const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};

const factory = create_pglite_factory(init_schema);

/**
 * `describe_db` bound to the suite's PGlite factory + auth truncate list.
 * Use as the outer `describe_db(name, (get_db) => {...})` wrapper.
 */
export const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

/**
 * Default `create_route_specs` — mounts the role-grant-offer RPC endpoint with
 * the server context's deps unchanged. Suites that need a custom `authorize`
 * callback or a `notification_sender` build their own factory inline.
 */
export const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_role_grant_offer_actions(ctx.deps),
		log: ctx.deps.log
	})
];

/** An admin-grantable app role — the shape a classroom- or space-scoped consumer declares. */
export const TEST_APP_ROLE = 'teacher';

/** A consumer registry with one admin-grantable app role (`TEST_APP_ROLE`). */
export const app_roles: RoleSchemaResult = create_role_schema([
	{ name: TEST_APP_ROLE, grant_paths: [GRANT_PATH_ADMIN] }
]);

/**
 * An offer-create callback that admits everything — proves a refusal happens
 * in the spine, ahead of any consumer callback (the shape of a consumer
 * answering with a scope-blind `has_role`).
 */
export const admit_all_authorize: RoleGrantOfferCreateAuthorize = () => true;

/**
 * `create_route_specs` over the `app_roles` registry, optionally with a
 * consumer `authorize` callback.
 */
export const create_app_role_route_specs =
	(options: { authorize?: RoleGrantOfferCreateAuthorize } = {}) =>
	(ctx: AppServerContext): Array<RouteSpec> => [
		...create_rpc_endpoint({
			path: RPC_PATH,
			actions: create_role_grant_offer_actions(ctx.deps, {
				roles: app_roles,
				authorize: options.authorize
			}),
			log: ctx.deps.log
		})
	];
