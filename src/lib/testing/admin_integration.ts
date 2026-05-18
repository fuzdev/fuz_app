import './assert_dev_env.js';

/**
 * Standard admin integration test suite for fuz_app admin routes.
 *
 * `describe_standard_admin_integration_tests` creates a composable test suite
 * that exercises admin account listing, role_grant grant/revoke (via the RPC
 * surface — see `role_grant_offer_create` / `role_grant_revoke`), session/token
 * management, and audit log routes against a real PGlite database.
 *
 * Consumers call it with their route factory, session config, role schema,
 * and RPC endpoint specs — all admin route tests come for free.
 *
 * Scope: admin *semantics* — cross-admin isolation, role_grant grant/revoke
 * flow, session/token revoke-all, audit writes. Output-schema conformance
 * for admin methods is **not** the concern of this suite; it lives in:
 *
 * - `describe_rpc_round_trip_tests` — every RPC method (admin methods
 *   included) is hit with a spec-generated valid body and the 2xx result
 *   is validated against `spec.output`.
 * - `describe_round_trip_validation` — every REST route is hit and
 *   validated against its declared `output` / error schemas (SSE routes
 *   skipped via `Content-Type: text/event-stream`).
 * - `describe_sse_route_tests` — SSE frames validated against their
 *   declared `EventSpec`.
 *
 * @module
 */

import {describe, test, assert, afterAll} from 'vitest';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {SessionOptions} from '../auth/session_cookie.js';
import type {AppServerContext} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {ROLE_KEEPER, ROLE_ADMIN, type RoleSchemaResult} from '../auth/role_schema.js';
import {GRANT_PATH_ADMIN} from '../auth/grant_path_schema.js';
import {auth_migration_ns} from '../auth/migrations.js';
import {
	create_test_app,
	type CreateTestAppOptions,
	type SuiteAppOptions,
	type TestAccount,
	type TestApp,
} from './app_server.js';
import {create_test_role_grant_direct} from './db_entities.js';
import {role_grant_offer_and_accept} from './role_grant_helpers.js';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
	type DbFactory,
} from './db.js';
import {find_auth_route} from './integration_helpers.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';
import {
	ErrorCoverageCollector,
	assert_error_coverage,
	DEFAULT_INTEGRATION_ERROR_COVERAGE,
} from './error_coverage.js';
import {
	rpc_call_for_spec,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcCallArgs,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.js';
import {
	role_grant_offer_create_action_spec,
	role_grant_revoke_action_spec,
} from '../auth/role_grant_offer_action_specs.js';
import {
	admin_account_list_action_spec,
	admin_session_list_action_spec,
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	audit_log_list_action_spec,
	audit_log_role_grant_history_action_spec,
} from '../auth/admin_action_specs.js';
import {
	account_token_create_action_spec,
	account_verify_action_spec,
} from '../auth/account_action_specs.js';

/**
 * Configuration for `describe_standard_admin_integration_tests`.
 */
export interface StandardAdminIntegrationTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Role schema result from `create_role_schema()` — used to determine valid/invalid/web-grantable roles. */
	roles: RoleSchemaResult;
	/**
	 * RPC endpoint specs — the source `RpcAction` arrays. Required; role_grant
	 * grant/revoke are RPC-only and the suite hard-fails without them.
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` — the factory form
	 * is required when action handlers must close over the per-test
	 * `ctx.app_settings` / `ctx.deps` (e.g. the canonical
	 * `create_standard_rpc_actions(ctx.deps, {app_settings: ctx.app_settings})`
	 * pattern). The factory must return the same endpoint `path` regardless
	 * of ctx — it is invoked once at setup with a stub ctx for path lookup
	 * and again per-test by `create_app_server` for live dispatch.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Path prefix where admin routes are mounted (e.g., `'/api/admin'`).
	 * Used by the 401/403 error-coverage probe to scope to fuz_app admin
	 * routes only, avoiding app-specific admin-gated routes that may use
	 * stub deps. Default `'/api/admin'`.
	 */
	admin_prefix?: string;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: SuiteAppOptions;
	/**
	 * Database factories to run tests against. Default: pglite only.
	 * Pass consumer factories (e.g. `[pglite_factory, pg_factory]`) to also test against PostgreSQL.
	 */
	db_factories?: Array<DbFactory>;
}

/**
 * Pick a role for admin-grant testing, preferring a non-admin app-defined
 * role whose `RoleSpec.grant_paths` includes `'admin'` (the
 * `GRANT_PATH_ADMIN` constant). Falls back to `ROLE_ADMIN` when no
 * app-defined admin-grant-path role is registered.
 */
const pick_grantable_role = (
	role_specs: ReadonlyMap<string, {grant_paths?: ReadonlyArray<string>}>,
): string => {
	for (const [name, spec] of role_specs) {
		if (spec.grant_paths?.includes(GRANT_PATH_ADMIN) && name !== ROLE_ADMIN) return name;
	}
	return ROLE_ADMIN; // fallback
};

/**
 * Build `CreateTestAppOptions` from admin test options plus a database and roles.
 */
const build_admin_test_app_options = (
	options: StandardAdminIntegrationTestOptions,
	db: Db,
	roles?: Array<string>,
): CreateTestAppOptions => ({
	session_options: options.session_options,
	create_route_specs: options.create_route_specs,
	db,
	roles: roles ?? [ROLE_KEEPER, ROLE_ADMIN],
	rpc_endpoints: options.rpc_endpoints,
	app_options: options.app_options,
});

/**
 * Standard admin integration test suite for fuz_app admin routes.
 *
 * Exercises account listing, role_grant grant/revoke (via RPC), session
 * management, token management, audit log reads, admin-to-admin
 * isolation, and 401/403 error-coverage on the admin REST surface.
 * Output-schema conformance is not in scope — see the module docstring
 * for the suites that cover it.
 *
 * @throws Error at setup time when `options.rpc_endpoints` is empty — admin
 *   role_grant grant/revoke, session/token revoke-all, and audit-log reads
 *   are RPC-only. Hard-fails via `require_rpc_endpoint_path` so consumers
 *   see a clear setup error rather than `method not found` mid-suite.
 */
export const describe_standard_admin_integration_tests = (
	options: StandardAdminIntegrationTestOptions,
): void => {
	// Hard-fail early so consumers see a clear setup error instead of a
	// confusing test failure when `rpc_endpoints` is missing. Factory-form
	// callers are resolved with a stub ctx purely to extract the endpoint
	// path; real handlers run per-test via the top-level `rpc_endpoints`
	// slot on `CreateTestAppOptions`.
	const rpc_endpoints_for_setup = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_options,
	);
	const rpc_path = require_rpc_endpoint_path(rpc_endpoints_for_setup);

	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [auth_migration_ns]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];
	const describe_db = create_describe_db(factories, auth_integration_truncate_tables);

	describe_db('standard_admin_integration', (get_db) => {
		const {cookie_name} = options.session_options;
		const {role_specs} = options.roles;
		const grantable_role = pick_grantable_role(role_specs);

		// Error coverage tracking across test groups
		const error_collector = new ErrorCoverageCollector();
		let captured_route_specs: Array<RouteSpec> | null = null;

		afterAll(() => {
			if (captured_route_specs) {
				// Scope coverage to admin auth-related routes. Account listing,
				// session/token revoke-all, audit-log reads, and invite CRUD all
				// live on the RPC surface; the only admin REST route remaining
				// is the optional `GET /audit/stream` SSE (admin RPC methods
				// live behind spec-level role auth on the shared endpoint path).
				// The `/audit/stream` suffix tracks the hardcoded path in
				// `auth/audit_log_routes.ts` — if consumers ever need to mount
				// the audit SSE at a different suffix, promote this to an
				// `audit_log_path_suffix` option on
				// `StandardAdminIntegrationTestOptions`.
				const admin_routes = captured_route_specs.filter(
					(s) => s.path.endsWith('/audit/stream') && (s.auth.roles?.includes('admin') ?? false),
				);
				// Adaptive threshold: when the scoped admin REST surface is
				// effectively empty (0–1 routes — typical for the RPC-first
				// admin surface), the 20% baseline is meaningless — a single
				// SSE route that can't be exercised against an error schema
				// drops the ratio to 0.0%. Log an informational skip instead
				// of asserting.
				// The admin RPC surface is covered by
				// `describe_rpc_round_trip_tests`, not this collector.
				if (admin_routes.length <= 1) {
					console.log(
						`[error coverage] skipped admin REST coverage assertion — ` +
							`scoped surface has ${admin_routes.length} route(s); ` +
							`admin RPC surface is covered by describe_rpc_round_trip_tests`,
					);
					return;
				}
				assert_error_coverage(error_collector, admin_routes, {
					min_coverage: DEFAULT_INTEGRATION_ERROR_COVERAGE,
				});
			}
		});

		/** Make request headers for a given session cookie. */
		const create_headers = (session_cookie: string, extra?: Record<string, string>) => ({
			host: 'localhost',
			origin: 'http://localhost:5173',
			cookie: `${cookie_name}=${session_cookie}`,
			...extra,
		});

		/**
		 * Suite-local wrapper around `role_grant_offer_and_accept` that closes
		 * over `rpc_path` so call sites stay terse. See the shared helper for
		 * the cross-suite contract.
		 */
		const offer_and_accept = (args: {
			app: RpcCallArgs['app'];
			grantor: TestApp | TestAccount;
			recipient: TestAccount;
			role: string;
		}): Promise<{offer_id: Uuid; role_grant_id: Uuid}> =>
			role_grant_offer_and_accept({...args, rpc_path});

		// --- 1. Admin account listing (RPC) ---

		describe('admin account listing', () => {
			test('admin can list all accounts', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const user_two = await test_app.create_account({username: 'user_two'});

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_account_list_action_spec,
					params: {},
					headers: test_app.create_session_headers(),
				});

				assert.ok(res.ok, `admin_account_list failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
				assert.ok(Array.isArray(res.result.accounts), 'Expected accounts array');
				assert.ok(res.result.accounts.length >= 2, 'Expected at least 2 accounts');
				assert.ok(Array.isArray(res.result.grantable_roles), 'Expected grantable_roles array');

				// Verify user_two appears in the listing
				const found = res.result.accounts.find((e) => e.account.id === user_two.account.id);
				assert.ok(found, 'Expected user_two in accounts listing');
			});

			test('non-admin cannot list accounts', async () => {
				const test_app = await create_test_app(
					build_admin_test_app_options(options, get_db(), [ROLE_KEEPER]),
				);
				captured_route_specs ??= test_app.route_specs;

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_account_list_action_spec,
					params: {},
					headers: test_app.create_session_headers(),
				});

				assert.ok(!res.ok, 'Expected admin_account_list to fail for non-admin');
				assert.strictEqual(res.status, 403);
			});
		});

		// --- 2. Role grant create/revoke lifecycle ---
		// Role grant create/revoke are RPC-only (see `role_grant_offer_create` /
		// `role_grant_revoke`). End-to-end coverage lives in
		// `describe_rpc_round_trip_tests` + fuz_app's own
		// `role_grant_offer_actions.db.test.ts` /
		// `role_grant_offer_actions.notifications.revoke.db.test.ts`. The
		// audit/isolation groups below exercise them as preconditions for
		// cross-cutting checks (event emission, admin-to-admin isolation).

		// --- 3. Admin session management ---

		describe('admin session management', () => {
			test('admin can list all active sessions', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				await test_app.create_account({username: 'user_two'});

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_session_list_action_spec,
					params: {},
					headers: test_app.create_session_headers(),
				});

				assert.ok(res.ok, `admin_session_list failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
				assert.ok(Array.isArray(res.result.sessions), 'Expected sessions array');
				assert.ok(res.result.sessions.length >= 2, 'Expected sessions from multiple accounts');
			});

			test('admin can revoke all sessions for another account', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const user_two = await test_app.create_account({username: 'user_two'});

				// Verify user_two's session works via `account_verify` RPC
				const before = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: create_headers(user_two.session_cookie),
				});
				assert.strictEqual(before.status, 200);

				// Admin revokes all sessions for user_two via RPC
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_session_revoke_all_action_spec,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				assert.strictEqual(res.result.ok, true);
				assert.ok(res.result.count >= 1, 'Expected at least 1 revoked session');

				// Verify user_two's session no longer works
				const after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: create_headers(user_two.session_cookie),
				});
				assert.strictEqual(after.status, 401);
			});

			test('admin revoking own sessions invalidates own session', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				// Admin revokes own sessions via RPC
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_session_revoke_all_action_spec,
					params: {account_id: test_app.backend.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				assert.strictEqual(res.result.ok, true);
				assert.ok(res.result.count >= 1, 'Expected at least 1 revoked session');

				// Admin's own session should no longer work
				const after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(after.status, 401);
			});
		});

		// --- 4. Admin token management ---

		describe('admin token management', () => {
			test('admin can revoke all tokens for another account', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const user_two = await test_app.create_account({username: 'user_two'});

				// Verify user_two's bearer token works via `account_verify` RPC
				const before = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {authorization: `Bearer ${user_two.api_token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(before.status, 200);

				// Admin revokes all tokens for user_two via RPC
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_token_revoke_all_action_spec,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_token_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				assert.strictEqual(res.result.ok, true);
				assert.ok(res.result.count >= 1, 'Expected at least 1 revoked token');

				// Verify user_two's bearer token no longer works
				const after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {authorization: `Bearer ${user_two.api_token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(after.status, 401);
			});
		});

		// --- 5. Audit log RPC reads ---

		describe('audit log RPC reads', () => {
			test('admin can list audit log events', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {},
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, `audit_log_list failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
				assert.ok(Array.isArray(res.result.events), 'Expected events array');
			});

			test('audit log supports event_type filter', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				// Admin offer emits `role_grant_offer_create`. The downstream
				// `role_grant_create` only fires on accept — out of scope for this test.
				const user_two = await test_app.create_account({username: 'user_two'});
				const offer_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_offer_create_action_spec,
					params: {to_account_id: user_two.account.id, role: grantable_role},
					headers: test_app.create_session_headers(),
				});
				assert.ok(offer_res.ok, 'role_grant_offer_create should succeed');

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {event_type: 'role_grant_offer_create'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, `audit_log_list failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
				assert.ok(
					res.result.events.length >= 1,
					'Expected at least 1 role_grant_offer_create event',
				);
				for (const event of res.result.events) {
					assert.strictEqual(event.event_type, 'role_grant_offer_create');
				}
			});

			test('admin can view role_grant history', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				// Drive the full consent flow so `role_grant_create` lands in the audit log
				// — `query_audit_log_list_role_grant_history` filters to (role_grant_create, role_grant_revoke).
				const user_two = await test_app.create_account({username: 'user_two'});
				await offer_and_accept({
					app: test_app.app,
					grantor: test_app,
					recipient: user_two,
					role: grantable_role,
				});

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_role_grant_history_action_spec,
					params: {},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`audit_log_role_grant_history failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				assert.ok(res.result.events.length >= 1, 'Expected at least 1 role_grant history event');
			});
		});

		// --- 6. Admin audit trail ---

		describe('admin audit trail', () => {
			test('role_grant revoke creates audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const user_two = await test_app.create_account({username: 'user_two'});
				const role_grant = await create_test_role_grant_direct(get_db(), {
					actor_id: user_two.actor.id,
					role: grantable_role,
					granted_by: test_app.backend.actor.id,
				});

				// Revoke via RPC
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_revoke_action_spec,
					params: {actor_id: user_two.actor.id, role_grant_id: role_grant.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`role_grant_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// Check audit log for role_grant_revoke event
				const audit_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {event_type: 'role_grant_revoke'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					audit_res.ok,
					`audit_log_list failed: ${audit_res.ok ? '' : JSON.stringify(audit_res.error)}`,
				);
				assert.ok(audit_res.result.events.length >= 1, 'Expected role_grant_revoke audit event');
				assert.strictEqual(audit_res.result.events[0]!.event_type, 'role_grant_revoke');
			});

			test('admin session revoke-all creates audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const user_two = await test_app.create_account({username: 'user_two'});

				// Revoke all sessions for user_two via RPC
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_session_revoke_all_action_spec,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`admin_session_revoke_all failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// Check audit log
				const audit_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {event_type: 'session_revoke_all'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(audit_res.ok, 'audit_log_list should succeed');
				assert.ok(audit_res.result.events.length >= 1, 'Expected session_revoke_all audit event');
				assert.strictEqual(audit_res.result.events[0]!.event_type, 'session_revoke_all');
			});

			test('admin token revoke-all creates audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const user_two = await test_app.create_account({username: 'user_two'});

				// Revoke all tokens for user_two via RPC
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_token_revoke_all_action_spec,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`admin_token_revoke_all failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// Check audit log
				const audit_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {event_type: 'token_revoke_all'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(audit_res.ok, 'audit_log_list should succeed');
				assert.ok(audit_res.result.events.length >= 1, 'Expected token_revoke_all audit event');
				assert.strictEqual(audit_res.result.events[0]!.event_type, 'token_revoke_all');
			});

			test('admin session revoke-all 404 emits failure audit', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				// `Uuid = z.uuid()` is v4-strict; use a valid v4 shape so we hit the
				// handler's account lookup rather than failing at param validation.
				const missing_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01' as Uuid;

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_session_revoke_all_action_spec,
					params: {account_id: missing_id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(!res.ok, 'Expected 404 for missing account');
				assert.strictEqual(res.status, 404);
				assert.strictEqual((res.error.data as {reason: string}).reason, 'account_not_found');

				// Failure audit row should be visible on the audit-log feed.
				// `target_account_id` is null (FK prevents referencing a missing id)
				// — the probed id is preserved under `metadata.attempted_account_id`.
				const audit_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {event_type: 'session_revoke_all'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(audit_res.ok, 'audit_log_list should succeed');
				const failure = audit_res.result.events.find((e) => e.outcome === 'failure');
				assert.ok(failure, 'Expected a failure-outcome session_revoke_all audit event');
				assert.strictEqual(failure.target_account_id, null);
				const failure_meta = failure.metadata as {
					reason?: string;
					attempted_account_id?: string;
				};
				assert.strictEqual(failure_meta.reason, 'account_not_found');
				assert.strictEqual(failure_meta.attempted_account_id, missing_id);
			});

			test('admin token revoke-all 404 emits failure audit', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const missing_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02' as Uuid;

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_token_revoke_all_action_spec,
					params: {account_id: missing_id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(!res.ok, 'Expected 404 for missing account');
				assert.strictEqual(res.status, 404);
				assert.strictEqual((res.error.data as {reason: string}).reason, 'account_not_found');

				const audit_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {event_type: 'token_revoke_all'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(audit_res.ok, 'audit_log_list should succeed');
				const failure = audit_res.result.events.find((e) => e.outcome === 'failure');
				assert.ok(failure, 'Expected a failure-outcome token_revoke_all audit event');
				assert.strictEqual(failure.target_account_id, null);
				const failure_meta = failure.metadata as {
					reason?: string;
					attempted_account_id?: string;
				};
				assert.strictEqual(failure_meta.reason, 'account_not_found');
				assert.strictEqual(failure_meta.attempted_account_id, missing_id);
			});
		});

		// --- 7. Audit log completeness ---

		describe('audit log completeness', () => {
			test('auth mutations each produce at least one audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				// skip if required routes are missing (consumer may not wire all routes).
				// Token creation goes through `account_token_create` RPC — always wired
				// because `rpc_endpoints` is required at the suite level.
				if (!login_route || !logout_route || !password_route) return;

				const user_two = await test_app.create_account({username: 'audit_user'});

				// 1. login (user_two logs in)
				const login_res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({username: 'audit_user', password: 'test-password-123'}),
				});
				assert.strictEqual(login_res.status, 200);

				// extract user_two session cookie for logout
				const set_cookie = login_res.headers.get('set-cookie');
				const cookie_match = new RegExp(`${cookie_name}=([^;]+)`).exec(set_cookie ?? '');
				const user_two_cookie = cookie_match?.[1];

				// 2. logout (user_two logs out)
				if (user_two_cookie) {
					await test_app.app.request(logout_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							cookie: `${cookie_name}=${user_two_cookie}`,
						},
					});
				}

				// 3. offer role_grant (admin offers grantable_role to user_two) — full
				// consentful flow: offer + accept so both `role_grant_offer_create` and
				// `role_grant_create` audit events land.
				const {role_grant_id} = await offer_and_accept({
					app: test_app.app,
					grantor: test_app,
					recipient: user_two,
					role: grantable_role,
				});

				// 4. revoke role_grant (RPC)
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_revoke_action_spec,
					params: {actor_id: user_two.actor.id, role_grant_id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`role_grant_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// 5. create token (RPC)
				const token_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'audit-test-token'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					token_res.ok,
					`account_token_create failed: ${token_res.ok ? '' : JSON.stringify(token_res.error)}`,
				);

				// 6. password change
				await test_app.app.request(password_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers({
						'content-type': 'application/json',
					}),
					body: JSON.stringify({
						current_password: 'test-password-123',
						new_password: 'new-audit-password-789',
					}),
				});

				// query audit log and verify events
				// re-login as admin since password change revoked sessions
				const relogin_res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'new-audit-password-789',
					}),
				});
				assert.strictEqual(relogin_res.status, 200);
				const relogin_cookie_header = relogin_res.headers.get('set-cookie');
				const relogin_match = new RegExp(`${cookie_name}=([^;]+)`).exec(
					relogin_cookie_header ?? '',
				);
				assert.ok(relogin_match?.[1], 'Expected session cookie from re-login');
				const relogin_headers = {
					host: 'localhost',
					origin: 'http://localhost:5173',
					cookie: `${cookie_name}=${relogin_match[1]}`,
				};

				const audit_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: audit_log_list_action_spec,
					params: {},
					headers: relogin_headers,
				});
				assert.ok(
					audit_res.ok,
					`audit_log_list failed: ${audit_res.ok ? '' : JSON.stringify(audit_res.error)}`,
				);
				const events = audit_res.result.events;

				// check that each operation produced at least one event.
				// `role_grant_offer_create` fires on the admin RPC; `role_grant_create`
				// fires when the recipient accepts (driven by offer_and_accept).
				const expected_types = [
					'login',
					'logout',
					'role_grant_offer_create',
					'role_grant_offer_accept',
					'role_grant_create',
					'role_grant_revoke',
					'token_create',
					'password_change',
				];
				for (const event_type of expected_types) {
					const found = events.filter((e) => e.event_type === event_type);
					assert.ok(
						found.length >= 1,
						`Expected at least 1 '${event_type}' audit event, found ${found.length}. ` +
							`This may indicate a deps.audit.emit call was removed from a handler.`,
					);
				}
			});
		});

		// --- 8. Admin-to-admin isolation ---

		describe('admin-to-admin isolation', () => {
			test('admin B revoking own role_grant via RPC succeeds', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				captured_route_specs ??= test_app.route_specs;

				// Bootstrap user is admin A. Create admin B.
				const admin_b = await test_app.create_account({
					username: 'admin_b_iso',
					roles: ['admin'],
				});

				// Seed an active role_grant directly — the revoke IDOR check is the
				// subject of this test, not the grant→accept cycle.
				const role_grant = await create_test_role_grant_direct(get_db(), {
					actor_id: admin_b.actor.id,
					role: grantable_role,
					granted_by: test_app.backend.actor.id,
				});

				// Admin B revokes their own role_grant via RPC — should succeed
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_revoke_action_spec,
					params: {actor_id: admin_b.actor.id, role_grant_id: role_grant.id},
					headers: create_headers(admin_b.session_cookie),
				});
				assert.ok(
					revoke_res.ok,
					`role_grant_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);
				assert.strictEqual(revoke_res.result.revoked, true);
			});

			test('admin revoke-all sessions for another admin works', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const admin_b = await test_app.create_account({
					username: 'admin_b_sess',
					roles: ['admin'],
				});

				// Admin A revokes all of admin B's sessions via RPC
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_session_revoke_all_action_spec,
					params: {account_id: admin_b.account.id},
					headers: create_headers(test_app.backend.session_cookie),
				});
				assert.ok(
					res.ok,
					`admin_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				assert.ok(typeof res.result.count === 'number', 'Expected count field in response');
				assert.ok(res.result.count >= 1, 'Expected at least 1 session revoked');
			});

			test('admin revoke-all tokens for another admin works', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const admin_b = await test_app.create_account({
					username: 'admin_b_tok',
					roles: ['admin'],
				});

				// Admin B creates an API token via RPC
				const token_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'admin-b-token'},
					headers: create_headers(admin_b.session_cookie),
				});
				assert.ok(
					token_res.ok,
					`account_token_create failed: ${token_res.ok ? '' : JSON.stringify(token_res.error)}`,
				);

				// Admin A revokes all of admin B's tokens via RPC
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_token_revoke_all_action_spec,
					params: {account_id: admin_b.account.id},
					headers: create_headers(test_app.backend.session_cookie),
				});
				assert.ok(
					res.ok,
					`admin_token_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				assert.ok(typeof res.result.count === 'number', 'Expected count field in response');
				// Token was created above, so revoke should evict at least one.
				assert.ok(res.result.count >= 1, 'Expected at least 1 token revoked');
			});

			test('non-admin cannot access admin routes for another account', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const regular_user = await test_app.create_account({username: 'regular_user_iso'});

				// Regular user tries to list accounts via the admin RPC — should 403
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_account_list_action_spec,
					params: {},
					headers: create_headers(regular_user.session_cookie),
				});
				assert.ok(!res.ok, 'Expected admin_account_list to fail for non-admin');
				assert.strictEqual(res.status, 403);
			});
		});

		// --- 8a. Error coverage: unauthenticated access to admin routes ---

		describe('error coverage breadth', () => {
			test('exercises 401/403 on admin routes for error coverage', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				captured_route_specs ??= test_app.route_specs;
				// `/api/admin` is nearly empty — admin reads and mutations live
				// on the RPC endpoint behind spec-level role auth. The path-prefix carve is still the right scope here
				// because error coverage is tracked against REST `RouteSpec`s,
				// not RPC method specs (`describe_rpc_round_trip_tests` covers
				// the admin RPC surface separately).
				const prefix = options.admin_prefix ?? '/api/admin';
				const admin_routes = test_app.route_specs.filter(
					(s) => s.path.startsWith(prefix) && (s.auth.roles?.includes('admin') ?? false),
				);

				// Hit admin routes without auth to exercise 401 error schemas.
				for (const route of admin_routes) {
					const res = await test_app.app.request(route.path, {
						method: route.method,
						headers: {host: 'localhost'},
					});
					if (res.status === 401 || res.status === 403) {
						error_collector.record(test_app.route_specs, route.method, route.path, res.status);
					}
				}
			});
		});
	});
};
