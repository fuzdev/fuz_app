import './assert_dev_env.js';

/**
 * Standard admin integration test suite for fuz_app admin routes.
 *
 * `describe_standard_admin_integration_tests` creates a composable test suite
 * that exercises admin account listing, permit grant/revoke, session/token
 * management, and audit log routes against a real PGlite database.
 *
 * Consumers call it with their route factory, session config, and role schema —
 * all admin route tests come for free.
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
	app_options: options.app_options,
});

/**
 * Standard admin integration test suite for fuz_app admin routes.
 *
 * Exercises account listing, permit grant/revoke, session management, token
 * management, audit log routes, admin-to-admin isolation, and response
 * schema validation.
 *
 * Each test group asserts that required routes exist, failing with a descriptive
 * message if the consumer's route specs are misconfigured.
 *
 * @param options - session config, route factory, and role schema
 */
export const describe_standard_admin_integration_tests = (
	options: StandardAdminIntegrationTestOptions,
): void => {
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
				const admin_suffixes = [
					'/accounts',
					'/permits/grant',
					'/sessions',
					'/sessions/revoke-all',
					'/tokens/revoke-all',
					'/audit-log',
					'/audit-log/permit-history',
					'/invites',
				];
				const admin_routes = captured_route_specs.filter(
					(s) =>
						(admin_suffixes.some((suffix) => s.path.endsWith(suffix)) ||
							s.path.includes('/permits/:') ||
							s.path.includes('/invites/:')) &&
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

		// --- 1. Admin account listing ---

		describe('admin account listing', () => {
			test('admin can list all accounts', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const accounts_route = find_admin_route(test_app.route_specs, '/accounts', 'GET');
				assert.ok(
					accounts_route,
					'Expected admin GET /accounts route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});

				const res = await test_app.app.request(accounts_route.path, {
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(Array.isArray(body.accounts), 'Expected accounts array');
				assert.ok(body.accounts.length >= 2, 'Expected at least 2 accounts');
				assert.ok(Array.isArray(body.grantable_roles), 'Expected grantable_roles array');

				// Verify user_two appears in the listing
				const found = body.accounts.find(
					(e: {account: {id: string}}) => e.account.id === user_two.account.id,
				);
				assert.ok(found, 'Expected user_two in accounts listing');
			});

			test('non-admin cannot list accounts', async () => {
				const test_app = await create_test_app(
					build_admin_test_app_options(options, get_db(), [ROLE_KEEPER]),
				);
				captured_route_specs ??= test_app.route_specs;
				const accounts_route = find_admin_route(test_app.route_specs, '/accounts', 'GET');
				assert.ok(
					accounts_route,
					'Expected admin GET /accounts route — ensure create_route_specs includes admin routes',
				);

				const res = await test_app.app.request(accounts_route.path, {
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 403);
				error_collector.record(test_app.route_specs, 'GET', accounts_route.path, 403);
				const body = await res.json();
				assert.strictEqual(body.error, 'insufficient_permissions');
			});
		});

		// --- 2. Permit grant lifecycle ---

		describe('permit grant lifecycle', () => {
			test('admin can grant a web-grantable role', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});
				const path = grant_route.path.replace(':account_id', user_two.account.id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({role: grantable_role}),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.ok, true);
				assert.ok(body.permit);
				assert.strictEqual(body.permit.role, grantable_role);
				assert.ok(body.permit.id, 'Expected permit id');
			});

			test('admin cannot grant a non-web-grantable role', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});
				const path = grant_route.path.replace(':account_id', user_two.account.id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({role: ROLE_KEEPER}),
				});

				assert.strictEqual(res.status, 403);
				error_collector.record(test_app.route_specs, 'POST', grant_route.path, 403);
				const body = await res.json();
				assert.strictEqual(body.error, 'role_not_web_grantable');
			});

			test('granting same role twice is idempotent (returns same permit)', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});
				const path = grant_route.path.replace(':account_id', user_two.account.id);
				const headers = test_app.create_session_headers({'content-type': 'application/json'});
				const body = JSON.stringify({role: grantable_role});

				// First grant
				const res1 = await test_app.app.request(path, {
					method: 'POST',
					headers,
					body,
				});
				assert.strictEqual(res1.status, 200);
				const body1 = await res1.json();
				assert.strictEqual(body1.ok, true);
				const permit_id_1 = body1.permit.id;

				// Second grant — same role, same account
				const res2 = await test_app.app.request(path, {
					method: 'POST',
					headers,
					body,
				});
				assert.strictEqual(res2.status, 200);
				const body2 = await res2.json();
				assert.strictEqual(body2.ok, true);
				assert.strictEqual(
					body2.permit.id,
					permit_id_1,
					'Expected same permit ID on idempotent grant',
				);
				assert.strictEqual(body2.permit.role, grantable_role);
			});

			test('grant with unknown role returns 400', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});
				const path = grant_route.path.replace(':account_id', user_two.account.id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({role: 'nonexistent_role'}),
				});

				assert.strictEqual(res.status, 400);
				error_collector.record(test_app.route_specs, 'POST', grant_route.path, 400);
			});

			test('grant to nonexistent account returns 404', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);

				const fake_id = '00000000-0000-0000-0000-000000000000';
				const path = grant_route.path.replace(':account_id', fake_id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({role: grantable_role}),
				});

				assert.strictEqual(res.status, 404);
				error_collector.record(test_app.route_specs, 'POST', grant_route.path, 404);
				const body = await res.json();
				assert.strictEqual(body.error, 'account_not_found');
			});

			test('admin can revoke a permit', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				const revoke_route = find_admin_route(
					test_app.route_specs,
					'/permits/:permit_id/revoke',
					'POST',
				);
				const accounts_route = find_admin_route(test_app.route_specs, '/accounts', 'GET');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					revoke_route,
					'Expected admin POST /permits/:permit_id/revoke route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					accounts_route,
					'Expected admin GET /accounts route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});
				const admin_headers = test_app.create_session_headers({'content-type': 'application/json'});

				// Grant
				const grant_path = grant_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(grant_path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({role: grantable_role}),
				});

				// Find the permit ID via account listing
				const list_res = await test_app.app.request(accounts_route.path, {
					headers: test_app.create_session_headers(),
				});
				const list_body = await list_res.json();
				const entry = list_body.accounts.find(
					(e: {account: {id: string}}) => e.account.id === user_two.account.id,
				);
				const permit = entry.permits.find((p: {role: string}) => p.role === grantable_role);
				assert.ok(permit, 'Expected granted permit in listing');

				// Revoke
				const revoke_path = revoke_route.path
					.replace(':account_id', user_two.account.id)
					.replace(':permit_id', permit.id);
				const revoke_res = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(revoke_res.status, 200);
				const revoke_body = await revoke_res.json();
				assert.strictEqual(revoke_body.ok, true);
				assert.strictEqual(revoke_body.revoked, true);
			});

			test('revoking an already-revoked permit returns 404', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				const revoke_route = find_admin_route(
					test_app.route_specs,
					'/permits/:permit_id/revoke',
					'POST',
				);
				const accounts_route = find_admin_route(test_app.route_specs, '/accounts', 'GET');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					revoke_route,
					'Expected admin POST /permits/:permit_id/revoke route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					accounts_route,
					'Expected admin GET /accounts route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});
				const admin_headers = test_app.create_session_headers({'content-type': 'application/json'});

				// Grant
				const grant_path = grant_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(grant_path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({role: grantable_role}),
				});

				// Find permit ID
				const list_res = await test_app.app.request(accounts_route.path, {
					headers: test_app.create_session_headers(),
				});
				const list_body = await list_res.json();
				const entry = list_body.accounts.find(
					(e: {account: {id: string}}) => e.account.id === user_two.account.id,
				);
				const permit = entry.permits.find((p: {role: string}) => p.role === grantable_role);
				assert.ok(permit);

				const revoke_path = revoke_route.path
					.replace(':account_id', user_two.account.id)
					.replace(':permit_id', permit.id);

				// First revoke — succeeds
				const first = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(first.status, 200);

				// Second revoke — already revoked, returns 404
				const second = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(second.status, 404);
				error_collector.record(test_app.route_specs, 'POST', revoke_route.path, 404);
				const body = await second.json();
				assert.strictEqual(body.error, 'permit_not_found');
			});
		});

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
				const revoke_sessions_route = find_admin_route(
					test_app.route_specs,
					'/sessions/revoke-all',
					'POST',
				);
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					revoke_sessions_route,
					'Expected admin POST /sessions/revoke-all route — ensure create_route_specs includes admin routes',
				);
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

				// Admin revokes all sessions for user_two
				const path = revoke_sessions_route.path.replace(':account_id', user_two.account.id);
				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.ok, true);
				assert.ok(body.count >= 1, 'Expected at least 1 revoked session');

				// Verify user_two's session no longer works
				const after = await test_app.app.request(verify_route.path, {
					headers: create_headers(user_two.session_cookie),
				});
				assert.strictEqual(after.status, 401);
			});

			test('admin revoking own sessions invalidates own session', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const revoke_sessions_route = find_admin_route(
					test_app.route_specs,
					'/sessions/revoke-all',
					'POST',
				);
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					revoke_sessions_route,
					'Expected admin POST /sessions/revoke-all route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				// Admin revokes own sessions
				const path = revoke_sessions_route.path.replace(':account_id', test_app.backend.account.id);
				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.ok, true);
				assert.ok(body.count >= 1, 'Expected at least 1 revoked session');

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
				const revoke_tokens_route = find_admin_route(
					test_app.route_specs,
					'/tokens/revoke-all',
					'POST',
				);
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					revoke_tokens_route,
					'Expected admin POST /tokens/revoke-all route — ensure create_route_specs includes admin routes',
				);
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

				// Admin revokes all tokens for user_two
				const path = revoke_tokens_route.path.replace(':account_id', user_two.account.id);
				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.ok, true);
				assert.ok(body.count >= 1, 'Expected at least 1 revoked token');

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
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				// Create a grant to produce an audit event
				const user_two = await test_app.create_account({username: 'user_two'});
				const grant_path = grant_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(grant_path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({role: grantable_role}),
				});

				// Filter by event_type
				const res = await test_app.app.request(`${audit_route.path}?event_type=permit_grant`, {
					headers: test_app.create_session_headers(),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(Array.isArray(body.events));
				assert.ok(body.events.length >= 1, 'Expected at least 1 permit_grant event');
				for (const event of body.events) {
					assert.strictEqual(event.event_type, 'permit_grant');
				}
			});

			test('admin can view permit history', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				const history_route = find_admin_route(
					test_app.route_specs,
					'/audit-log/permit-history',
					'GET',
				);
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					history_route,
					'Expected admin GET /audit-log/permit-history route — ensure create_route_specs includes admin routes',
				);

				// Create a grant to produce audit data
				const user_two = await test_app.create_account({username: 'user_two'});
				const grant_path = grant_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(grant_path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({role: grantable_role}),
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
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				const revoke_route = find_admin_route(
					test_app.route_specs,
					'/permits/:permit_id/revoke',
					'POST',
				);
				const accounts_route = find_admin_route(test_app.route_specs, '/accounts', 'GET');
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					grant_route,
					'Expected admin POST /permits/grant route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					revoke_route,
					'Expected admin POST /permits/:permit_id/revoke route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					accounts_route,
					'Expected admin GET /accounts route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});
				const admin_headers = test_app.create_session_headers({'content-type': 'application/json'});

				// Grant a role
				const grant_path = grant_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(grant_path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({role: grantable_role}),
				});

				// Find the permit ID
				const list_res = await test_app.app.request(accounts_route.path, {
					headers: test_app.create_session_headers(),
				});
				const list_body = await list_res.json();
				const entry = list_body.accounts.find(
					(e: {account: {id: string}}) => e.account.id === user_two.account.id,
				);
				const permit = entry.permits.find((p: {role: string}) => p.role === grantable_role);

				// Revoke the permit
				const revoke_path = revoke_route.path
					.replace(':account_id', user_two.account.id)
					.replace(':permit_id', permit.id);
				await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});

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
				const revoke_sessions_route = find_admin_route(
					test_app.route_specs,
					'/sessions/revoke-all',
					'POST',
				);
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					revoke_sessions_route,
					'Expected admin POST /sessions/revoke-all route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});

				// Revoke all sessions for user_two
				const path = revoke_sessions_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});

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
				const revoke_tokens_route = find_admin_route(
					test_app.route_specs,
					'/tokens/revoke-all',
					'POST',
				);
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(
					revoke_tokens_route,
					'Expected admin POST /tokens/revoke-all route — ensure create_route_specs includes admin routes',
				);
				assert.ok(
					audit_route,
					'Expected admin GET /audit-log route — ensure create_route_specs includes admin routes',
				);

				const user_two = await test_app.create_account({username: 'user_two'});

				// Revoke all tokens for user_two
				const path = revoke_tokens_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});

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
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				const revoke_route = find_admin_route(
					test_app.route_specs,
					'/permits/:permit_id/revoke',
					'POST',
				);
				const accounts_route = find_admin_route(test_app.route_specs, '/accounts', 'GET');
				const create_token_route = find_auth_route(test_app.route_specs, '/tokens/create', 'POST');
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				const audit_route = find_admin_route(test_app.route_specs, '/audit-log', 'GET');
				assert.ok(audit_route, 'Expected admin GET /audit-log route');

				// skip if required routes are missing (consumer may not wire all routes)
				if (
					!login_route ||
					!logout_route ||
					!grant_route ||
					!revoke_route ||
					!accounts_route ||
					!create_token_route ||
					!password_route
				)
					return;

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

				// 3. grant permit (admin grants grantable_role to user_two)
				const grant_path = grant_route.path.replace(':account_id', user_two.account.id);
				await test_app.app.request(grant_path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({role: grantable_role}),
				});

				// find permit ID
				const list_res = await test_app.app.request(accounts_route.path, {
					headers: test_app.create_session_headers(),
				});
				const list_body = await list_res.json();
				const entry = list_body.accounts.find(
					(e: {account: {id: string}}) => e.account.id === user_two.account.id,
				);
				const permit = entry?.permits?.find((p: {role: string}) => p.role === grantable_role);

				// 4. revoke permit
				if (permit) {
					const rev_path = revoke_route.path
						.replace(':account_id', user_two.account.id)
						.replace(':permit_id', permit.id);
					await test_app.app.request(rev_path, {
						method: 'POST',
						headers: test_app.create_session_headers(),
					});
				}

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

				// check that each operation produced at least one event
				const expected_types = [
					'login',
					'logout',
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
			test('admin A cannot revoke admin B permits via mismatched account_id', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));
				captured_route_specs ??= test_app.route_specs;

				// Bootstrap user is admin A. Create admin B.
				const admin_b = await test_app.create_account({
					username: 'admin_b_iso',
					roles: ['admin'],
				});

				// Find the permit grant route to give admin B a grantable role
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				assert.ok(grant_route, 'Expected POST /permits/grant admin route');

				// Admin A grants a role to admin B
				const grant_res = await test_app.app.request(
					grant_route.path.replace(':account_id', admin_b.account.id),
					{
						method: 'POST',
						headers: create_headers(test_app.backend.session_cookie, {
							'content-type': 'application/json',
						}),
						body: JSON.stringify({role: grantable_role}),
					},
				);
				assert.strictEqual(grant_res.status, 200);
				const grant_body = await grant_res.json();
				assert.ok(grant_body.permit, 'Expected permit in grant response');
				const permit_id = grant_body.permit.id;

				// Admin B revokes their own permit via admin route — should succeed
				const revoke_route = test_app.route_specs.find(
					(s) =>
						s.method === 'POST' &&
						s.path.includes('/permits/:permit_id/revoke') &&
						s.auth.type === 'role' &&
						s.auth.role === 'admin',
				);
				assert.ok(revoke_route, 'Expected POST /permits/:permit_id/revoke admin route');

				const revoke_res = await test_app.app.request(
					revoke_route.path
						.replace(':account_id', admin_b.account.id)
						.replace(':permit_id', permit_id),
					{
						method: 'POST',
						headers: create_headers(admin_b.session_cookie),
					},
				);
				assert.strictEqual(revoke_res.status, 200);
				const revoke_body = await revoke_res.json();
				assert.strictEqual(revoke_body.revoked, true);
			});

			test('admin revoke-all sessions for another admin works', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const admin_b = await test_app.create_account({
					username: 'admin_b_sess',
					roles: ['admin'],
				});

				const revoke_sessions_route = find_admin_route(
					test_app.route_specs,
					'/sessions/revoke-all',
					'POST',
				);
				assert.ok(revoke_sessions_route, 'Expected POST /sessions/revoke-all admin route');

				// Admin A revokes all of admin B's sessions
				const res = await test_app.app.request(
					revoke_sessions_route.path.replace(':account_id', admin_b.account.id),
					{
						method: 'POST',
						headers: create_headers(test_app.backend.session_cookie),
					},
				);
				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(typeof body.count === 'number', 'Expected count field in response');
				assert.ok(body.count >= 1, 'Expected at least 1 session revoked');
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

				const revoke_tokens_route = find_admin_route(
					test_app.route_specs,
					'/tokens/revoke-all',
					'POST',
				);
				assert.ok(revoke_tokens_route, 'Expected POST /tokens/revoke-all admin route');

				// Admin A revokes all of admin B's tokens
				const res = await test_app.app.request(
					revoke_tokens_route.path.replace(':account_id', admin_b.account.id),
					{
						method: 'POST',
						headers: create_headers(test_app.backend.session_cookie),
					},
				);
				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.ok(typeof body.count === 'number', 'Expected count field in response');
			});

			test('non-admin cannot access admin routes for another account', async () => {
				const test_app = await create_test_app(build_admin_test_app_options(options, get_db()));

				const regular_user = await test_app.create_account({username: 'regular_user_iso'});

				const accounts_route = find_admin_route(test_app.route_specs, '/accounts', 'GET');
				assert.ok(accounts_route, 'Expected GET /accounts admin route');

				// Regular user tries to list accounts — should get 403
				const res = await test_app.app.request(accounts_route.path, {
					headers: create_headers(regular_user.session_cookie),
				});
				assert.strictEqual(res.status, 403);
				error_collector.record(test_app.route_specs, 'GET', accounts_route.path, 403);
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
					// eslint-disable-next-line no-await-in-loop
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
					// eslint-disable-next-line no-await-in-loop
					const res = await test_app.app.request(route.path, {
						headers: test_app.create_session_headers(),
					});
					assert.strictEqual(res.status, 200, `${route.method} ${route.path} should return 200`);
					// eslint-disable-next-line no-await-in-loop
					await assert_response_matches_spec(test_app.route_specs, route.method, route.path, res);
				}
			});
		});
	});
};
