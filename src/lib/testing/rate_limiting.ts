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
import type {AppServerContext, AppServerOptions} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {RateLimiter} from '../rate_limiter.js';
import {RateLimitError} from '../http/error_schemas.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import {create_test_app} from './app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
	type DbFactory,
} from './db.js';
import {find_auth_route, assert_rate_limit_retry_after_header} from './integration_helpers.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';

/**
 * Configuration for `describe_rate_limiting_tests`.
 */
export interface RateLimitingTestOptions {
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
	 */
	db_factories?: Array<DbFactory>;
	/**
	 * Maximum attempts before rate limiting kicks in.
	 * Default: `2` (tight limit for fast tests).
	 */
	max_attempts?: number;
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
 * @param options - session config and route factory
 */
export const describe_rate_limiting_tests = (options: RateLimitingTestOptions): void => {
	const max_attempts = options.max_attempts ?? 2;

	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [AUTH_MIGRATION_NS]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];
	const describe_db = create_describe_db(factories, AUTH_INTEGRATION_TRUNCATE_TABLES);

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
					/* eslint-disable no-await-in-loop */
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
					/* eslint-enable no-await-in-loop */

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
					/* eslint-disable no-await-in-loop */
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
					/* eslint-enable no-await-in-loop */

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
						app_options: {
							...options.app_options,
							ip_rate_limiter: null,
							login_account_rate_limiter: null,
							bearer_ip_rate_limiter,
						},
					});
					const verify_route = find_auth_route(test_app.route_specs, '/verify', 'GET');
					assert.ok(
						verify_route,
						'Expected GET /verify route — ensure create_route_specs includes account routes',
					);

					// Fire max_attempts invalid bearer requests (sequential — must exhaust the window)
					/* eslint-disable no-await-in-loop */
					for (let i = 0; i < max_attempts; i++) {
						const res = await test_app.app.request(verify_route.path, {
							headers: {
								host: 'localhost',
								authorization: 'Bearer secret_fuz_token_invalid',
							},
						});
						assert.notStrictEqual(
							res.status,
							429,
							`Request ${i + 1}/${max_attempts} should not be rate limited`,
						);
					}
					/* eslint-enable no-await-in-loop */

					// The next request should be rate limited
					const blocked_res = await test_app.app.request(verify_route.path, {
						headers: {
							host: 'localhost',
							authorization: 'Bearer secret_fuz_token_invalid',
						},
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
