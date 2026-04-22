import './assert_dev_env.js';

/**
 * Standard admin integration test suite for fuz_app admin routes.
 *
 * `describe_standard_admin_integration_tests` creates a composable test suite
 * that exercises admin account listing, permit grant/revoke (via the RPC
 * surface — see `permit_offer_create` / `permit_revoke`), session/token
 * management, and audit log routes against a real PGlite database.
 *
 * Consumers call it with their route factory, session config, role schema,
 * and RPC endpoint specs — all admin route tests come for free.
 *
 * @module
 */

import {describe, test, assert, afterAll} from 'vitest';

import type {SessionOptions} from '../auth/session_cookie.js';
import type {AppServerContext, AppServerOptions} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {ROLE_KEEPER, ROLE_ADMIN, type RoleSchemaResult} from '../auth/role_schema.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import {create_test_app, type CreateTestAppOptions} from './app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
	type DbFactory,
} from './db.js';
import {find_auth_route, assert_response_matches_spec} from './integration_helpers.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';
import {
	ErrorCoverageCollector,
	assert_error_coverage,
	DEFAULT_INTEGRATION_ERROR_COVERAGE,
} from './error_coverage.js';
import type {RpcEndpointSpec} from '../http/surface.js';
import {rpc_call, require_rpc_endpoint_path} from './rpc_helpers.js';
import {
	permit_offer_create_action_spec,
	permit_revoke_action_spec,
} from '../auth/permit_offer_actions.js';
import {
	admin_account_list_action_spec,
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
} from '../auth/admin_actions.js';
import {query_grant_permit} from '../auth/permit_queries.js';
import {query_actor_by_account} from '../auth/account_queries.js';
import {query_accept_offer} from '../auth/permit_offer_queries.js';

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
	 * RPC endpoint specs — the source `RpcAction` arrays. Required; permit
	 * grant/revoke are RPC-only and the suite hard-fails without them.
	 */
	rpc_endpoints: Array<RpcEndpointSpec>;
	/**
	 * Path prefix where admin routes are mounted (e.g., `'/api/admin'`).
	 * Used by the schema validation test to scope to fuz_app admin routes only,
	 * avoiding app-specific admin-gated routes that may use stub deps.
	 * Default `'/api/admin'`.
	 */
	admin_prefix?: string;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: Partial<
		Omit<AppServerOptions, 'backend' | 'session_options' | 'create_route_specs'>
	>;
	/**
	 * Database factories to run tests against. Default: pglite only.
	 * Pass consumer factories (e.g. `[pglite_factory, pg_factory]`) to also test against PostgreSQL.
	 */
	db_factories?: Array<DbFactory>;
}

/**
 * Find an admin route by suffix, method, and role requirement.
 *
 * Disambiguates admin routes (e.g., `GET /admin/sessions`) from account-scoped
 * routes (e.g., `GET /account/sessions`) by checking `auth.type === 'role'`.
 */
const find_admin_route = (
	specs: Array<RouteSpec>,
	suffix: string,
	method: string,
): RouteSpec | undefined =>
	specs.find(
		(s) =>
			s.method === method &&
			s.path.endsWith(suffix) &&
			s.auth.type === 'role' &&
			s.auth.role === 'admin',
	);

/**
 * Pick a web-grantable role for testing, preferring a non-admin app-defined role.
 */
const pick_grantable_role = (
	role_options: ReadonlyMap<string, {web_grantable: boolean}>,
): string => {
	for (const [name, opts] of role_options) {
		if (opts.web_grantable && name !== ROLE_ADMIN) return name;
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
	app_options: {
		rpc_endpoints: options.rpc_endpoints,
		...options.app_options,
	},
});

/**
 * Standard admin integration test suite for fuz_app admin routes.
 *
 * Exercises account listing, permit grant/revoke (via RPC), session
 * management, token management, audit log routes, admin-to-admin isolation,
 * and response schema validation.
 *
 * @param options - session config, route factory, role schema, RPC endpoints
 */
export const describe_standard_admin_integration_tests = (
	options: StandardAdminIntegrationTestOptions,
): void => {
	// Hard-fail early so consumers see a clear setup error instead of a
	// confusing test failure when `rpc_endpoints` is missing.
	const rpc_path = require_rpc_endpoint_path(options.rpc_endpoints);

	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [AUTH_MIGRATION_NS]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];
	const describe_db = create_describe_db(factories, AUTH_INTEGRATION_TRUNCATE_TABLES);

	describe_db('standard_admin_integration', (get_db) => {
		const {cookie_name} = options.session_options;
		const {role_options} = options.roles;
		const grantable_role = pick_grantable_role(role_options);

		// Error coverage tracking across test groups
		const error_collector = new ErrorCoverageCollector();
		let captured_route_specs: Array<RouteSpec> | null = null;

		afterAll(() => {
			if (captured_route_specs) {
				// Scope coverage to admin auth-related routes.
				// Account listing, session/token revoke-all, audit-log reads and
				// invite CRUD are all RPC-only (see `admin_actions.ts`) and have
				// no REST suffix to scope to; only `/sessions` (SSE stream) and
				// `/audit-log/stream` remain.
				const admin_suffixes = ['/sessions', '/audit-log/stream'];
				const admin_routes = captured_route_specs.filter(
					(s) =>
						admin_suffixes.some((suffix) => s.path.endsWith(suffix)) &&
						s.auth.type === 'role' &&
						s.auth.role === 'admin',
				);
				assert_error_coverage(
					error_collector,
					admin_routes.length > 0 ? admin_routes : captured_route_specs,
					{min_coverage: DEFAULT_INTEGRATION_ERROR_COVERAGE},
				);
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
		 * Drive the full consent flow (admin offer → recipient accept) and
		 * return the materialized permit id. Accept is a direct transactional
		 * `query_accept_offer` call because the suite focuses on the admin
		 * side; exercising the recipient's UI-wired accept path is covered by
		 * `describe_rpc_round_trip_tests` + fuz_app's own action suite.
		 */
		const offer_and_accept = async (args: {
			app: Parameters<typeof rpc_call>[0]['app'];
			admin_headers: Record<string, string>;
			to_account_id: string;
			role: string;
		}): Promise<{offer_id: string; permit_id: string}> => {
			const res = await rpc_call({
				app: args.app,
				path: rpc_path,
				method: permit_offer_create_action_spec.method,
				params: {to_account_id: args.to_account_id, role: args.role},
				headers: args.admin_headers,
			});
			assert.ok(res.ok, `permit_offer_create failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
			const offer = (res.result as {offer: {id: string}}).offer;
			const accept_result = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{offer_id: offer.id, to_account_id: args.to_account_id, ip: null},
				),
			);
			return {offer_id: offer.id, permit_id: accept_result.permit.id};
		};

		// --- 1. Admin account listing (RPC) ---

		describe('admin account listing', () => {
			test('admin can list all accounts', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const user_two = await test_app.create_account({username: 'user_two'});

				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_account_list_action_spec.method,
					headers: test_app.create_session_headers(),
				});

				assert.ok(res.ok, `admin_account_list failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
				const result = res.result as {
					accounts: Array<{account: {id: string}}>;
					grantable_roles: Array<string>;
				};
				assert.ok(Array.isArray(result.accounts), 'Expected accounts array');
				assert.ok(result.accounts.length >= 2, 'Expected at least 2 accounts');
				assert.ok(Array.isArray(result.grantable_roles), 'Expected grantable_roles array');

				// Verify user_two appears in the listing
				const found = result.accounts.find((e) => e.account.id === user_two.account.id);
				assert.ok(found, 'Expected user_two in accounts listing');
			});

			test('non-admin cannot list accounts', async () => {
				const test_app = await create_test_app(
					build_admin_test_app_options(options, get_db(), [ROLE_KEEPER]),
				);
				captured_route_specs ??= test_app.route_specs;

				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_account_list_action_spec.method,
					headers: test_app.create_session_headers(),
				});

				assert.ok(!res.ok, 'Expected admin_account_list to fail for non-admin');
				assert.strictEqual(res.status, 403);
			});
		});

		// --- 2. Permit grant/revoke lifecycle ---
		// Permit grant/revoke are RPC-only (see `permit_offer_create` /
		// `permit_revoke`). End-to-end coverage lives in
		// `describe_rpc_round_trip_tests` + fuz_app's own
		// `permit_offer_actions.db.test.ts` /
		// `permit_offer_actions.notifications.revoke.db.test.ts`. The
		// audit/isolation groups below exercise them as preconditions for
		// cross-cutting checks (event emission, admin-to-admin isolation).

		// --- 3. Admin session management ---

		describe('admin session management', () => {
			test('admin can list all active sessions', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const sessions_route = find_admin_route(test_app.route_specs, '/sessions', 'GET');
				assert.ok(
					sessions_route,
					'Expected admin GET /sessions route — ensure create_route_specs includes admin routes',
				);

				await test_app.create_account({username: 'user_two'});

				const res = await test_app.app.request(sessions_route.path, {
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(Array.isArray(body.sessions), 'Expected sessions array');
				assert.ok(body.sessions.length >= 2, 'Expected sessions from multiple accounts');
			});

			test('admin can revoke all sessions for another account', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});

				// Verify user_two's session works
				const before = await test_app.app.request(verify_route.path, {
					headers: create_headers(user_two.session_cookie),
				});
				assert.strictEqual(before.status, 200);

				// Admin revokes all sessions for user_two via RPC
				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_session_revoke_all_action_spec.method,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				const result = res.result as {ok: true; count: number};
				assert.strictEqual(result.ok, true);
				assert.ok(result.count >= 1, 'Expected at least 1 revoked session');

				// Verify user_two's session no longer works
				const after = await test_app.app.request(verify_route.path, {
					headers: create_headers(user_two.session_cookie),
				});
				assert.strictEqual(after.status, 401);
			});

			test('admin revoking own sessions invalidates own session', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				// Admin revokes own sessions via RPC
				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_session_revoke_all_action_spec.method,
					params: {account_id: test_app.backend.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				const result = res.result as {ok: true; count: number};
				assert.strictEqual(result.ok, true);
				assert.ok(result.count >= 1, 'Expected at least 1 revoked session');

				// Admin's own session should no longer work
				const after = await test_app.app.request(verify_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(after.status, 401);
			});
		});

		// --- 4. Admin token management ---

		describe('admin token management', () => {
			test('admin can revoke all tokens for another account', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});

				// Verify user_two's bearer token works
				const before = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost', authorization: `Bearer ${user_two.api_token}`},
				});
				assert.strictEqual(before.status, 200);

				// Admin revokes all tokens for user_two via RPC
				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_token_revoke_all_action_spec.method,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_token_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				const result = res.result as {ok: true; count: number};
				assert.strictEqual(result.ok, true);
				assert.ok(result.count >= 1, 'Expected at least 1 revoked token');

				// Verify user_two's bearer token no longer works
				const after = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost', authorization: `Bearer ${user_two.api_token}`},
				});
				assert.strictEqual(after.status, 401);
			});
		});

		// --- 5. Audit log routes ---

		describe('audit log routes', () => {
			test('admin can list audit log events', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				const res = await test_app.app.request(audit_route.path, {
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(Array.isArray(body.events), 'Expected events array');
			});

			test('audit log supports event_type filter', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				// Admin offer emits `permit_offer_create`. The downstream
				// `permit_grant` only fires on accept — out of scope for this test.
				const user_two = await test_app.create_account({username: 'user_two'});
				const offer_res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: permit_offer_create_action_spec.method,
					params: {to_account_id: user_two.account.id, role: grantable_role},
					headers: test_app.create_session_headers(),
				});
				assert.ok(offer_res.ok, 'permit_offer_create should succeed');

				// Filter by event_type
				const res = await test_app.app.request(
					`${audit_route.path}?event_type=permit_offer_create`,
					{headers: test_app.create_session_headers()},
				);

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(Array.isArray(body.events));
				assert.ok(body.events.length >= 1, 'Expected at least 1 permit_offer_create event');
				for (const event of body.events) {
					assert.strictEqual(event.event_type, 'permit_offer_create');
				}
			});

			test('admin can view permit history', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const history_route = find_admin_route(
					test_app.route_specs,
					'/audit-log/permit-history',
					'GET',
				);
				assert.ok(
					history_route,
					'Expected admin GET /audit-log/permit-history route — ensure create_route_specs includes admin routes',
				);

				// Drive the full consent flow so `permit_grant` lands in the audit log
				// — `query_audit_log_list_permit_history` filters to (permit_grant, permit_revoke).
				const user_two = await test_app.create_account({username: 'user_two'});
				await offer_and_accept({
					app: test_app.app,
					admin_headers: test_app.create_session_headers(),
					to_account_id: user_two.account.id,
					role: grantable_role,
				});

				const res = await test_app.app.request(history_route.path, {
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(Array.isArray(body.events), 'Expected events array');
				assert.ok(body.events.length >= 1, 'Expected at least 1 permit history event');
			});
		});

		// --- 6. Admin audit trail ---

		describe('admin audit trail', () => {
			test('permit revoke creates audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(audit_route, 'Expected admin GET /audit-log route');

				const user_two = await test_app.create_account({username: 'user_two'});
				const target_actor = await query_actor_by_account({db: get_db()}, user_two.account.id);
				assert.ok(target_actor);
				const permit = await query_grant_permit(
					{db: get_db()},
					{
						actor_id: target_actor.id,
						role: grantable_role,
						granted_by: test_app.backend.actor.id,
					},
				);

				// Revoke via RPC
				const revoke_res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: permit_revoke_action_spec.method,
					params: {actor_id: target_actor.id, permit_id: permit.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`permit_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// Check audit log for permit_revoke event
				const audit_res = await test_app.app.request(
					`${audit_route.path}?event_type=permit_revoke`,
					{headers: test_app.create_session_headers()},
				);
				assert.strictEqual(audit_res.status, 200);
				const audit_body = await audit_res.json();
				assert.ok(audit_body.events.length >= 1, 'Expected permit_revoke audit event');
				assert.strictEqual(audit_body.events[0].event_type, 'permit_revoke');
			});

			test('admin session revoke-all creates audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});

				// Revoke all sessions for user_two via RPC
				const revoke_res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_session_revoke_all_action_spec.method,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`admin_session_revoke_all failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// Check audit log
				const audit_res = await test_app.app.request(
					`${audit_route.path}?event_type=session_revoke_all`,
					{headers: test_app.create_session_headers()},
				);
				assert.strictEqual(audit_res.status, 200);
				const audit_body = await audit_res.json();
				assert.ok(audit_body.events.length >= 1, 'Expected session_revoke_all audit event');
				assert.strictEqual(audit_body.events[0].event_type, 'session_revoke_all');
			});

			test('admin token revoke-all creates audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});

				// Revoke all tokens for user_two via RPC
				const revoke_res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_token_revoke_all_action_spec.method,
					params: {account_id: user_two.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`admin_token_revoke_all failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// Check audit log
				const audit_res = await test_app.app.request(
					`${audit_route.path}?event_type=token_revoke_all`,
					{headers: test_app.create_session_headers()},
				);
				assert.strictEqual(audit_res.status, 200);
				const audit_body = await audit_res.json();
				assert.ok(audit_body.events.length >= 1, 'Expected token_revoke_all audit event');
				assert.strictEqual(audit_body.events[0].event_type, 'token_revoke_all');
			});
		});

		// --- 7. Audit log completeness ---

		describe('audit log completeness', () => {
			test('auth mutations each produce exactly one audit event', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				const create_token_route = find_auth_route(test_app.route_specs, '/tokens/create', 'POST');
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(audit_route, 'Expected admin GET /audit-log route');

				// skip if required routes are missing (consumer may not wire all routes)
				if (!login_route || !logout_route || !create_token_route || !password_route) return;

				const user_two = await test_app.create_account({username: 'audit_user'});
				const admin_headers = test_app.create_session_headers({
					'content-type': 'application/json',
				});

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

				// 3. offer permit (admin offers grantable_role to user_two) — full
				// consentful flow: offer + accept so both `permit_offer_create` and
				// `permit_grant` audit events land.
				const {permit_id} = await offer_and_accept({
					app: test_app.app,
					admin_headers: test_app.create_session_headers(),
					to_account_id: user_two.account.id,
					role: grantable_role,
				});

				// 4. revoke permit (RPC)
				const target_actor = await query_actor_by_account({db: get_db()}, user_two.account.id);
				assert.ok(target_actor);
				const revoke_res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: permit_revoke_action_spec.method,
					params: {actor_id: target_actor.id, permit_id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`permit_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				// 5. create token
				await test_app.app.request(create_token_route.path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({name: 'audit-test-token'}),
				});

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

				const audit_res = await test_app.app.request(audit_route.path, {
					headers: relogin_headers,
				});
				assert.strictEqual(audit_res.status, 200);
				const audit_body = await audit_res.json();
				const events = audit_body.events as Array<{event_type: string}>;

				// check that each operation produced at least one event.
				// `permit_offer_create` fires on the admin RPC; `permit_grant`
				// fires when the recipient accepts (driven by offer_and_accept).
				const expected_types = [
					'login',
					'logout',
					'permit_offer_create',
					'permit_offer_accept',
					'permit_grant',
					'permit_revoke',
					'token_create',
					'password_change',
				];
				for (const event_type of expected_types) {
					const found = events.filter((e) => e.event_type === event_type);
					assert.ok(
						found.length >= 1,
						`Expected at least 1 '${event_type}' audit event, found ${found.length}. ` +
							`This may indicate audit_log_fire_and_forget was removed from a handler.`,
					);
				}
			});
		});

		// --- 8. Admin-to-admin isolation ---

		describe('admin-to-admin isolation', () => {
			test('admin B revoking own permit via RPC succeeds', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				captured_route_specs ??= test_app.route_specs;

				// Bootstrap user is admin A. Create admin B.
				const admin_b = await test_app.create_account({
					username: 'admin_b_iso',
					roles: ['admin'],
				});

				// Seed an active permit directly — the revoke IDOR check is the
				// subject of this test, not the grant→accept cycle.
				const permit = await query_grant_permit(
					{db: get_db()},
					{
						actor_id: admin_b.actor.id,
						role: grantable_role,
						granted_by: test_app.backend.actor.id,
					},
				);

				// Admin B revokes their own permit via RPC — should succeed
				const revoke_res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: permit_revoke_action_spec.method,
					params: {actor_id: admin_b.actor.id, permit_id: permit.id},
					headers: create_headers(admin_b.session_cookie),
				});
				assert.ok(
					revoke_res.ok,
					`permit_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);
				const result = revoke_res.result as {ok: true; revoked: true};
				assert.strictEqual(result.revoked, true);
			});

			test('admin revoke-all sessions for another admin works', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const admin_b = await test_app.create_account({
					username: 'admin_b_sess',
					roles: ['admin'],
				});

				// Admin A revokes all of admin B's sessions via RPC
				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_session_revoke_all_action_spec.method,
					params: {account_id: admin_b.account.id},
					headers: create_headers(test_app.backend.session_cookie),
				});
				assert.ok(
					res.ok,
					`admin_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				const result = res.result as {ok: true; count: number};
				assert.ok(typeof result.count === 'number', 'Expected count field in response');
				assert.ok(result.count >= 1, 'Expected at least 1 session revoked');
			});

			test('admin revoke-all tokens for another admin works', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const admin_b = await test_app.create_account({
					username: 'admin_b_tok',
					roles: ['admin'],
				});

				// Admin B creates an API token
				const token_create_route = test_app.route_specs.find(
					(s) => s.method === 'POST' && s.path.endsWith('/tokens/create'),
				);
				if (token_create_route) {
					await test_app.app.request(token_create_route.path, {
						method: 'POST',
						headers: create_headers(admin_b.session_cookie, {
							'content-type': 'application/json',
						}),
						body: JSON.stringify({name: 'admin-b-token'}),
					});
				}

				// Admin A revokes all of admin B's tokens via RPC
				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_token_revoke_all_action_spec.method,
					params: {account_id: admin_b.account.id},
					headers: create_headers(test_app.backend.session_cookie),
				});
				assert.ok(
					res.ok,
					`admin_token_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);
				const result = res.result as {ok: true; count: number};
				assert.ok(typeof result.count === 'number', 'Expected count field in response');
			});

			test('non-admin cannot access admin routes for another account', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const regular_user = await test_app.create_account({username: 'regular_user_iso'});

				// Regular user tries to list accounts via the admin RPC — should 403
				const res = await rpc_call({
					app: test_app.app,
					path: rpc_path,
					method: admin_account_list_action_spec.method,
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
				const prefix = options.admin_prefix ?? '/api/admin';
				const admin_routes = test_app.route_specs.filter(
					(s) => s.path.startsWith(prefix) && s.auth.type === 'role' && s.auth.role === 'admin',
				);

				// Hit admin routes without auth to exercise 401 error schemas
				for (const route of admin_routes.slice(0, 5)) {
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

		// --- 8. Admin response schema validation ---

		describe('admin response schema validation', () => {
			test('admin route 200 responses match declared output schemas', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const prefix = options.admin_prefix ?? '/api/admin';
				const admin_get_routes = test_app.route_specs.filter(
					(s) =>
						s.method === 'GET' &&
						s.path.startsWith(prefix) &&
						s.auth.type === 'role' &&
						s.auth.role === 'admin',
				);
				assert.ok(
					admin_get_routes.length > 0,
					'Expected at least one admin GET route — ensure create_route_specs includes admin routes',
				);

				for (const route of admin_get_routes) {
					const res = await test_app.app.request(route.path, {
						headers: test_app.create_session_headers(),
					});
					assert.strictEqual(res.status, 200, `${route.method} ${route.path} should return 200`);

					await assert_response_matches_spec(test_app.route_specs, route.method, route.path, res);
				}
			});
		});
	});
};
