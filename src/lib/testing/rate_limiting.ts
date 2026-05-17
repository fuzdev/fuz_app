import './assert_dev_env.js';

/**
 * Rate limiting integration test suite.
 *
 * Verifies that sensitive routes (login, bootstrap, token creation) enforce
 * rate limits when rate limiters are enabled. Tests create a tight rate limiter
 * (2 attempts / 1 minute) and fire requests until 429 is returned.
 *
 * Consumers call `describe_rate_limiting_tests` with their route factory and
 * session config — rate limit enforcement tests come for free.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import type {SessionOptions} from '../auth/session_cookie.js';
import type {AppServerContext} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {RateLimiter} from '../rate_limiter.js';
import {RateLimitError} from '../http/error_schemas.js';
import {auth_migration_ns} from '../auth/migrations.js';
import {create_test_app, type SuiteAppOptions} from './app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
	type DbFactory,
} from './db.js';
import {find_auth_route, assert_rate_limit_retry_after_header} from './integration_helpers.js';
import {
	rpc_call_non_browser,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';
import {account_verify_action_spec} from '../auth/account_action_specs.js';

/**
 * Configuration for `describe_rate_limiting_tests`.
 */
export interface RateLimitingTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: SuiteAppOptions;
	/**
	 * Database factories to run tests against. Default: pglite only.
	 */
	db_factories?: Array<DbFactory>;
	/**
	 * Maximum attempts before rate limiting kicks in.
	 * Default: `2` (tight limit for fast tests).
	 */
	max_attempts?: number;
	/**
	 * RPC endpoint specs — required so the bearer-auth rate limiting test
	 * can probe an authenticated method via the `account_verify` RPC
	 * action. Hard-fails via `require_rpc_endpoint_path` on setup.
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` — the factory form
	 * is required when action handlers must close over the per-test
	 * `ctx.app_settings` / `ctx.deps`. The factory must return the same
	 * endpoint `path` regardless of ctx — it is invoked once at setup with
	 * a stub ctx for path lookup and again per-test by `create_app_server`
	 * for live dispatch.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
}

/**
 * Standard rate limiting integration test suite.
 *
 * Creates 3 test groups:
 * 1. IP rate limiting on login — fires `max_attempts + 1` login requests,
 *    verifies the last returns 429 with a valid `RateLimitError` body.
 * 2. Per-account rate limiting on login — fires `max_attempts + 1` login
 *    requests with the same username, verifies the last returns 429.
 * 3. Bearer auth IP rate limiting — fires `max_attempts + 1` bearer requests
 *    with an invalid token, verifies the last returns 429.
 *
 * Each test group asserts that required routes exist, failing with a descriptive
 * message if the consumer's route specs are misconfigured.
 *
 * @throws Error at setup time when `options.rpc_endpoints` is empty — the
 *   bearer-auth rate-limit test probes via the `account_verify` RPC action,
 *   so the suite hard-fails via `require_rpc_endpoint_path`.
 */
export const describe_rate_limiting_tests = (options: RateLimitingTestOptions): void => {
	const max_attempts = options.max_attempts ?? 2;
	// Hard-fail early so consumers see a clear setup error instead of a
	// confusing test failure when `rpc_endpoints` is missing. Factory-form
	// callers are resolved with a stub ctx purely to extract the endpoint
	// path; real handlers run per-test via the top-level `rpc_endpoints` slot on `CreateTestAppOptions`.
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

	/** Create a tight rate limiter for testing — low attempt count, long window. */
	const create_test_rate_limiter = (): RateLimiter =>
		new RateLimiter({max_attempts, window_ms: 60_000, cleanup_interval_ms: 0});

	describe_db('rate_limiting', (get_db) => {
		// --- 1. IP rate limiting on login ---

		describe('IP rate limiting on login', () => {
			test(`login is blocked after ${max_attempts} failed attempts`, async () => {
				const ip_rate_limiter = create_test_rate_limiter();
				try {
					const test_app = await create_test_app({
						session_options: options.session_options,
						create_route_specs: options.create_route_specs,
						db: get_db(),
						rpc_endpoints: options.rpc_endpoints,
						app_options: {
							...options.app_options,
							ip_rate_limiter,
							login_account_rate_limiter: null,
							bearer_ip_rate_limiter: null,
						},
					});
					const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
					assert.ok(
						login_route,
						'Expected POST /login route — ensure create_route_specs includes account routes',
					);

					// Fire max_attempts failed login requests (sequential — must exhaust the window)

					for (let i = 0; i < max_attempts; i++) {
						const res = await test_app.app.request(login_route.path, {
							method: 'POST',
							headers: {
								host: 'localhost',
								origin: 'http://localhost:5173',
								'content-type': 'application/json',
							},
							body: JSON.stringify({username: 'nonexistent', password: 'wrong'}),
						});
						assert.notStrictEqual(
							res.status,
							429,
							`Request ${i + 1}/${max_attempts} should not be rate limited`,
						);
					}

					// The next request should be rate limited
					const blocked_res = await test_app.app.request(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json',
						},
						body: JSON.stringify({username: 'nonexistent', password: 'wrong'}),
					});
					assert.strictEqual(blocked_res.status, 429);
					const body = await blocked_res.json();
					RateLimitError.parse(body);
					assert.ok(
						typeof body.retry_after === 'number' && body.retry_after > 0,
						'Expected positive retry_after',
					);
					assert_rate_limit_retry_after_header(blocked_res, body);
				} finally {
					ip_rate_limiter.dispose();
				}
			});
		});

		// --- 2. Per-account rate limiting on login ---

		describe('per-account rate limiting on login', () => {
			test(`login is blocked after ${max_attempts} failed attempts for the same username`, async () => {
				const login_account_rate_limiter = create_test_rate_limiter();
				try {
					const test_app = await create_test_app({
						session_options: options.session_options,
						create_route_specs: options.create_route_specs,
						db: get_db(),
						rpc_endpoints: options.rpc_endpoints,
						app_options: {
							...options.app_options,
							ip_rate_limiter: null,
							login_account_rate_limiter,
							bearer_ip_rate_limiter: null,
						},
					});
					const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
					assert.ok(
						login_route,
						'Expected POST /login route — ensure create_route_specs includes account routes',
					);

					const target_username = 'rate_limit_target';

					// Fire max_attempts failed login requests for the same username

					for (let i = 0; i < max_attempts; i++) {
						const res = await test_app.app.request(login_route.path, {
							method: 'POST',
							headers: {
								host: 'localhost',
								origin: 'http://localhost:5173',
								'content-type': 'application/json',
							},
							body: JSON.stringify({username: target_username, password: 'wrong'}),
						});
						assert.notStrictEqual(
							res.status,
							429,
							`Request ${i + 1}/${max_attempts} should not be rate limited`,
						);
					}

					// The next request for the same username should be rate limited
					const blocked_res = await test_app.app.request(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json',
						},
						body: JSON.stringify({username: target_username, password: 'wrong'}),
					});
					assert.strictEqual(blocked_res.status, 429);
					const body = await blocked_res.json();
					RateLimitError.parse(body);
					assert.ok(
						typeof body.retry_after === 'number' && body.retry_after > 0,
						'Expected positive retry_after',
					);
					assert_rate_limit_retry_after_header(blocked_res, body);

					// A different username should NOT be rate limited
					const other_res = await test_app.app.request(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json',
						},
						body: JSON.stringify({username: 'different_user', password: 'wrong'}),
					});
					assert.notStrictEqual(
						other_res.status,
						429,
						'Different username should not be rate limited',
					);
				} finally {
					login_account_rate_limiter.dispose();
				}
			});
		});

		// --- 3. Bearer auth IP rate limiting ---

		describe('bearer auth IP rate limiting', () => {
			test(`bearer auth is blocked after ${max_attempts} invalid token attempts`, async () => {
				const bearer_ip_rate_limiter = create_test_rate_limiter();
				try {
					const test_app = await create_test_app({
						session_options: options.session_options,
						create_route_specs: options.create_route_specs,
						db: get_db(),
						rpc_endpoints: options.rpc_endpoints,
						app_options: {
							...options.app_options,
							ip_rate_limiter: null,
							login_account_rate_limiter: null,
							bearer_ip_rate_limiter,
						},
					});
					// Probe `account_verify` via RPC with an invalid bearer token.
					// The REST `/api/account/verify` shim is status-only (empty body
					// for nginx `auth_request`), so we use the RPC surface to exercise
					// a typed authenticated method. The bearer_auth rate limiter
					// increments per attempt regardless of the route's own auth outcome.
					// Use `rpc_call_non_browser` so the default `origin` header is
					// suppressed — bearer_auth discards the token when Origin or
					// Referer is present (browser context), which would short-circuit
					// before the rate limiter records the attempt.
					//
					// Note: the rate limiter short-circuits before the RPC dispatcher,
					// so the 429 response is a REST-shaped `RateLimitError`, not a
					// JSON-RPC envelope. We use the underlying `app.request` for the
					// blocked probe so `rpc_call_non_browser` doesn't throw on the
					// non-envelope body.
					const bearer_probe_headers: Record<string, string> = {
						authorization: 'Bearer secret_fuz_token_invalid',
					};

					// Fire max_attempts invalid bearer requests (sequential — must exhaust the window)
					for (let i = 0; i < max_attempts; i++) {
						const res = await rpc_call_non_browser({
							app: test_app.app,
							path: rpc_path,
							method: account_verify_action_spec.method,
							id: 'rl-probe',
							headers: bearer_probe_headers,
						});
						assert.notStrictEqual(
							res.status,
							429,
							`Request ${i + 1}/${max_attempts} should not be rate limited`,
						);
					}

					// The next request should be rate limited. The 429 body is REST-shape
					// (middleware short-circuits before the RPC dispatcher), so go
					// direct — `rpc_call_non_browser` would throw on the non-envelope body.
					const blocked_res = await test_app.app.request(rpc_path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							'content-type': 'application/json',
							...bearer_probe_headers,
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							method: account_verify_action_spec.method,
							id: 'rl-probe-blocked',
						}),
					});
					assert.strictEqual(blocked_res.status, 429);
					const body = await blocked_res.json();
					RateLimitError.parse(body);
					assert_rate_limit_retry_after_header(blocked_res, body);
				} finally {
					bearer_ip_rate_limiter.dispose();
				}
			});
		});
	});
};
