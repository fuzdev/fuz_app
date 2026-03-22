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

import {describe, test, assert, afterAll} from 'vitest';

import type {SessionOptions} from '../auth/session_cookie.js';
import type {AppServerContext, AppServerOptions} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import {create_test_app, type CreateTestAppOptions} from './app_server.js';
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
import {RateLimiter} from '../rate_limiter.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';
import {
	ErrorCoverageCollector,
	assert_error_coverage,
	DEFAULT_INTEGRATION_ERROR_COVERAGE,
} from './error_coverage.js';

/**
 * Configuration for `describe_standard_integration_tests`.
 */
export interface StandardIntegrationTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
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
 * Build `CreateTestAppOptions` from standard options plus a database.
 */
const build_test_app_options = (
	options: StandardIntegrationTestOptions,
	db: Db,
): CreateTestAppOptions => ({
	session_options: options.session_options,
	create_route_specs: options.create_route_specs,
	db,
	app_options: options.app_options,
});

/**
 * Standard integration test suite for fuz_app auth routes.
 *
 * Exercises login/logout, cookie attributes, session security, session
 * revocation, password change (incl. API token revocation), origin
 * verification, bearer auth (incl. browser context rejection on mutations),
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

		afterAll(() => {
			if (captured_route_specs) {
				// Scope coverage to auth-related routes that this suite exercises.
				// Consumer-specific routes (tx runs, state, etc.) are not exercised
				// by the standard suite and would dilute the coverage percentage.
				const auth_suffixes = [
					'/login',
					'/logout',
					'/verify',
					'/sessions',
					'/sessions/revoke-all',
					'/tokens',
					'/tokens/create',
					'/password',
					'/signup',
					'/bootstrap',
				];
				const auth_routes = captured_route_specs.filter(
					(s) =>
						(auth_suffixes.some((suffix) => s.path.endsWith(suffix)) ||
							s.path.includes('/sessions/:') ||
							s.path.includes('/tokens/:')) &&
						!(s.auth.type === 'role' && s.auth.role === 'admin'),
				);
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
				captured_route_specs ??= test_app.route_specs;
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
				error_collector.record(test_app.route_specs, 'POST', login_route.path, 401);
				const body = await res.json();
				assert.strictEqual(body.error, 'invalid_credentials');
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
				error_collector.record(test_app.route_specs, 'POST', login_route.path, 401);
				const body = await res.json();
				assert.strictEqual(body.error, 'invalid_credentials');
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
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
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
				const verify_res = await test_app.app.request(verify_route.path, {
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
				const verify_after = await test_app.app.request(verify_route.path, {
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
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost'},
				});
				assert.strictEqual(res.status, 401);
				error_collector.record(test_app.route_specs, 'GET', verify_route.path, 401);
			});

			test('corrupted cookie returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: {
						host: 'localhost',
						cookie: `${cookie_name}=random_garbage_value`,
					},
				});
				assert.strictEqual(res.status, 401);
				error_collector.record(test_app.route_specs, 'GET', verify_route.path, 401);
			});

			test('expired cookie returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const expired_cookie = await create_expired_test_cookie(
					test_app.backend.keyring,
					options.session_options,
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: {
						host: 'localhost',
						cookie: `${cookie_name}=${expired_cookie}`,
					},
				});
				assert.strictEqual(res.status, 401);
				error_collector.record(test_app.route_specs, 'GET', verify_route.path, 401);
			});
		});

		// --- 4. Session revocation ---

		describe('session revocation', () => {
			test('revoke single session by ID invalidates that session', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const sessions_route = find_auth_route(test_app.route_specs, '/sessions', 'GET');
				const revoke_route = test_app.route_specs.find(
					(s) =>
						s.method === 'POST' &&
						s.path.endsWith('/sessions/:id/revoke') &&
						s.auth.type === 'authenticated',
				);
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					sessions_route,
					'Expected GET /sessions route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					revoke_route,
					'Expected POST /sessions/:id/revoke route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const headers = test_app.create_session_headers();

				// List own sessions to get the session ID
				const list_res = await test_app.app.request(sessions_route.path, {headers});
				assert.strictEqual(list_res.status, 200);
				const list_body = await list_res.json();
				assert.ok(list_body.sessions.length >= 1);
				const session_id = list_body.sessions[0].id;

				// Revoke that session by ID
				const revoke_path = revoke_route.path.replace(':id', session_id);
				const revoke_res = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers,
				});
				assert.strictEqual(revoke_res.status, 200);
				const revoke_body = await revoke_res.json();
				assert.strictEqual(revoke_body.ok, true);
				assert.strictEqual(revoke_body.revoked, true);

				// Session should no longer work
				const after = await test_app.app.request(verify_route.path, {headers});
				assert.strictEqual(after.status, 401);
			});

			test('revoke-all invalidates existing session', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				const revoke_route = find_auth_route(test_app.route_specs, '/sessions/revoke-all', 'POST');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					revoke_route,
					'Expected POST /sessions/revoke-all route — ensure create_route_specs includes account routes',
				);

				const headers = test_app.create_session_headers();

				// Verify works
				const before = await test_app.app.request(verify_route.path, {headers});
				assert.strictEqual(before.status, 200);

				// Revoke all sessions
				const revoke_res = await test_app.app.request(revoke_route.path, {
					method: 'POST',
					headers,
				});
				assert.strictEqual(revoke_res.status, 200);

				// Verify fails after revocation
				const after = await test_app.app.request(verify_route.path, {headers});
				assert.strictEqual(after.status, 401);
			});
		});

		// --- 4b. Password change ---

		describe('password change', () => {
			test('password change invalidates all sessions and allows login with new password', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
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
				const verify_after = await test_app.app.request(verify_route.path, {
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
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
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
				const verify_res = await test_app.app.request(verify_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(verify_res.status, 200);
			});
		});

		// --- 5. Origin verification ---

		describe('origin verification', () => {
			test('evil origin is rejected with 403', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: {
						host: 'localhost',
						origin: 'http://evil.com',
						cookie: `${cookie_name}=${test_app.backend.session_cookie}`,
					},
				});
				assert.strictEqual(res.status, 403);
				const body = await res.json();
				assert.strictEqual(body.error, 'forbidden_origin');
			});

			test('valid origin is accepted', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
			});

			test('no origin header is allowed (direct access)', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: {
						host: 'localhost',
						cookie: `${cookie_name}=${test_app.backend.session_cookie}`,
					},
				});
				assert.notStrictEqual(res.status, 403);
			});
		});

		// --- 6. Bearer auth ---

		describe('bearer auth', () => {
			test('valid bearer token authenticates', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: test_app.create_bearer_headers(),
				});
				assert.strictEqual(res.status, 200);
			});

			test('invalid bearer token returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: {
						host: 'localhost',
						authorization: 'Bearer secret_fuz_token_invalid',
					},
				});
				assert.strictEqual(res.status, 401);
				error_collector.record(test_app.route_specs, 'GET', verify_route.path, 401);
			});

			test('bearer token with Origin header is rejected', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const bearer_headers = test_app.create_bearer_headers();

				// Without Origin — works
				const ok_res = await test_app.app.request(verify_route.path, {
					headers: bearer_headers,
				});
				assert.strictEqual(ok_res.status, 200);

				// With Origin — rejected (browser context)
				const res = await test_app.app.request(verify_route.path, {
					headers: {
						...bearer_headers,
						origin: 'http://localhost:5173',
					},
				});
				assert.strictEqual(res.status, 403);
				error_collector.record(test_app.route_specs, 'GET', verify_route.path, 403);
				const body = await res.json();
				assert.strictEqual(body.error, 'bearer_token_rejected_in_browser_context');
			});
		});

		// --- 7. Token revocation ---

		describe('token revocation', () => {
			test('revoked API token returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				const create_token_route = find_auth_route(test_app.route_specs, '/tokens/create', 'POST');
				const revoke_token_route = test_app.route_specs.find(
					(s) => s.method === 'POST' && s.path.endsWith('/tokens/:id/revoke'),
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					create_token_route,
					'Expected POST /tokens/create route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					revoke_token_route,
					'Expected POST /tokens/:id/revoke route — ensure create_route_specs includes account routes',
				);

				// Create a new token via the API
				const create_res = await test_app.app.request(create_token_route.path, {
					method: 'POST',
					headers: {
						...test_app.create_session_headers(),
						'content-type': 'application/json',
					},
					body: JSON.stringify({name: 'test-revoke'}),
				});
				assert.strictEqual(create_res.status, 200);
				const {token, id} = (await create_res.json()) as {token: string; id: string};

				// Verify token works
				const use_res = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost', authorization: `Bearer ${token}`},
				});
				assert.strictEqual(use_res.status, 200);

				// Revoke via HTTP
				const revoke_path = revoke_token_route.path.replace(':id', id);
				const revoke_res = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(revoke_res.status, 200);

				// Token should no longer work
				const after_res = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost', authorization: `Bearer ${token}`},
				});
				assert.strictEqual(after_res.status, 401);
				error_collector.record(test_app.route_specs, 'GET', verify_route.path, 401);
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
				const revoke_all_route = find_auth_route(
					test_app.route_specs,
					'/sessions/revoke-all',
					'POST',
				);
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					revoke_all_route,
					'Expected POST /sessions/revoke-all route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				// Create a second account
				const user_b = await test_app.create_account({username: 'user_b'});

				// User A revokes all their own sessions
				const revoke_res = await test_app.app.request(revoke_all_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(revoke_res.status, 200);

				// User B's session should still work
				const verify_b = await test_app.app.request(verify_route.path, {
					headers: {
						host: 'localhost',
						cookie: `${cookie_name}=${user_b.session_cookie}`,
					},
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A cannot revoke user B's session by ID", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const sessions_route = find_auth_route(test_app.route_specs, '/sessions', 'GET');
				const revoke_route = test_app.route_specs.find(
					(s) =>
						s.method === 'POST' &&
						s.path.endsWith('/sessions/:id/revoke') &&
						s.auth.type === 'authenticated',
				);
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					sessions_route,
					'Expected GET /sessions route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					revoke_route,
					'Expected POST /sessions/:id/revoke route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const user_b = await test_app.create_account({username: 'user_b'});
				const user_b_headers = {
					host: 'localhost',
					cookie: `${cookie_name}=${user_b.session_cookie}`,
				};

				// Get user B's session ID by listing as user B
				const list_res = await test_app.app.request(sessions_route.path, {
					headers: user_b_headers,
				});
				assert.strictEqual(list_res.status, 200);
				const list_body = await list_res.json();
				assert.ok(list_body.sessions.length >= 1);
				const session_id_b = list_body.sessions[0].id;

				// User A tries to revoke user B's session by ID
				const revoke_path = revoke_route.path.replace(':id', session_id_b);
				const revoke_res = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(revoke_res.status, 200);
				const revoke_body = await revoke_res.json();
				assert.strictEqual(revoke_body.revoked, false, 'Should not revoke another account session');

				// User B's session should still work
				const verify_b = await test_app.app.request(verify_route.path, {
					headers: user_b_headers,
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A cannot revoke user B's token by ID", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const tokens_route = find_auth_route(test_app.route_specs, '/tokens', 'GET');
				const revoke_route = test_app.route_specs.find(
					(s) =>
						s.method === 'POST' &&
						s.path.endsWith('/tokens/:id/revoke') &&
						s.auth.type === 'authenticated',
				);
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					tokens_route,
					'Expected GET /tokens route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					revoke_route,
					'Expected POST /tokens/:id/revoke route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const user_b = await test_app.create_account({username: 'user_b'});
				const user_b_headers = {
					host: 'localhost',
					cookie: `${cookie_name}=${user_b.session_cookie}`,
				};

				// Get user B's token ID by listing as user B
				const list_res = await test_app.app.request(tokens_route.path, {
					headers: user_b_headers,
				});
				assert.strictEqual(list_res.status, 200);
				const list_body = await list_res.json();
				assert.ok(list_body.tokens.length >= 1);
				const token_id_b = list_body.tokens[0].id;

				// User A tries to revoke user B's token by ID
				const revoke_path = revoke_route.path.replace(':id', token_id_b);
				const revoke_res = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(revoke_res.status, 200);
				const revoke_body = await revoke_res.json();
				assert.strictEqual(revoke_body.revoked, false, 'Should not revoke another account token');

				// User B's bearer token should still work
				const verify_b = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost', authorization: `Bearer ${user_b.api_token}`},
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A's session list does not include user B's sessions", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const sessions_route = find_auth_route(test_app.route_specs, '/sessions', 'GET');
				assert.ok(
					sessions_route,
					'Expected GET /sessions route — ensure create_route_specs includes account routes',
				);

				const user_b = await test_app.create_account({username: 'user_b'});

				// User A lists sessions
				const res = await test_app.app.request(sessions_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
				const body = await res.json();

				// Sessions should only belong to user A's account
				for (const session of body.sessions) {
					assert.strictEqual(
						session.account_id,
						test_app.backend.account.id,
						`Session ${session.id} should belong to user A, not user B (${user_b.account.id})`,
					);
				}
			});

			test("user A's token list does not include user B's tokens", async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const tokens_route = find_auth_route(test_app.route_specs, '/tokens', 'GET');
				assert.ok(
					tokens_route,
					'Expected GET /tokens route — ensure create_route_specs includes account routes',
				);

				const user_b = await test_app.create_account({username: 'user_b'});

				// User A lists tokens
				const res = await test_app.app.request(tokens_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
				const body = await res.json();

				// Tokens should only belong to user A's account
				for (const token of body.tokens) {
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
			test('401 response matches declared error schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost'},
				});
				assert.strictEqual(res.status, 401);

				// Should not throw — body matches the declared error schema
				await assert_response_matches_spec(test_app.route_specs, 'GET', verify_route.path, res);
			});

			test('GET /verify 200 response matches output schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(verify_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
				await assert_response_matches_spec(test_app.route_specs, 'GET', verify_route.path, res);
			});

			test('GET /sessions 200 response matches output schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const sessions_route = find_auth_route(test_app.route_specs, '/sessions', 'GET');
				assert.ok(
					sessions_route,
					'Expected GET /sessions route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(sessions_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
				await assert_response_matches_spec(test_app.route_specs, 'GET', sessions_route.path, res);
			});

			test('GET /tokens 200 response matches output schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const tokens_route = find_auth_route(test_app.route_specs, '/tokens', 'GET');
				assert.ok(
					tokens_route,
					'Expected GET /tokens route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(tokens_route.path, {
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
				await assert_response_matches_spec(test_app.route_specs, 'GET', tokens_route.path, res);
			});

			test('POST /tokens/create 200 response matches output schema', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const create_token_route = find_auth_route(test_app.route_specs, '/tokens/create', 'POST');
				assert.ok(
					create_token_route,
					'Expected POST /tokens/create route — ensure create_route_specs includes account routes',
				);

				const res = await test_app.app.request(create_token_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({name: 'schema-test'}),
				});
				assert.strictEqual(res.status, 200);
				await assert_response_matches_spec(
					test_app.route_specs,
					'POST',
					create_token_route.path,
					res,
				);
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
				error_collector.record(test_app.route_specs, 'POST', login_route.path, 429);
				const limited_body = await limited_res.json();
				assert.strictEqual(limited_body.error, 'rate_limit_exceeded');

				// Retry-After header present
				const retry_after = limited_res.headers.get('Retry-After');
				assert.ok(retry_after, 'Expected Retry-After header on 429 response');
			});
		});

		// --- 10c2. Error coverage: unauthenticated access to auth-required routes ---

		describe('error coverage breadth', () => {
			test('exercises 401 on multiple auth-required routes for error coverage', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				// Hit several auth-required routes without credentials to broaden
				// error coverage beyond just /verify and /login
				const route_suffixes = ['/sessions', '/tokens', '/sessions/revoke-all', '/tokens/create'];
				for (const suffix of route_suffixes) {
					const route = find_auth_route(
						test_app.route_specs,
						suffix,
						suffix === '/tokens/create' || suffix === '/sessions/revoke-all' ? 'POST' : 'GET',
					);
					if (!route) continue;
					// eslint-disable-next-line no-await-in-loop
					const res = await test_app.app.request(route.path, {
						method: route.method,
						headers: {host: 'localhost'},
					});
					if (res.status === 401) {
						error_collector.record(test_app.route_specs, route.method, route.path, 401);
					}
				}
				// Also exercise POST /logout without auth
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				if (logout_route) {
					const res = await test_app.app.request(logout_route.path, {
						method: 'POST',
						headers: {host: 'localhost'},
					});
					if (res.status === 401) {
						error_collector.record(test_app.route_specs, 'POST', logout_route.path, 401);
					}
				}
			});
		});

		// --- 10c. Error response information leakage ---

		describe('error response information leakage', () => {
			test('401 responses contain no leaky fields', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				if (!verify_route) return;

				const res = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost'},
				});
				assert.strictEqual(res.status, 401);
				const body = await res.json();
				assert_no_error_info_leakage(body, `GET ${verify_route.path} 401`);
			});
		});

		// --- 11. Expired credential rejection ---

		describe('expired credential rejection', () => {
			test('expired session cookie returns 401', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(
					verify_route,
					'Expected GET /verify route — ensure create_route_specs includes account routes',
				);

				const expired_cookie = await create_expired_test_cookie(
					test_app.backend.keyring,
					options.session_options,
				);
				const res = await test_app.app.request(verify_route.path, {
					headers: {
						host: 'localhost',
						cookie: `${cookie_name}=${expired_cookie}`,
					},
				});
				assert.strictEqual(res.status, 401, 'Expired session cookie should be rejected');
				error_collector.record(test_app.route_specs, 'GET', verify_route.path, 401);
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

		describe('bearer token browser context rejection on mutations', () => {
			test('bearer token with Origin header rejected on POST logout', async () => {
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
				assert.strictEqual(res.status, 403, 'Bearer with Origin should be rejected on mutation');
				const body = await res.json();
				assert.strictEqual(body.error, 'bearer_token_rejected_in_browser_context');
				error_collector.record(test_app.route_specs, 'POST', logout_route.path, 403);
			});

			test('bearer token with Referer header rejected on POST password', async () => {
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
				assert.strictEqual(res.status, 403, 'Bearer with Referer should be rejected on mutation');
				const body = await res.json();
				assert.strictEqual(body.error, 'bearer_token_rejected_in_browser_context');
				error_collector.record(test_app.route_specs, 'POST', password_route.path, 403);
			});
		});

		// --- 13. Password change revokes API tokens ---

		describe('password change revokes API tokens', () => {
			test('API tokens are invalidated after password change', async () => {
				const test_app = await create_test_app(build_test_app_options(options, get_db()));
				const token_create_route = find_auth_route(test_app.route_specs, '/tokens/create', 'POST');
				const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
				const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
				assert.ok(token_create_route, 'Expected POST /tokens/create route');
				assert.ok(password_route, 'Expected POST /password route');
				assert.ok(verify_route, 'Expected GET /verify route');

				// Create an API token
				const create_res = await test_app.app.request(token_create_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({name: 'test-token'}),
				});
				assert.strictEqual(create_res.status, 200);
				const {token: raw_token} = await create_res.json();
				assert.ok(raw_token, 'Expected raw token in create response');

				// Verify bearer token works
				const verify_before = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost', authorization: `Bearer ${raw_token}`},
				});
				assert.strictEqual(
					verify_before.status,
					200,
					'Bearer token should work before password change',
				);

				// Change password
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
				const verify_after = await test_app.app.request(verify_route.path, {
					headers: {host: 'localhost', authorization: `Bearer ${raw_token}`},
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

				const invite_route = test_app.route_specs.find(
					(s) =>
						s.method === 'POST' &&
						s.path.endsWith('/invites') &&
						s.auth.type === 'role' &&
						s.auth.role === 'admin',
				);
				if (!invite_route) return; // invite routes are optional

				// Create an admin to manage invites
				const admin = await test_app.create_account({
					username: 'invite_edge_admin',
					roles: ['admin'],
				});
				const admin_headers = {
					host: 'localhost',
					origin: 'http://localhost:5173',
					cookie: `${cookie_name}=${admin.session_cookie}`,
					'content-type': 'application/json',
				};

				// Create invite for alice@example.com
				const invite_res = await test_app.app.request(invite_route.path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({email: 'alice@example.com'}),
				});
				assert.strictEqual(invite_res.status, 200);

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

				// Find admin invite creation route (POST ending in /invites, admin-gated)
				const invite_route = test_app.route_specs.find(
					(s) =>
						s.method === 'POST' &&
						s.path.endsWith('/invites') &&
						s.auth.type === 'role' &&
						s.auth.role === 'admin',
				);
				if (!invite_route) return; // invite routes are optional

				// Find admin accounts route to get admin's account ID
				const accounts_route = test_app.route_specs.find(
					(s) =>
						s.method === 'GET' &&
						s.path.endsWith('/accounts') &&
						s.auth.type === 'role' &&
						s.auth.role === 'admin',
				);
				if (!accounts_route) return;

				// We need admin access — create an admin account
				const admin = await test_app.create_account({
					username: 'signup_test_admin',
					roles: ['admin'],
				});
				const admin_headers = {
					host: 'localhost',
					origin: 'http://localhost:5173',
					cookie: `${cookie_name}=${admin.session_cookie}`,
					'content-type': 'application/json',
				};

				// Create an invite for a specific test email
				const test_email = 'signup-test@example.com';
				const invite_res = await test_app.app.request(invite_route.path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({email: test_email}),
				});
				assert.strictEqual(invite_res.status, 200, 'Expected invite creation to succeed');

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

				// Create invite for a different email
				const conflict_email = 'conflict-test@example.com';
				const invite2_res = await test_app.app.request(invite_route.path, {
					method: 'POST',
					headers: admin_headers,
					body: JSON.stringify({email: conflict_email}),
				});
				assert.strictEqual(invite2_res.status, 200, 'Expected second invite creation to succeed');

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
