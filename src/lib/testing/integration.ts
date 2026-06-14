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
import {
	find_auth_route,
	assert_response_matches_spec,
	assert_no_error_info_leakage,
} from './integration_helpers.js';
import {
	find_rpc_action,
	rpc_call_for_spec,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.js';
import {
	ErrorCoverageCollector,
	assert_error_coverage,
	DEFAULT_INTEGRATION_ERROR_COVERAGE,
} from './error_coverage.js';
import {is_public_auth} from '../http/auth_shape.js';
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
import {LoginOutput, AccountStatusOutput} from '../auth/account_route_schema.js';
import type {AppSurfaceSpec} from '../http/surface.js';
import {type BackendCapabilities} from './cross_backend/capabilities.js';
import type {SetupTest} from './cross_backend/setup.js';
import {DEFAULT_TEST_PASSWORD} from './test_credentials.js';

/**
 * Configuration for `describe_standard_integration_tests`.
 */
export interface StandardIntegrationTestOptions {
	/**
	 * Per-test fixture-producing function. The integration suite calls
	 * this in every `test()` body — auth_integration_truncate_tables
	 * clears `account`, so each test re-bootstraps the keeper.
	 */
	setup_test: SetupTest;
	/**
	 * App surface (with route specs + middleware specs) for route iteration
	 * and error-coverage scoping. The same shape feeds both in-process and
	 * cross-process tests — the test process always constructs the spec in
	 * TS (via `create_test_app_surface_spec` or a consumer's equivalent);
	 * cross-process-ness is a property of the transport + per-test fixture,
	 * not the schema source. The on-disk `auth_attack_surface.json` is an
	 * observability artifact for human inspection + gen-time drift gating,
	 * not the source the test runtime reads from.
	 */
	surface_source: AppSurfaceSpec;
	/** Backend capability declarations for capability-gated cases. */
	capabilities: BackendCapabilities;
	/**
	 * Session config — needed to resolve factory-form `rpc_endpoints`
	 * against a stub `AppServerContext` at setup time and to read
	 * `cookie_name` for manual cookie composition in the session cases.
	 */
	session_options: SessionOptions<string>;
	/**
	 * RPC endpoint specs — required. This suite dispatches
	 * `account_verify`, `account_session_*`, and `account_token_*` via
	 * `rpc_call_for_spec` (the `/api/account/verify` REST route is a
	 * status-only nginx shim with no payload). Hard-fails via
	 * `require_rpc_endpoint_path` on setup so consumer projects see a
	 * clear setup error instead of confusing test failures.
	 *
	 * Accepts either an array (eager) or a factory — see `testing/rpc_helpers.ts`
	 * for the union semantics. The factory must return the same endpoint
	 * `path` regardless of ctx — invoked once at setup with a stub ctx
	 * for path lookup; the running backend handles live dispatch.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Minimum error-coverage ratio to enforce on the scoped REST surface
	 * (login / logout / password / signup + the shared RPC endpoint).
	 * Default `DEFAULT_INTEGRATION_ERROR_COVERAGE` (0.2). Set to `0` to
	 * skip the assertion entirely — useful for consumers with minimal
	 * route sets whose declared error codes outpace the suite's
	 * denial-path drivers.
	 */
	error_coverage_min?: number;
}

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
 * The two signup-invite-edge-case tests call `invite_create_action_spec`
 * (admin-gated) over the fixture's session, so consumers wiring signup +
 * admin actions must thread `extra_keeper_roles: [ROLE_ADMIN]` through
 * either `default_in_process_suite_options` or
 * `default_cross_process_setup(handle, {extra_keeper_roles:
 * [ROLE_ADMIN]})`. In both modes the fixture's `fixture.account` is the
 * fresh keeper, and the extra-keeper-roles list grants the bootstrapped
 * keeper additional roles inline (cross-process via `_testing_reset`'s
 * bootstrap-time seeding; in-process via `bootstrap_test_keeper`) — no
 * per-role RPC cost, no offer/accept round-trip. The tests run against
 * the production `open_signup: false` default — the cross-process
 * per-test secondary mint via `fixture.create_account()` is
 * invite-gated (keeper drives `invite_create` before signup) so the
 * harness doesn't need to flip the setting. Consumers that don't wire
 * signup or `invite_create` silently skip these two tests.
 *
 * @throws Error at setup time when `options.rpc_endpoints` is empty — the
 *   suite hard-fails via `require_rpc_endpoint_path` rather than running
 *   tests that would crash mid-suite trying to dispatch
 *   `account_verify` / `account_session_*` / `account_token_*`.
 */
export const describe_standard_integration_tests = (
	options: StandardIntegrationTestOptions,
): void => {
	const route_specs = options.surface_source.route_specs;
	// Hard-fail early so consumers see a clear setup error instead of a
	// confusing test failure when `rpc_endpoints` is missing. Factory-form
	// callers are resolved with a stub ctx purely to extract the endpoint
	// path; the running backend handles live dispatch.
	const rpc_endpoints_for_setup = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_options,
	);
	const rpc_path = require_rpc_endpoint_path(rpc_endpoints_for_setup);

	describe('standard_integration', () => {
		const {cookie_name} = options.session_options;

		// Error coverage tracking across test groups
		const error_collector = new ErrorCoverageCollector();

		afterAll(() => {
			// Scope coverage to auth routes this suite actually exercises:
			// login / logout / password drivers + signup invite edge cases
			// (when the consumer wires signup) + the shared RPC endpoint.
			// Bootstrap (when the consumer wires it via the top-level `bootstrap`
			// option in `mode: 'live'`) is intentionally excluded — this suite has
			// no describe block that drives bootstrap; the dedicated
			// `describe_bootstrap_success_tests` suite picks it up via
			// `create_test_app_for_bootstrap`. Consumer-specific
			// routes would dilute the ratio; admin-role routes are scoped to
			// the admin suite instead.
			const auth_routes = route_specs.filter((s) => {
				if (s.auth.roles?.includes('admin') ?? false) return false;
				const rest_suffixes = ['/login', '/logout', '/password', '/signup'];
				if (rest_suffixes.some((suffix) => s.path.endsWith(suffix))) return true;
				return s.path === rpc_path;
			});
			assert_error_coverage(error_collector, auth_routes.length > 0 ? auth_routes : route_specs, {
				min_coverage: options.error_coverage_min ?? DEFAULT_INTEGRATION_ERROR_COVERAGE,
				// Authorization denials (403) on these scoped auth routes — the
				// credential-channel gate on /logout + /password, the invite gate on
				// /signup — are exercised by the conformance + attack-surface suites,
				// not this lifecycle suite. Drop 403 from this collector's denominator
				// (same spirit as the [401, 403, 429] ignore in the attack-surface
				// tightness defaults); otherwise #10 adding /logout's 403 to the spine
				// surface tips the ratio under threshold here though the gate is tested.
				ignore_statuses: [403],
			});
		});

		// --- 1. Login/logout lifecycle ---

		describe('login/logout lifecycle', () => {
			test('login with correct credentials returns 200 with Set-Cookie', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: fixture.account.username,
						password: DEFAULT_TEST_PASSWORD,
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
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: fixture.account.username,
						password: 'wrong-password',
					}),
				});

				assert.strictEqual(res.status, 401);
				const body = await res.clone().json();
				assert.strictEqual(body.error, 'invalid_credentials');
				await error_collector.assert_and_record(route_specs, 'POST', login_route.path, res);
			});

			test('login with nonexistent user returns 401', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: 'nonexistent_user',
						password: DEFAULT_TEST_PASSWORD,
					}),
				});

				assert.strictEqual(res.status, 401);
				const body = await res.clone().json();
				assert.strictEqual(body.error, 'invalid_credentials');
				await error_collector.assert_and_record(route_specs, 'POST', login_route.path, res);
			});

			test('login trims whitespace from username', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: `  ${fixture.account.username}  `,
						password: DEFAULT_TEST_PASSWORD,
					}),
				});

				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.ok, true);
			});

			test('full cycle: login → verify → logout → verify fails', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				const logout_route = find_auth_route(route_specs, '/logout', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				// Login
				const login_res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: fixture.account.username,
						password: DEFAULT_TEST_PASSWORD,
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
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: create_headers(),
				});
				assert.strictEqual(verify_res.status, 200);

				// Logout
				const logout_res = await fixture.transport(logout_route.path, {
					method: 'POST',
					headers: create_headers(),
				});
				assert.strictEqual(logout_res.status, 200);
				const logout_body = await logout_res.json();
				assert.strictEqual(logout_body.ok, true);
				assert.strictEqual(
					logout_body.username,
					fixture.account.username,
					'Logout response should include the username',
				);

				// Verify fails after logout (session revoked)
				const verify_after = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: create_headers(),
				});
				assert.strictEqual(verify_after.status, 401);
			});
		});

		// --- 1b. Login response body identity (account enumeration prevention) ---

		describe('login response body identity', () => {
			test('nonexistent user and wrong password responses are structurally identical', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const make_login = (username: string, password: string) =>
					fixture.transport(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json',
						},
						body: JSON.stringify({username, password}),
					});

				// wrong password for existing user
				const wrong_pw_res = await make_login(fixture.account.username, 'wrong-password-999');
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

			// Wire-shape gate: the successful `POST /login` body must strict-parse
			// against `LoginOutput` (`{ok: true}`). `.strictObject` rejects any
			// extra field, so a backend leaking `username` / `account_id` (the
			// Rust spine's old shape) fails here on either impl.
			test('successful login body strict-parses against LoginOutput', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: fixture.account.username,
						password: DEFAULT_TEST_PASSWORD,
					}),
				});
				assert.strictEqual(res.status, 200);
				const body = await res.json();
				// Throws on any extra or missing field — drift on either backend fails.
				LoginOutput.parse(body);
			});
		});

		// --- 1b. Account status body (strict schema) ---

		describe('account status response body', () => {
			// Wire-shape gate: the authenticated `GET /api/account/status` body
			// must strict-parse against `AccountStatusOutput` — the full shape
			// `{account: SessionAccountJson, actor: ActorSummaryJson | null,
			// role_grants: RoleGrantSummaryJson[]}`. `.strictObject` rejects any
			// extra or missing field on `account` / `actor` / each role_grant, so
			// a backend returning the old narrow shape (Rust's `{account:{id,
			// username}, role_grants:[{role}]}`) fails here on either impl. The
			// fixture keeper is single-actor, so `actor` must be non-null and
			// `role_grants` populated (keeper holds keeper + admin globally).
			//
			// `/status` is mounted at `create_app_server` time (it needs the
			// `bootstrap_available` runtime state), not by `create_account_route_specs`
			// and not listed in the declared surface, so we can't gate on `route_specs`.
			// A backend that mounts only the account-route factory (e.g. a minimal
			// in-process route set) doesn't serve it — probe at runtime and skip on
			// 404. The full spine surfaces (in-process + cross-process) serve it, so
			// the gate runs there. `find_auth_route` can't be used: `/status` isn't a
			// `RestAuthRouteSuffix`.
			test('authenticated status body strict-parses against AccountStatusOutput', async (ctx) => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);
				// `/status` is the sibling of `/login` under the same account prefix.
				const status_path = login_route.path.replace(/\/login$/, '/status');

				const res = await fixture.transport(status_path, {
					method: 'GET',
					headers: fixture.create_session_headers({host: 'localhost'}),
				});
				if (res.status === 404) {
					// Backend doesn't mount /status (minimal route set) — nothing to gate.
					ctx.skip();
					return;
				}
				assert.strictEqual(res.status, 200);
				const body = await res.json();
				// Throws on any extra/missing field across account/actor/role_grants.
				const parsed = AccountStatusOutput.parse(body);
				// Single-actor keeper: actor resolved, role_grants populated.
				assert.ok(parsed.actor, 'single-actor keeper must resolve a non-null actor');
				assert.ok(
					parsed.role_grants.length > 0,
					'single-actor keeper must have populated role_grants',
				);
			});
		});

		// --- 2. Cookie attributes ---

		describe('cookie attributes', () => {
			test('session cookie has secure attributes', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: fixture.account.username,
						password: DEFAULT_TEST_PASSWORD,
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
				const fixture = await options.setup_test();
				const res = await rpc_call_for_spec({
					app: {request: fixture.fresh_transport()},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(res.status, 401);
			});

			test('corrupted cookie returns 401', async () => {
				const fixture = await options.setup_test();
				const res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {cookie: `${cookie_name}=random_garbage_value`},
				});
				assert.strictEqual(res.status, 401);
			});

			// Expired-session rejection promoted to the cross-backend conformance
			// table (the `expired_session` principal, `conformance_expiry_cases.ts`) —
			// it exercises the authoritative server-side DB-row expiry gate over
			// real auth resolution on every spine, not the cookie-payload gate a
			// backdated-payload forge hit here. The payload gate stays covered by
			// `parse_session`'s own unit tests.
		});

		// --- 4. Session revocation ---

		describe('session revocation', () => {
			test('revoke single session by ID invalidates that session', async () => {
				const fixture = await options.setup_test();
				const headers = fixture.create_session_headers();

				// List own sessions to get the session ID
				const list_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: undefined,
					headers,
				});
				assert.ok(list_res.ok, 'account_session_list should succeed');
				assert.ok(list_res.result.sessions.length >= 1);
				const session_id = list_res.result.sessions[0]!.id;

				// Revoke that session by ID
				const revoke_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
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
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers,
				});
				assert.strictEqual(after.status, 401);
			});

			test('revoke-all invalidates existing session', async () => {
				const fixture = await options.setup_test();
				const headers = fixture.create_session_headers();

				// Verify works
				const before = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers,
				});
				assert.strictEqual(before.status, 200);

				// Revoke all sessions
				const revoke_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_session_revoke_all_action_spec,
					params: undefined,
					headers,
				});
				assert.ok(revoke_res.ok, 'account_session_revoke_all should succeed');

				// Verify fails after revocation
				const after = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers,
				});
				assert.strictEqual(after.status, 401);
			});
		});

		// --- 4b. Password change ---

		describe('password change', () => {
			test('password change invalidates all sessions and allows login with new password', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				const password_route = find_auth_route(route_specs, '/password', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);

				const headers = fixture.create_session_headers({
					'content-type': 'application/json',
				});

				// Change password
				const change_res = await fixture.transport(password_route.path, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						current_password: DEFAULT_TEST_PASSWORD,
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
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: fixture.create_session_headers(),
				});
				assert.strictEqual(verify_after.status, 401);

				// Login with new password works
				const login_res = await fixture.transport(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: fixture.account.username,
						password: 'new-password-456',
					}),
				});
				assert.strictEqual(login_res.status, 200);
				const login_body = await login_res.json();
				assert.strictEqual(login_body.ok, true);
			});

			test('password change with wrong current password returns 401', async () => {
				const fixture = await options.setup_test();
				const password_route = find_auth_route(route_specs, '/password', 'POST');
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(password_route.path, {
					method: 'POST',
					headers: fixture.create_session_headers({
						'content-type': 'application/json',
					}),
					body: JSON.stringify({
						current_password: 'wrong-password-999',
						new_password: 'new-password-456',
					}),
				});
				assert.strictEqual(res.status, 401);
				error_collector.record(route_specs, 'POST', password_route.path, 401);

				// Session should still be valid (password didn't change)
				const verify_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: fixture.create_session_headers(),
				});
				assert.strictEqual(verify_res.status, 200);
			});
		});

		// --- 5. Origin verification ---

		describe('origin verification', () => {
			// Disallowed-Origin → 403 and absent-Origin → pass promoted to the
			// dedicated cross-backend origin parity suite (`cross_backend/origin.ts`,
			// both legs) — it drives raw transport calls against each spine's real
			// origin middleware. This positive control stays here as a basic
			// happy-path check in the consumer integration bundle.
			test('valid origin is accepted', async () => {
				const fixture = await options.setup_test();
				const res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: fixture.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);
			});
		});

		// --- 6. Bearer auth ---

		describe('bearer auth', () => {
			test('valid bearer token authenticates', async () => {
				const fixture = await options.setup_test();
				const res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: fixture.create_bearer_headers(),
					suppress_default_origin: true,
				});
				assert.strictEqual(res.status, 200);
			});

			test('invalid bearer token returns 401', async () => {
				const fixture = await options.setup_test();
				// `origin: null` — bearer auth requires no browser-context
				// indicator; the default `Origin: <base_url>` would silently
				// discard the bearer cross-process.
				const res = await rpc_call_for_spec({
					app: {request: fixture.fresh_transport({origin: null})},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {authorization: 'Bearer secret_fuz_token_invalid'},
					suppress_default_origin: true,
				});
				assert.strictEqual(res.status, 401);
			});

			test('bearer token with Origin header is rejected', async () => {
				const fixture = await options.setup_test();
				const bearer_headers = fixture.create_bearer_headers();

				// Without Origin — works. `origin: null` so the transport
				// doesn't auto-add the default Origin (which would discard
				// the bearer as browser-context cross-process).
				const ok_res = await rpc_call_for_spec({
					app: {request: fixture.fresh_transport({origin: null})},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: bearer_headers,
					suppress_default_origin: true,
				});
				assert.strictEqual(ok_res.status, 200);

				// With Origin — bearer silently discarded (browser context), falls through to no auth.
				const res = await rpc_call_for_spec({
					app: {request: fixture.fresh_transport()},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {...bearer_headers, origin: 'http://localhost:5173'},
				});
				assert.strictEqual(res.status, 401);
			});
		});

		// --- 7. Token revocation ---

		describe('token revocation', () => {
			test('revoked API token returns 401', async () => {
				const fixture = await options.setup_test();

				// Create a new token via RPC
				const create_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'test-revoke'},
					headers: fixture.create_session_headers(),
				});
				assert.ok(create_res.ok, 'account_token_create should succeed');
				const {token, id} = create_res.result;

				// Verify token works — fresh transport so the per-test session
				// cookie in `fixture.transport`'s jar can't give a false pass
				// when the bearer is the credential under test. `origin: null`
				// so the transport doesn't auto-add a default Origin (which
				// would discard the bearer as browser-context cross-process).
				const use_res = await rpc_call_for_spec({
					app: {request: fixture.fresh_transport({origin: null})},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {authorization: `Bearer ${token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(use_res.status, 200);

				// Revoke via RPC
				const revoke_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_token_revoke_action_spec,
					params: {token_id: id},
					headers: fixture.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_token_revoke should succeed');

				// Token should no longer work — fresh transport same reason as
				// the `use_res` call above.
				const after_res = await rpc_call_for_spec({
					app: {request: fixture.fresh_transport({origin: null})},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {authorization: `Bearer ${token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(after_res.status, 401);
			});
		});

		// --- 8. Cross-account isolation ---

		describe('cross-account isolation', () => {
			test('non-admin cannot access admin routes', async () => {
				const fixture = await options.setup_test();

				// admin routes are optional in the base suite — admin-specific coverage
				// lives in describe_standard_admin_integration_tests.
				//
				// Pick an admin REST route where a clean role-denial 403 is
				// reachable: account-grain (`actor: 'none'`, so the authorization
				// phase doesn't first demand an acting actor → `actor_required`)
				// and input/param/query-free (so input validation doesn't 400
				// first, per the 401 → 400 → 403 phase order). Admin surfaces are
				// RPC-first now; a consumer may expose no such REST route (fuz_app
				// itself, zzz) — then this REST-era check is a no-op and RPC denial
				// is covered by `describe_rpc_attack_surface_tests`.
				const admin_route = route_specs.find(
					(s) =>
						(s.auth.roles?.includes('admin') ?? false) &&
						s.auth.actor === 'none' &&
						!s.input &&
						!s.params &&
						!s.query,
				);
				if (!admin_route) return;

				// Probe with a freshly-created account — it holds no admin role
				// (the keeper fixture behind `create_session_headers` does, so it
				// would pass the gate).
				const non_admin = await fixture.create_account({username: 'non_admin_admin_probe'});
				const res = await fixture.transport(admin_route.path, {
					method: admin_route.method,
					headers: {cookie: `${cookie_name}=${non_admin.session_cookie}`},
				});
				assert.strictEqual(res.status, 403);
				const body = await res.json();
				assert.strictEqual(body.error, 'insufficient_permissions');
			});

			test("user A cannot revoke user B's sessions", async () => {
				const fixture = await options.setup_test();

				// Create a second account
				const user_b = await fixture.create_account({username: 'user_b'});

				// User A revokes all their own sessions
				const revoke_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_session_revoke_all_action_spec,
					params: undefined,
					headers: fixture.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_session_revoke_all should succeed');

				// User B's session should still work
				const verify_b = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {cookie: `${cookie_name}=${user_b.session_cookie}`},
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A cannot revoke user B's session by ID", async () => {
				const fixture = await options.setup_test();

				const user_b = await fixture.create_account({username: 'user_b'});
				const user_b_headers = {cookie: `${cookie_name}=${user_b.session_cookie}`};

				// Get user B's session ID by listing as user B
				const list_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: undefined,
					headers: user_b_headers,
				});
				assert.ok(list_res.ok, 'account_session_list should succeed');
				assert.ok(list_res.result.sessions.length >= 1);
				const session_id_b = list_res.result.sessions[0]!.id;

				// User A tries to revoke user B's session by ID
				const revoke_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_session_revoke_action_spec,
					params: {session_id: session_id_b},
					headers: fixture.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_session_revoke should succeed');
				assert.strictEqual(
					revoke_res.result.revoked,
					false,
					'Should not revoke another account session',
				);

				// User B's session should still work
				const verify_b = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: user_b_headers,
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A cannot revoke user B's token by ID", async () => {
				const fixture = await options.setup_test();

				const user_b = await fixture.create_account({username: 'user_b'});
				const user_b_headers = {cookie: `${cookie_name}=${user_b.session_cookie}`};

				// Get user B's token ID by listing as user B
				const list_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_token_list_action_spec,
					params: undefined,
					headers: user_b_headers,
				});
				assert.ok(list_res.ok, 'account_token_list should succeed');
				assert.ok(list_res.result.tokens.length >= 1);
				const token_id_b = list_res.result.tokens[0]!.id;

				// User A tries to revoke user B's token by ID
				const revoke_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_token_revoke_action_spec,
					params: {token_id: token_id_b},
					headers: fixture.create_session_headers(),
				});
				assert.ok(revoke_res.ok, 'account_token_revoke should succeed');
				assert.strictEqual(
					revoke_res.result.revoked,
					false,
					'Should not revoke another account token',
				);

				// User B's bearer token should still work
				const verify_b = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {authorization: `Bearer ${user_b.api_token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(verify_b.status, 200);
			});

			test("user A's session list does not include user B's sessions", async () => {
				const fixture = await options.setup_test();

				const user_b = await fixture.create_account({username: 'user_b'});

				// User A lists sessions
				const res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: undefined,
					headers: fixture.create_session_headers(),
				});
				assert.ok(res.ok, 'account_session_list should succeed');

				// Sessions should only belong to user A's account
				for (const session of res.result.sessions) {
					assert.strictEqual(
						session.account_id,
						fixture.account.id,
						`Session ${session.id} should belong to user A, not user B (${user_b.account.id})`,
					);
				}
			});

			test("user A's token list does not include user B's tokens", async () => {
				const fixture = await options.setup_test();

				const user_b = await fixture.create_account({username: 'user_b'});

				// User A lists tokens
				const res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_token_list_action_spec,
					params: undefined,
					headers: fixture.create_session_headers(),
				});
				assert.ok(res.ok, 'account_token_list should succeed');

				// Tokens should only belong to user A's account
				for (const token of res.result.tokens) {
					assert.strictEqual(
						token.account_id,
						fixture.account.id,
						`Token ${token.id} should belong to user A, not user B (${user_b.account.id})`,
					);
				}
			});
		});

		// --- 9. Response body validation ---

		describe('response body validation', () => {
			// `assert_response_matches_spec` validates REST `RouteSpec` outputs.
			// Session/token CRUD lives on the RPC surface; only /login, /logout,
			// /password remain as REST routes whose responses we exercise here.
			// RPC output validation is covered by `describe_rpc_round_trip_tests`.

			test('POST /login 401 response matches declared error schema', async () => {
				const fixture = await options.setup_test();
				const login_route = find_auth_route(route_specs, '/login', 'POST');
				assert.ok(
					login_route,
					'Expected POST /login route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(login_route.path, {
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
				await assert_response_matches_spec(route_specs, 'POST', login_route.path, res);
			});

			test('POST /logout 200 response matches output schema', async () => {
				const fixture = await options.setup_test();
				const logout_route = find_auth_route(route_specs, '/logout', 'POST');
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.transport(logout_route.path, {
					method: 'POST',
					headers: fixture.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({}),
				});
				assert.strictEqual(res.status, 200);
				await assert_response_matches_spec(route_specs, 'POST', logout_route.path, res);
			});

			test('POST /logout 401 response matches declared error schema', async () => {
				const fixture = await options.setup_test();
				const logout_route = find_auth_route(route_specs, '/logout', 'POST');
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				const res = await fixture.fresh_transport()(logout_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({}),
				});
				assert.strictEqual(res.status, 401);
				await assert_response_matches_spec(route_specs, 'POST', logout_route.path, res);
			});
		});

		// Rate-limit behavior is covered end-to-end by
		// `describe_rate_limiting_tests` against the full middleware stack.
		// A per-suite smoke test isn't reintroduced here because the
		// `setup_test` single-fixture model can't carry per-test rate-limiter
		// overrides without each test re-constructing its own `TestApp`.

		// --- 10c2. Error coverage: unauthenticated access to auth-required routes ---

		describe('error coverage breadth', () => {
			test('exercises 401 on multiple auth-required routes for error coverage', async () => {
				const fixture = await options.setup_test();
				// Hit several auth-required RPC methods without credentials to
				// broaden error coverage beyond just /login. RPC 401s are tracked
				// against the shared endpoint path. The dispatcher runs auth before
				// params validation, so any well-formed param body works — we just
				// need each call to be type-correct wrt its spec.
				//
				// Fresh transport so the per-test session cookie in
				// `fixture.transport`'s jar doesn't leak into these unauthed
				// probes and convert their expected 401s into 200s.
				const unauthed = fixture.fresh_transport();
				const session_list = await rpc_call_for_spec({
					app: {request: unauthed},
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: undefined,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(session_list.status, 401);
				error_collector.record(route_specs, 'POST', rpc_path, 401);

				const session_revoke_all = await rpc_call_for_spec({
					app: {request: unauthed},
					path: rpc_path,
					spec: account_session_revoke_all_action_spec,
					params: undefined,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(session_revoke_all.status, 401);
				error_collector.record(route_specs, 'POST', rpc_path, 401);

				const token_list = await rpc_call_for_spec({
					app: {request: unauthed},
					path: rpc_path,
					spec: account_token_list_action_spec,
					params: undefined,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(token_list.status, 401);
				error_collector.record(route_specs, 'POST', rpc_path, 401);

				const token_create = await rpc_call_for_spec({
					app: {request: unauthed},
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'unauth-probe'},
					headers: {host: 'localhost'},
				});
				assert.strictEqual(token_create.status, 401);
				error_collector.record(route_specs, 'POST', rpc_path, 401);

				const verify = await rpc_call_for_spec({
					app: {request: unauthed},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(verify.status, 401);
				error_collector.record(route_specs, 'POST', rpc_path, 401);
				// Also exercise POST /logout without auth (still REST)
				const logout_route = find_auth_route(route_specs, '/logout', 'POST');
				if (logout_route) {
					const res = await unauthed(logout_route.path, {
						method: 'POST',
						headers: {host: 'localhost', 'content-type': 'application/json'},
						body: JSON.stringify({}),
					});
					assert.strictEqual(res.status, 401, 'POST /logout without auth should return 401');
					error_collector.record(route_specs, 'POST', logout_route.path, 401);
				}
			});
		});

		// --- 10c. Error response information leakage ---

		describe('error response information leakage', () => {
			test('401 responses contain no leaky fields', async () => {
				const fixture = await options.setup_test();
				const res = await rpc_call_for_spec({
					app: {request: fixture.fresh_transport()},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {host: 'localhost'},
				});
				assert.strictEqual(res.status, 401);
				assert.ok(!res.ok);
				// Check every field on the JSON-RPC `error` object — `data` carries the
				// handler-authored shape, but `message` and any sibling fields should
				// equally be free of stack traces, file paths, or other internals.
				assert_no_error_info_leakage(
					res.error,
					`RPC ${account_verify_action_spec.method} 401 error envelope`,
				);
			});
		});

		// --- 11. Expired credential rejection ---

		// Expired-credential rejection (read + mutation paths) promoted to the
		// cross-backend conformance table (`conformance_expiry_cases.ts`, the
		// `expired_session` principal) — it asserts the authoritative
		// server-side DB-row expiry gate over real auth resolution on every
		// spine. The two near-identical in-process skips this replaced (both an
		// `account_verify` read) collapse into the single read row there; the
		// `/logout` mutation path is the second row.

		// --- 12. Bearer token browser context on mutation routes ---

		describe('bearer token browser context silently discarded on mutations', () => {
			test('bearer token with Origin header discarded on POST logout', async () => {
				const fixture = await options.setup_test();
				const logout_route = find_auth_route(route_specs, '/logout', 'POST');
				assert.ok(
					logout_route,
					'Expected POST /logout route — ensure create_route_specs includes account routes',
				);

				const bearer_headers = fixture.create_bearer_headers({
					'content-type': 'application/json',
				});
				const res = await fixture.fresh_transport()(logout_route.path, {
					method: 'POST',
					headers: {...bearer_headers, origin: 'http://localhost:5173'},
				});
				assert.strictEqual(
					res.status,
					401,
					'Bearer with Origin should be discarded → unauthenticated',
				);
				error_collector.record(route_specs, 'POST', logout_route.path, 401);
			});

			test('bearer token with Referer header discarded on POST password', async () => {
				const fixture = await options.setup_test();
				const password_route = find_auth_route(route_specs, '/password', 'POST');
				assert.ok(
					password_route,
					'Expected POST /password route — ensure create_route_specs includes account routes',
				);

				const bearer_headers = fixture.create_bearer_headers({
					'content-type': 'application/json',
				});
				const res = await fixture.fresh_transport()(password_route.path, {
					method: 'POST',
					headers: {...bearer_headers, referer: 'http://localhost:5173/admin'},
				});
				assert.strictEqual(
					res.status,
					401,
					'Bearer with Referer should be discarded → unauthenticated',
				);
				error_collector.record(route_specs, 'POST', password_route.path, 401);
			});
		});

		// --- 13. Password change revokes API tokens ---

		describe('password change revokes API tokens', () => {
			test('API tokens are invalidated after password change', async () => {
				const fixture = await options.setup_test();
				const password_route = find_auth_route(route_specs, '/password', 'POST');
				assert.ok(password_route, 'Expected POST /password route');

				// Create an API token via RPC
				const create_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'test-token'},
					headers: fixture.create_session_headers(),
				});
				assert.ok(create_res.ok, 'account_token_create should succeed');
				const {token: raw_token} = create_res.result;
				assert.ok(raw_token, 'Expected raw token in create response');

				// Verify bearer token works
				const verify_before = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
					headers: {authorization: `Bearer ${raw_token}`},
					suppress_default_origin: true,
				});
				assert.strictEqual(
					verify_before.status,
					200,
					'Bearer token should work before password change',
				);

				// Change password (still REST)
				const change_res = await fixture.transport(password_route.path, {
					method: 'POST',
					headers: fixture.create_session_headers({'content-type': 'application/json'}),
					body: JSON.stringify({
						current_password: DEFAULT_TEST_PASSWORD,
						new_password: 'new-password-456',
					}),
				});
				assert.strictEqual(change_res.status, 200);
				const change_body = await change_res.json();
				assert.ok(typeof change_body.tokens_revoked === 'number', 'Expected tokens_revoked count');
				assert.ok(change_body.tokens_revoked >= 1, 'Expected at least 1 token revoked');

				// Bearer token should now be invalid
				const verify_after = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: account_verify_action_spec,
					params: undefined,
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
				const fixture = await options.setup_test();

				const signup_route = route_specs.find(
					(s) => s.method === 'POST' && s.path.endsWith('/signup') && is_public_auth(s.auth),
				);
				if (!signup_route) return; // signup is optional

				// `invite_create` lives on the RPC surface; consumers that don't
				// wire admin RPC actions can't exercise invites — skip the test
				// rather than fail.
				if (!find_rpc_action(rpc_endpoints_for_setup, invite_create_action_spec.method)) return;

				// Drive the admin-gated `invite_create` over the fixture's
				// session. In both modes the fixture is the fresh keeper,
				// holding `[ROLE_KEEPER, ROLE_ADMIN, ...extra_keeper_roles]`
				// from the bootstrap-equivalent seed step — `extra_keeper_roles:
				// [ROLE_ADMIN]` is technically redundant for the admin suite
				// but harmless. `fixture.create_session_headers()` resolves to
				// a session with admin role.

				// `open_signup` stays at production default (`false`) across both
				// in-process (per-test bootstrap default) and cross-process (the
				// invite-gated `mint_account` flow doesn't need it flipped), so
				// the assertion fires without any mid-test setting toggle.

				// Create invite for alice@example.com via RPC
				const invite_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
					path: rpc_path,
					spec: invite_create_action_spec,
					params: {email: 'alice@example.com'},
					headers: fixture.create_session_headers(),
				});
				assert.ok(
					invite_res.ok,
					`invite_create failed: ${invite_res.ok ? '' : JSON.stringify(invite_res.error)}`,
				);

				// Try to sign up with a different email — should fail (no matching invite)
				const signup_res = await fixture.transport(signup_route.path, {
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
				const fixture = await options.setup_test();

				// Find signup route (POST ending in /signup, public)
				const signup_route = route_specs.find(
					(s) => s.method === 'POST' && s.path.endsWith('/signup') && is_public_auth(s.auth),
				);
				if (!signup_route) return; // signup is optional

				// `invite_create` lives on the RPC surface; consumers that don't
				// wire admin RPC actions can't exercise invites.
				if (!find_rpc_action(rpc_endpoints_for_setup, invite_create_action_spec.method)) return;

				// Drive admin-gated calls over the fixture's session — see the
				// previous test's comment for the in-process / cross-process
				// admin-resolution paths. This test creates a separate
				// `existing_user` for the username-conflict assertion, so
				// reusing the fixture's admin session for the invite-creating
				// path has no cross-account-isolation impact on the test's intent.
				const admin_headers = fixture.create_session_headers();

				// Mint the conflict-test sibling account for the username-conflict
				// assertion below. Both transports preserve hardcoded usernames
				// now that fresh-keeper-per-test wipes the DB between tests.
				const existing_user = await fixture.create_account({username: 'existing_user'});

				// Create an invite for a specific test email via RPC
				const test_email = 'signup-test@example.com';
				const invite_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
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
				const no_match_res = await fixture.transport(signup_route.path, {
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

				// Create invite for a different email via RPC
				const conflict_email = 'conflict-test@example.com';
				const invite2_res = await rpc_call_for_spec({
					app: {request: fixture.transport},
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
				const conflict_res = await fixture.transport(signup_route.path, {
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
