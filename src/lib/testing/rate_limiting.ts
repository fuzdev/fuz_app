import './assert_dev_env.ts';

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
 * Each test body constructs its own `TestApp` with a per-test rate limiter
 * override in `app_options`, so this suite reads its inputs directly from
 * the options bag instead of going through the per-test fixture protocol —
 * the single-fixture model can't carry three different rate-limiter
 * configurations. Consumers pass `default_in_process_suite_options(...)`
 * anyway for shape uniformity with the other Tier 1 suites; the extra
 * `{setup_test, surface_source, capabilities}` fields from the helper
 * spread are ignored by TS and the suite body alike.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import type { SessionOptions } from '../auth/session_cookie.ts';
import type { AppServerContext } from '../server/app_server_context.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import { RateLimiter } from '../rate_limiter.ts';
import { RateLimitError } from '../http/error_schemas.ts';
import { auth_migration_ns } from '../auth/migrations.ts';
import { create_test_app, type SuiteAppOptions } from './app_server.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
	type DbFactory
} from './db.ts';
import { find_auth_route, assert_rate_limit_retry_after_header } from './integration_helpers.ts';
import type { RpcEndpointsSuiteOption } from './rpc_helpers.ts';
import { run_migrations } from '../db/migrate.ts';
import type { Db } from '../db/db.ts';

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
	 * RPC endpoint specs mounted on the test app. Optional — both suites below
	 * exercise REST auth routes, so nothing here needs an RPC path.
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` — the factory form
	 * is required when action handlers must close over the per-test
	 * `ctx.deps`.
	 */
	rpc_endpoints?: RpcEndpointsSuiteOption;
}

/**
 * Standard rate limiting integration test suite.
 *
 * Creates 2 test groups:
 * 1. IP rate limiting on login — fires `max_attempts + 1` login requests,
 *    verifies the last returns 429 with a valid `RateLimitError` body.
 * 2. Per-account rate limiting on login — fires `max_attempts + 1` login
 *    requests with the same username, verifies the last returns 429.
 *
 * There is deliberately no bearer-auth group: the bearer path carries no rate
 * limiter on either spine, because an API token's entropy — not throttling —
 * is what bounds guessing it. See `auth/bearer_auth.ts`.
 *
 * Each test group asserts that required routes exist, failing with a descriptive
 * message if the consumer's route specs are misconfigured.
 */
export const describe_rate_limiting_tests = (options: RateLimitingTestOptions): void => {
	const max_attempts = options.max_attempts ?? 2;
	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [auth_migration_ns]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];
	const describe_db = create_describe_db(factories, auth_integration_truncate_tables);

	/** Create a tight rate limiter for testing — low attempt count, long window. */
	const create_test_rate_limiter = (): RateLimiter =>
		new RateLimiter({ max_attempts, window_ms: 60_000, cleanup_interval_ms: 0 });

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
							login_account_rate_limiter: null
						}
					});
					const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
					assert.ok(
						login_route,
						'Expected POST /login route — ensure create_route_specs includes account routes'
					);

					// Fire max_attempts failed login requests (sequential — must exhaust the window)

					for (let i = 0; i < max_attempts; i++) {
						const res = await test_app.app.request(login_route.path, {
							method: 'POST',
							headers: {
								host: 'localhost',
								origin: 'http://localhost:5173',
								'content-type': 'application/json'
							},
							body: JSON.stringify({ username: 'nonexistent', password: 'wrong' })
						});
						assert.notStrictEqual(
							res.status,
							429,
							`Request ${i + 1}/${max_attempts} should not be rate limited`
						);
					}

					// The next request should be rate limited
					const blocked_res = await test_app.app.request(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json'
						},
						body: JSON.stringify({ username: 'nonexistent', password: 'wrong' })
					});
					assert.strictEqual(blocked_res.status, 429);
					const body = await blocked_res.json();
					RateLimitError.parse(body);
					assert.ok(
						typeof body.retry_after === 'number' && body.retry_after > 0,
						'Expected positive retry_after'
					);
					assert_rate_limit_retry_after_header(blocked_res, body);
				} finally {
					ip_rate_limiter.dispose();
				}
			});
		});

		// --- 2. Per-account rate limiting on login ---

		describe('per-account rate limiting on login', () => {
			test(`login is blocked after ${
				max_attempts
			} failed attempts for the same username`, async () => {
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
							login_account_rate_limiter
						}
					});
					const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
					assert.ok(
						login_route,
						'Expected POST /login route — ensure create_route_specs includes account routes'
					);

					const target_username = 'rate_limit_target';

					// Fire max_attempts failed login requests for the same username

					for (let i = 0; i < max_attempts; i++) {
						const res = await test_app.app.request(login_route.path, {
							method: 'POST',
							headers: {
								host: 'localhost',
								origin: 'http://localhost:5173',
								'content-type': 'application/json'
							},
							body: JSON.stringify({ username: target_username, password: 'wrong' })
						});
						assert.notStrictEqual(
							res.status,
							429,
							`Request ${i + 1}/${max_attempts} should not be rate limited`
						);
					}

					// The next request for the same username should be rate limited
					const blocked_res = await test_app.app.request(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json'
						},
						body: JSON.stringify({ username: target_username, password: 'wrong' })
					});
					assert.strictEqual(blocked_res.status, 429);
					const body = await blocked_res.json();
					RateLimitError.parse(body);
					assert.ok(
						typeof body.retry_after === 'number' && body.retry_after > 0,
						'Expected positive retry_after'
					);
					assert_rate_limit_retry_after_header(blocked_res, body);

					// A different username should NOT be rate limited
					const other_res = await test_app.app.request(login_route.path, {
						method: 'POST',
						headers: {
							host: 'localhost',
							origin: 'http://localhost:5173',
							'content-type': 'application/json'
						},
						body: JSON.stringify({ username: 'different_user', password: 'wrong' })
					});
					assert.notStrictEqual(
						other_res.status,
						429,
						'Different username should not be rate limited'
					);
				} finally {
					login_account_rate_limiter.dispose();
				}
			});
		});
	});
};
