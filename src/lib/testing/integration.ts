import './assert_dev_env.js';

/**
 * Standard integration test suite for fuz_app auth routes.
 *
 * `describe_standard_integration_tests` creates a composable test suite that
 * exercises the full middleware stack (origin, session, bearer_auth, request_context)
 * against a real PGlite database. Consumers call it with their route factory and
 * session config — all auth route tests come for free.
 *
 * Tests use `stub_password_deps` (deterministic hashing, no Argon2 overhead).
 * Login handlers call `verify_password(submitted, stored_hash)` which works because
 * both hash and verify use the same stub logic.
 *
 * Rate limiters are disabled by default — tests make many login attempts and would
 * trigger limits otherwise.
 *
 * @module
 */

import {describe, test, assert, beforeAll, afterAll} from 'vitest';

import type {SessionOptions} from '../auth/session_cookie.js';
import type {AppServerContext} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import {create_test_app, type CreateTestAppOptions, type SuiteAppOptions} from './app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
	type DbFactory,
} from './db.js';
import {
	find_auth_route,
	assert_response_matches_spec,
	create_expired_test_cookie,
	assert_no_error_info_leakage,
} from './integration_helpers.js';
import {
	find_rpc_action,
	rpc_call_for_spec,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.js';
import {RateLimiter} from '../rate_limiter.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';
import {
	ErrorCoverageCollector,
	assert_error_coverage,
	DEFAULT_INTEGRATION_ERROR_COVERAGE,
} from './error_coverage.js';
import {ApiError, ERROR_FORBIDDEN_ORIGIN} from '../http/error_schemas.js';
import {
	account_verify_action_spec,
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
	account_token_create_action_spec,
	account_token_list_action_spec,
	account_token_revoke_action_spec,
} from '../auth/account_action_specs.js';
import {invite_create_action_spec} from '../auth/admin_action_specs.js';

/**
 * Configuration for `describe_standard_integration_tests`.
 */
export interface StandardIntegrationTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: SuiteAppOptions;
	/**
	 * Database factories to run tests against. Default: pglite only.
	 * Pass consumer factories (e.g. `[pglite_factory, pg_factory]`) to also test against PostgreSQL.
	 */
	db_factories?: Array<DbFactory>;
	/**
	 * RPC endpoint specs — required. This suite dispatches
	 * `account_verify`, `account_session_*`, and `account_token_*` via
	 * `rpc_call_for_spec` (the `/api/account/verify` REST route is a
	 * status-only nginx shim with no payload). Hard-fails via
	 * `require_rpc_endpoint_path` on setup so consumer projects see a
	 * clear setup error instead of confusing test failures.
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
}

/**
 * Build `CreateTestAppOptions` from standard options plus a database.
 * Forwards `options.rpc_endpoints` to `app_options.rpc_endpoints` so
 * `create_app_server` auto-mounts it per-test with the real ctx.
 * `SuiteAppOptions` excludes `rpc_endpoints` so there's no way for
 * `options.app_options` to collide with the suite-level field.
 */
const build_test_app_options = (
	options: StandardIntegrationTestOptions,
	db: Db,
): CreateTestAppOptions => ({
	session_options: options.session_options,
	create_route_specs: options.create_route_specs,
	db,
	app_options: {
		...options.app_options,
		rpc_endpoints: options.rpc_endpoints,
	},
});

/**
 * Standard integration test suite for fuz_app auth routes.
 *
 * Exercises login/logout, cookie attributes, session security, session
 * revocation, password change (incl. API token revocation), origin
 * verification, bearer auth (incl. browser context discard on mutations),
 * token revocation, cross-account isolation, expired credential rejection,
 * signup invite edge cases, and response body validation.
 *
 * Each test group asserts that required routes exist, failing with a descriptive
 * message if the consumer's route specs are misconfigured.
 *
 * @param options - session config and route factory
 */
export const describe_standard_integration_tests = (
	options: StandardIntegrationTestOptions,
): void => {
	// Hard-fail early so consumers see a clear setup error instead of a
	// confusing test failure when `rpc_endpoints` is missing. Factory-form
	// callers are resolved with a stub ctx purely to extract the endpoint
	// path; real handlers run per-test via `app_options.rpc_endpoints`.
	const rpc_endpoints_for_setup = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_options,
	);
	const rpc_path = require_rpc_endpoint_path(rpc_endpoints_for_setup);

	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [AUTH_MIGRATION_NS]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];
	const describe_db = create_describe_db(factories, AUTH_INTEGRATION_TRUNCATE_TABLES);

	describe_db('standard_integration', (get_db) => {
		const {cookie_name} = options.session_options;

		// Error coverage tracking across test groups
		const error_collector = new ErrorCoverageCollector();
		let captured_route_specs: Array<RouteSpec> | null = null;

		beforeAll(async () => {
			// Capture route specs once up front so coverage assertion runs even if
			// individual tests are skipped or fail early. Route specs are immutable
			// config; the transient test app is discarded.
			const test_app = await create_test_app(build_test_app_options(options, get_db()));
			captured_route_specs = test_app.route_specs;
		});

		afterAll(() => {
			if (captured_route_specs) {
				// Scope coverage to auth routes this suite actually exercises:
				// the REST auth surface (login/logout/password/signup/bootstrap)
				// plus the shared RPC endpoint. Consumer-specific routes would
				// dilute the coverage percentage; admin-role routes are scoped
				// to the admin suite instead.
				const auth_routes = captured_route_specs.filter((s) => {
					if (s.auth.type === 'role' && s.auth.role === 'admin') return false;
					const rest_suffixes = ['/login', '/logout', '/password', '/signup', '/bootstrap'];
					if (rest_suffixes.some((suffix) => s.path.endsWith(suffix))) return true;
					return s.path === rpc_path;
				});
				assert_error_coverage(
					error_collector,
					auth_routes.length > 0 ? auth_routes : captured_route_specs,
					{
						min_coverage: DEFAULT_INTEGRATION_ERROR_COVERAGE,
					},
				);
			}
		});

		// --- 1. Login/logout lifecycle ---

		describe('login/logout lifecycle', () => {
			test('login with correct credentials returns 200 with Set-Cookie', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'test-password-123',
					}),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.ok, true);

				const set_cookie = res.headers.get('set-cookie');
				assert.ok(set_cookie, 'Expected Set-Cookie header');
				assert.ok(set_cookie.includes(`${cookie_name}=`), `Expected ${cookie_name} cookie`);
			});

			test('login with wrong password returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'wrong-password',
					}),
				});

				assert.strictEqual(res.status, 401);
				const body = await res.clone().json();
				assert.strictEqual(body.error, 'invalid_credentials');
				await error_collector.assert_and_record(
					test_app.route_specs,
					'POST',
					login_route.path,
					res,
				);
			});

			test('login with nonexistent user returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: 'nonexistent_user',
						password: 'test-password-123',
					}),
				});

				assert.strictEqual(res.status, 401);
				const body = await res.clone().json();
				assert.strictEqual(body.error, 'invalid_credentials');
				await error_collector.assert_and_record(
					test_app.route_specs,
					'POST',
					login_route.path,
					res,
				);
			});

			test('login trims whitespace from username', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: `  ${test_app.backend.account.username}  `,
						password: 'test-password-123',
					}),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.ok, true);
			});

			test('full cycle: login → verify → logout → verify fails', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				// Login
				const login_res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'test-password-123',
					}),
				});
				assert.strictEqual(login_res.status, 200);

				// Extract cookie from Set-Cookie
				const set_cookie = login_res.headers.get('set-cookie');
				assert.ok(set_cookie);
				const cookie_match = new RegExp(`${cookie_name}=([^;]+)`).exec(set_cookie);
				assert.ok(cookie_match?.[1]);
				const login_cookie = cookie_match[1];

				const create_headers = () => ({
					host: 'localhost',
					origin: 'http://localhost:5173',
					cookie: `${cookie_name}=${login_cookie}`,
				});

				// Verify works
				const verify_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: create_headers(),
				});
				assert.strictEqual(verify_res.status, 200);

				// Logout
				const logout_res = await test_app.app.request(logout_route.path, {
					method: 'POST',
					headers: create_headers(),
				});
				assert.strictEqual(logout_res.status, 200);
				const logout_body = await logout_res.json();
				assert.strictEqual(logout_body.ok, true);
				assert.strictEqual(
					logout_body.username,
					test_app.backend.account.username,
					'Logout response should include the username',
				);

				// Verify fails after logout (session revoked)
				const verify_after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: create_headers(),
				});
				assert.strictEqual(verify_after.status, 401);
			});
		});

		// --- 1b. Login response body identity (account enumeration prevention) ---

		describe('login response body identity', () => {
			test('nonexistent user and wrong password responses are structurally identical', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const make_login = (username: string, password: string) =>
					test_app.app.request(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json',
						},
						body: JSON.stringify({username, password}),
					});

				// wrong password for existing user
				const wrong_pw_res = await make_login(
					test_app.backend.account.username,
					'wrong-password-999',
				);
				assert.strictEqual(wrong_pw_res.status, 401);
				const wrong_pw_body = await wrong_pw_res.json();

				// nonexistent user
				const no_user_res = await make_login('nonexistent_user_xyz', 'any-password');
				assert.strictEqual(no_user_res.status, 401);
				const no_user_body = await no_user_res.json();

				// same keys, same error code, no extra fields
				const wrong_pw_keys = Object.keys(wrong_pw_body).sort();
				const no_user_keys = Object.keys(no_user_body).sort();
				assert.deepStrictEqual(
					wrong_pw_keys,
					no_user_keys,
					'Response keys must be identical to prevent account enumeration',
				);
				assert.strictEqual(
					wrong_pw_body.error,
					no_user_body.error,
					'Error codes must be identical',
				);
			});
		});

		// --- 2. Cookie attributes ---

		describe('cookie attributes', () => {
			test('session cookie has secure attributes', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'test-password-123',
					}),
				});

				assert.strictEqual(res.status, 200);
				const set_cookie = res.headers.get('set-cookie');
				assert.ok(set_cookie);

				const lower = set_cookie.toLowerCase();
				assert.ok(lower.includes('httponly'), 'Expected HttpOnly');
				assert.ok(lower.includes('samesite=strict'), 'Expected SameSite=Strict');
				assert.ok(lower.includes('secure'), 'Expected Secure');
				assert.ok(lower.includes('path=/'), 'Expected Path=/');
			});
		});

		// --- 3. Session security ---

		describe('session security', () => {
			test('no cookie on protected route returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(res.status, 401);
			});

			test('corrupted cookie returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {cookie: `${cookie_name}=random_garbage_value`},
				});
				assert.strictEqual(res.status, 401);
			});

			test('expired cookie returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const expired_cookie = await create_expired_test_cookie(
					test_app.backend.keyring,
					options.session_options,
				);
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {cookie: `${cookie_name}=${expired_cookie}`},
				});
				assert.strictEqual(res.status, 401);
			});
		});

		// --- 4. Session revocation ---

		describe('session revocation', () => {
			test('revoke single session by ID invalidates that session', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const headers = test_app.create_session_headers();

				// List own sessions to get the session ID
				const list_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: null,
					headers,
				});
				assert.ok(list_res.ok, 'account_session_list should succeed');
				assert.ok(list_res.result.sessions.length >= 1);
				const session_id = list_res.result.sessions[0]!.id;

				// Revoke that session by ID
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_action_spec,
					params: {session_id},
					headers,
				});
				assert.ok(revoke_res.ok, 'account_session_revoke should succeed');
				assert.strictEqual(revoke_res.result.ok, true);
				assert.strictEqual(revoke_res.result.revoked, true);

				// Session should no longer work
				const after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers,
				});
				assert.strictEqual(after.status, 401);
			});

			test('revoke-all invalidates existing session', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const headers = test_app.create_session_headers();

				// Verify works
				const before = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers,
				});
				assert.strictEqual(before.status, 200);

				// Revoke all sessions
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_all_action_spec,
					params: null,
					headers,
				});
				assert.ok(revoke_res.ok, 'account_session_revoke_all should succeed');

				// Verify fails after revocation
				const after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers,
				});
				assert.strictEqual(after.status, 401);
			});
		});

		// --- 4b. Password change ---

		describe('password change', () => {
			test('password change invalidates all sessions and allows login with new password', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);

				const headers = test_app.create_session_headers({
					'content-type': 'application/json',
				});

				// Change password
				const change_res = await test_app.app.request(password_route.path, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						current_password: 'test-password-123',
						new_password: 'new-password-456',
					}),
				});
				assert.strictEqual(change_res.status, 200);
				const change_body = await change_res.json();
				assert.strictEqual(change_body.ok, true);
				assert.ok(
					typeof change_body.sessions_revoked === 'number',
					'Expected sessions_revoked count',
				);
				assert.ok(change_body.sessions_revoked >= 1, 'Expected at least 1 session revoked');

				// Old session should be invalid
				const verify_after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(verify_after.status, 401);

				// Login with new password works
				const login_res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'new-password-456',
					}),
				});
				assert.strictEqual(login_res.status, 200);
				const login_body = await login_res.json();
				assert.strictEqual(login_body.ok, true);
			});

			test('password change with wrong current password returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(password_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers({
						'content-type': 'application/json',
					}),
					body: JSON.stringify({
						current_password: 'wrong-password-999',
						new_password: 'new-password-456',
					}),
				});
				assert.strictEqual(res.status, 401);
				error_collector.record(test_app.route_specs, 'POST', password_route.path, 401);

				// Session should still be valid (password didn't change)
				const verify_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(verify_res.status, 200);
			});
		});

		// --- 5. Origin verification ---

		describe('origin verification', () => {
			test('evil origin is rejected with 403', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				// `verify_request_source` runs before the RPC dispatcher and returns a
				// plain REST `{error}` body — not a JSON-RPC envelope. Skip `rpc_call`.
				const res = await test_app.app.request(rpc_path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://evil.com',
						'content-type': 'application/json',
						cookie: `${cookie_name}=${test_app.backend.session_cookie}`,
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						method: account_verify_action_spec.method,
						id: 'evil-origin',
					}),
				});
				assert.strictEqual(res.status, 403);
				const body = ApiError.parse(await res.json());
				assert.strictEqual(body.error, ERROR_FORBIDDEN_ORIGIN);
			});

			test('valid origin is accepted', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
			});

			test('no origin header is allowed (direct access)', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				// Probe the "no Origin / no Referer" path; `suppress_default_origin`
				// skips the default `origin` header.
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {cookie: `${cookie_name}=${test_app.backend.session_cookie}`},
					suppress_default_origin: true,
				});
				assert.notStrictEqual(res.status, 403);
			});
		});

		// --- 6. Bearer auth ---

		describe('bearer auth', () => {
			test('valid bearer token authenticates', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: test_app.create_bearer_headers(),
					suppress_default_origin: true,
				});
				assert.strictEqual(res.status, 200);
			});

			test('invalid bearer token returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {authorization: 'Bearer secret_fuz_token_invalid'},
					suppress_default_origin: true,
				});
				assert.strictEqual(res.status, 401);
			});

			test('bearer token with Origin header is rejected', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const bearer_headers = test_app.create_bearer_headers();

				// Without Origin — works.
				const ok_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: bearer_headers,
					suppress_default_origin: true,
				});
				assert.strictEqual(ok_res.status, 200);

				// With Origin — bearer silently discarded (browser context), falls through to no auth.
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {...bearer_headers, origin: 'http://localhost:5173'},
				});
				assert.strictEqual(res.status, 401);
			});
		});

		// --- 7. Token revocation ---

		describe('token revocation', () => {
			test('revoked API token returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				// Create a new token via RPC
				const create_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'test-revoke'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(create_res.ok, 'account_token_create should succeed');
				const {token, id} = create_res.result;

				// Verify token works
				const use_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {authorization: `Bearer ${token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(use_res.status, 200);

				// Revoke via RPC
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_revoke_action_spec,
					params: {token_id: id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_token_revoke should succeed');

				// Token should no longer work
				const after_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {authorization: `Bearer ${token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(after_res.status, 401);
			});
		});

		// --- 8. Cross-account isolation ---

		describe('cross-account isolation', () => {
			test('non-admin cannot access admin routes', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				// admin routes are optional in the base suite — admin-specific coverage
				// lives in describe_standard_admin_integration_tests
				const admin_route = test_app.route_specs.find(
					(s) => s.auth.type === 'role' && s.auth.role === 'admin',
				);
				if (!admin_route) return;

				const res = await test_app.app.request(admin_route.path, {
					method: admin_route.method,
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 403);
				const body = await res.json();
				assert.strictEqual(body.error, 'insufficient_permissions');
			});

			test("user A cannot revoke user B's sessions", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				// Create a second account
				const user_b = await test_app.create_account({username: 'user_b'});

				// User A revokes all their own sessions
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_all_action_spec,
					params: null,
					headers: test_app.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_session_revoke_all should succeed');

				// User B's session should still work
				const verify_b = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {cookie: `${cookie_name}=${user_b.session_cookie}`},
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A cannot revoke user B's session by ID", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				const user_b = await test_app.create_account({username: 'user_b'});
				const user_b_headers = {cookie: `${cookie_name}=${user_b.session_cookie}`};

				// Get user B's session ID by listing as user B
				const list_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: null,
					headers: user_b_headers,
				});
				assert.ok(list_res.ok, 'account_session_list should succeed');
				assert.ok(list_res.result.sessions.length >= 1);
				const session_id_b = list_res.result.sessions[0]!.id;

				// User A tries to revoke user B's session by ID
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_action_spec,
					params: {session_id: session_id_b},
					headers: test_app.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_session_revoke should succeed');
				assert.strictEqual(
					revoke_res.result.revoked,
					false,
					'Should not revoke another account session',
				);

				// User B's session should still work
				const verify_b = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: user_b_headers,
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A cannot revoke user B's token by ID", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				const user_b = await test_app.create_account({username: 'user_b'});
				const user_b_headers = {cookie: `${cookie_name}=${user_b.session_cookie}`};

				// Get user B's token ID by listing as user B
				const list_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_list_action_spec,
					params: null,
					headers: user_b_headers,
				});
				assert.ok(list_res.ok, 'account_token_list should succeed');
				assert.ok(list_res.result.tokens.length >= 1);
				const token_id_b = list_res.result.tokens[0]!.id;

				// User A tries to revoke user B's token by ID
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_revoke_action_spec,
					params: {token_id: token_id_b},
					headers: test_app.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_token_revoke should succeed');
				assert.strictEqual(
					revoke_res.result.revoked,
					false,
					'Should not revoke another account token',
				);

				// User B's bearer token should still work
				const verify_b = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {authorization: `Bearer ${user_b.api_token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A's session list does not include user B's sessions", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				const user_b = await test_app.create_account({username: 'user_b'});

				// User A lists sessions
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: null,
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, 'account_session_list should succeed');

				// Sessions should only belong to user A's account
				for (const session of res.result.sessions) {
					assert.strictEqual(
						session.account_id,
						test_app.backend.account.id,
						`Session ${session.id} should belong to user A, not user B (${user_b.account.id})`,
					);
				}
			});

			test("user A's token list does not include user B's tokens", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				const user_b = await test_app.create_account({username: 'user_b'});

				// User A lists tokens
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_list_action_spec,
					params: null,
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, 'account_token_list should succeed');

				// Tokens should only belong to user A's account
				for (const token of res.result.tokens) {
					assert.strictEqual(
						token.account_id,
						test_app.backend.account.id,
						`Token ${token.id} should belong to user A, not user B (${user_b.account.id})`,
					);
				}
			});
		});

		// --- 9. Response body validation ---

		describe('response body validation', () => {
			// `assert_response_matches_spec` validates REST `RouteSpec` outputs.
			// The account REST routes that used to cover this (/verify, /sessions,
			// /tokens, /tokens/create) moved to RPC in the 2026-04-23 migration,
			// so we exercise the remaining REST endpoints (/login, /logout,
			// /password) against their declared schemas. RPC output validation is
			// covered by `describe_rpc_round_trip_tests`.

			test('POST /login 401 response matches declared error schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: 'nonexistent_user_xyz',
						password: 'any-password',
					}),
				});
				assert.strictEqual(res.status, 401);
				await assert_response_matches_spec(test_app.route_specs, 'POST', login_route.path, res);
			});

			test('POST /logout 200 response matches output schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(logout_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({}),
				});
				assert.strictEqual(res.status, 200);
				await assert_response_matches_spec(test_app.route_specs, 'POST', logout_route.path, res);
			});

			test('POST /logout 401 response matches declared error schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(logout_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({}),
				});
				assert.strictEqual(res.status, 401);
				await assert_response_matches_spec(test_app.route_specs, 'POST', logout_route.path, res);
			});
		});

		// --- 10b. Rate limiting smoke test (full middleware stack) ---

		describe('rate limiting smoke test', () => {
			test('rate limiter fires in full middleware stack', async () => {
				const test_app = await create_test_app({
					...build_test_app_options(options, get_db()),
					app_options: {
						...options.app_options,
						// tight limiter: 2 attempts / 1 minute
						ip_rate_limiter: new RateLimiter({
							max_attempts: 2,
							window_ms: 60_000,
							cleanup_interval_ms: 0,
						}),
					},
				});
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				if (!login_route) return; // skip if login route not wired

				const make_bad_login = (ip_header?: string) => {
					const headers: Record<string, string> = {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					};
					if (ip_header) {
						headers['x-forwarded-for'] = ip_header;
					}
					return test_app.app.request(login_route.path, {
						method: 'POST',
						headers,
						body: JSON.stringify({username: 'nobody', password: 'wrong'}),
					});
				};

				// exhaust the limiter (2 attempts)
				await make_bad_login();
				await make_bad_login();

				// third attempt should be rate-limited
				const limited_res = await make_bad_login();
				assert.strictEqual(limited_res.status, 429, 'Expected 429 after exceeding rate limit');
				const limited_body = await limited_res.clone().json();
				assert.strictEqual(limited_body.error, 'rate_limit_exceeded');
				await error_collector.assert_and_record(
					test_app.route_specs,
					'POST',
					login_route.path,
					limited_res,
				);

				// Retry-After header present
				const retry_after = limited_res.headers.get('Retry-After');
				assert.ok(retry_after, 'Expected Retry-After header on 429 response');
			});
		});

		// --- 10c2. Error coverage: unauthenticated access to auth-required routes ---

		describe('error coverage breadth', () => {
			test('exercises 401 on multiple auth-required routes for error coverage', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				// Hit several auth-required RPC methods without credentials to
				// broaden error coverage beyond just /login. RPC 401s are tracked
				// against the shared endpoint path. The dispatcher runs auth before
				// params validation, so any well-formed param body works — we just
				// need each call to be type-correct wrt its spec.
				const session_list = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: null,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(session_list.status, 401);
				error_collector.record(test_app.route_specs, 'POST', rpc_path, 401);

				const session_revoke_all = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_all_action_spec,
					params: null,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(session_revoke_all.status, 401);
				error_collector.record(test_app.route_specs, 'POST', rpc_path, 401);

				const token_list = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_list_action_spec,
					params: null,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(token_list.status, 401);
				error_collector.record(test_app.route_specs, 'POST', rpc_path, 401);

				const token_create = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'unauth-probe'},
					headers: {host: 'localhost'},
				});
				assert.strictEqual(token_create.status, 401);
				error_collector.record(test_app.route_specs, 'POST', rpc_path, 401);

				const verify = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(verify.status, 401);
				error_collector.record(test_app.route_specs, 'POST', rpc_path, 401);
				// Also exercise POST /logout without auth (still REST)
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				if (logout_route) {
					const res = await test_app.app.request(logout_route.path, {
						method: 'POST',
						headers: {host: 'localhost', 'content-type': 'application/json'},
						body: JSON.stringify({}),
					});
					assert.strictEqual(res.status, 401, 'POST /logout without auth should return 401');
					error_collector.record(test_app.route_specs, 'POST', logout_route.path, 401);
				}
			});
		});

		// --- 10c. Error response information leakage ---

		describe('error response information leakage', () => {
			test('401 responses contain no leaky fields', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(res.status, 401);
				assert.ok(!res.ok);
				// Check every field on the JSON-RPC `error` object — `data` carries the
				// handler-authored shape, but `message` and any sibling fields should
				// equally be free of stack traces, file paths, or other internals.
				assert_no_error_info_leakage(
					res.error as unknown as Record<string, unknown>,
					`RPC ${account_verify_action_spec.method} 401 error envelope`,
				);
			});
		});

		// --- 11. Expired credential rejection ---

		describe('expired credential rejection', () => {
			test('expired session cookie returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const expired_cookie = await create_expired_test_cookie(
					test_app.backend.keyring,
					options.session_options,
				);
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {cookie: `${cookie_name}=${expired_cookie}`},
				});
				assert.strictEqual(res.status, 401, 'Expired session cookie should be rejected');
			});

			test('expired session cookie returns 401 on mutation route', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				const expired_cookie = await create_expired_test_cookie(
					test_app.backend.keyring,
					options.session_options,
				);
				const res = await test_app.app.request(logout_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						cookie: `${cookie_name}=${expired_cookie}`,
					},
				});
				assert.strictEqual(res.status, 401, 'Expired session cookie should be rejected on POST');
				error_collector.record(test_app.route_specs, 'POST', logout_route.path, 401);
			});
		});

		// --- 12. Bearer token browser context on mutation routes ---

		describe('bearer token browser context silently discarded on mutations', () => {
			test('bearer token with Origin header discarded on POST logout', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				const bearer_headers = test_app.create_bearer_headers({
					'content-type': 'application/json',
				});
				const res = await test_app.app.request(logout_route.path, {
					method: 'POST',
					headers: {...bearer_headers, origin: 'http://localhost:5173'},
				});
				assert.strictEqual(
					res.status,
					401,
					'Bearer with Origin should be discarded → unauthenticated',
				);
				error_collector.record(test_app.route_specs, 'POST', logout_route.path, 401);
			});

			test('bearer token with Referer header discarded on POST password', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);

				const bearer_headers = test_app.create_bearer_headers({
					'content-type': 'application/json',
				});
				const res = await test_app.app.request(password_route.path, {
					method: 'POST',
					headers: {...bearer_headers, referer: 'http://localhost:5173/admin'},
				});
				assert.strictEqual(
					res.status,
					401,
					'Bearer with Referer should be discarded → unauthenticated',
				);
				error_collector.record(test_app.route_specs, 'POST', password_route.path, 401);
			});
		});

		// --- 13. Password change revokes API tokens ---

		describe('password change revokes API tokens', () => {
			test('API tokens are invalidated after password change', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				assert.ok(password_route, 'Expected POST /password route');

				// Create an API token via RPC
				const create_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'test-token'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(create_res.ok, 'account_token_create should succeed');
				const {token: raw_token} = create_res.result;
				assert.ok(raw_token, 'Expected raw token in create response');

				// Verify bearer token works
				const verify_before = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {authorization: `Bearer ${raw_token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(
					verify_before.status,
					200,
					'Bearer token should work before password change',
				);

				// Change password (still REST)
				const change_res = await test_app.app.request(password_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({
						current_password: 'test-password-123',
						new_password: 'new-password-456',
					}),
				});
				assert.strictEqual(change_res.status, 200);
				const change_body = await change_res.json();
				assert.ok(typeof change_body.tokens_revoked === 'number', 'Expected tokens_revoked count');
				assert.ok(change_body.tokens_revoked >= 1, 'Expected at least 1 token revoked');

				// Bearer token should now be invalid
				const verify_after = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_verify_action_spec,
					params: null,
					headers: {authorization: `Bearer ${raw_token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(
					verify_after.status,
					401,
					'Bearer token should be rejected after password change',
				);
			});
		});

		// --- 14. Signup invite edge cases ---

		describe('signup invite edge cases', () => {
			test('signup with non-matching email cannot claim another email invite', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				const signup_route = test_app.route_specs.find(
					(s) => s.method === 'POST' && s.path.endsWith('/signup') && s.auth.type === 'none',
				);
				if (!signup_route) return; // signup is optional

				// `invite_create` became RPC-only in the 2026-04-23 migration.
				// Consumers that don't wire admin RPC actions can't exercise invites;
				// skip the test rather than fail.
				if (!find_rpc_action(rpc_endpoints_for_setup, invite_create_action_spec.method)) return;

				// Create an admin to manage invites
				const admin = await test_app.create_account({
					username: 'invite_edge_admin',
					roles: ['admin'],
				});

				// Create invite for alice@example.com via RPC
				const invite_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: invite_create_action_spec,
					params: {email: 'alice@example.com'},
					headers: {cookie: `${cookie_name}=${admin.session_cookie}`},
				});
				assert.ok(
					invite_res.ok,
					`invite_create failed: ${invite_res.ok ? '' : JSON.stringify(invite_res.error)}`,
				);

				// Try to sign up with a different email — should fail (no matching invite)
				const signup_res = await test_app.app.request(signup_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: 'eve_attacker',
						password: 'test-password-123456',
						email: 'eve@attacker.com',
					}),
				});
				assert.strictEqual(
					signup_res.status,
					403,
					'Signup with non-matching email should be rejected',
				);
				const body = await signup_res.json();
				assert.strictEqual(body.error, 'no_matching_invite');
			});
		});

		// --- 15. Signup response body identity ---

		describe('signup response body identity', () => {
			test('no-invite and conflict failure responses are structurally identical', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));

				// Find signup route (POST ending in /signup, public)
				const signup_route = test_app.route_specs.find(
					(s) => s.method === 'POST' && s.path.endsWith('/signup') && s.auth.type === 'none',
				);
				if (!signup_route) return; // signup is optional

				// `invite_create` became RPC-only in the 2026-04-23 migration.
				// Consumers that don't wire admin RPC actions can't exercise invites.
				if (!find_rpc_action(rpc_endpoints_for_setup, invite_create_action_spec.method)) return;

				// We need admin access — create an admin account
				const admin = await test_app.create_account({
					username: 'signup_test_admin',
					roles: ['admin'],
				});
				const admin_headers = {cookie: `${cookie_name}=${admin.session_cookie}`};

				// Create an invite for a specific test email via RPC
				const test_email = 'signup-test@example.com';
				const invite_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: invite_create_action_spec,
					params: {email: test_email},
					headers: admin_headers,
				});
				assert.ok(
					invite_res.ok,
					`invite_create failed: ${invite_res.ok ? '' : JSON.stringify(invite_res.error)}`,
				);

				// Attempt 1: signup with a non-matching email (no invite match) → 403
				const no_match_res = await test_app.app.request(signup_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: 'nomatch_user',
						password: 'test-password-123456',
						email: 'wrong-email@example.com',
					}),
				});
				assert.strictEqual(no_match_res.status, 403, 'Expected 403 for non-matching invite');
				const no_match_body = await no_match_res.json();

				// For conflict test: create a second account with a known username,
				// then create an invite for a different email, then try signup with
				// the invited email but the colliding username
				const existing_user = await test_app.create_account({username: 'existing_user'});

				// Create invite for a different email via RPC
				const conflict_email = 'conflict-test@example.com';
				const invite2_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: invite_create_action_spec,
					params: {email: conflict_email},
					headers: admin_headers,
				});
				assert.ok(
					invite2_res.ok,
					`invite2_create failed: ${invite2_res.ok ? '' : JSON.stringify(invite2_res.error)}`,
				);

				// Attempt 2: signup with the invited email but a colliding username → 409
				const conflict_res = await test_app.app.request(signup_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: existing_user.account.username,
						password: 'test-password-123456',
						email: conflict_email,
					}),
				});
				assert.strictEqual(conflict_res.status, 409, 'Expected 409 for username conflict');
				const conflict_body = await conflict_res.json();

				// Assert both failure responses have identical Object.keys()
				const no_match_keys = Object.keys(no_match_body).sort();
				const conflict_keys = Object.keys(conflict_body).sort();
				assert.deepStrictEqual(
					no_match_keys,
					conflict_keys,
					'Response keys must be identical — no extra fields should reveal ' +
						'whether the failure was "no invite" vs "conflict"',
				);

				// Assert both use documented generic error codes with no field-level detail
				assert.strictEqual(
					no_match_body.error,
					'no_matching_invite',
					'Expected generic no_matching_invite error code',
				);
				assert.strictEqual(
					conflict_body.error,
					'signup_conflict',
					'Expected generic signup_conflict error code',
				);
			});
		});
	});
};
