import './assert_dev_env.js';

/**
 * Schema-driven round-trip validation test suite.
 *
 * For every route spec, generates a valid request (auth, params, body)
 * and validates the response against declared output or error schemas.
 * DB-backed via `create_test_app` — exercises the full middleware stack.
 *
 * @module
 */

import {describe, test, beforeAll, afterAll} from 'vitest';

import type {RouteSpec} from '../http/route_spec.js';
import type {AppServerContext, AppServerOptions} from '../server/app_server.js';
import type {SessionOptions} from '../auth/session_cookie.js';
import {ROLE_ADMIN} from '../auth/role_schema.js';
import {create_test_app, type TestApp, type TestAccount} from './app_server.js';
import {create_pglite_factory, type DbFactory} from './db.js';
import {assert_response_matches_spec} from './integration_helpers.js';
import {resolve_valid_path, generate_valid_body} from './schema_generators.js';
import {run_migrations} from '../db/migrate.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import type {Db} from '../db/db.js';

/** Options for `describe_round_trip_validation`. */
export interface RoundTripTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: Partial<
		Omit<AppServerOptions, 'backend' | 'session_options' | 'create_route_specs'>
	>;
	/** Database factories to run tests against. Default: pglite only. */
	db_factories?: Array<DbFactory>;
	/** Routes to skip, in `'METHOD /path'` format. */
	skip_routes?: Array<string>;
	/** Override generated bodies for specific routes (`'METHOD /path'` → body). */
	input_overrides?: Map<string, Record<string, unknown>>;
}

/**
 * Run schema-driven round-trip validation tests.
 *
 * For each route:
 * 1. Resolve URL with valid params
 * 2. Generate a valid request body (or use override)
 * 3. Pick auth headers matching the route's auth requirement
 * 4. Fire the request and validate the response against declared schemas
 *
 * SSE routes are skipped (Content-Type `text/event-stream`).
 * Routes returning non-2xx with valid input are still validated against
 * their declared error schemas.
 *
 * @param options - round-trip test configuration
 */
export const describe_round_trip_validation = (options: RoundTripTestOptions): void => {
	const skip_set = new Set(options.skip_routes);
	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [AUTH_MIGRATION_NS]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];

	for (const factory of factories) {
		describe(`round-trip validation (${factory.name})`, () => {
			if (factory.skip) return;

			let test_app: TestApp;
			let authed_account: TestAccount;
			let admin_account: TestAccount;
			let db: Db;

			beforeAll(async () => {
				db = await factory.create();
				test_app = await create_test_app({
					session_options: options.session_options,
					create_route_specs: options.create_route_specs,
					db,
					app_options: options.app_options,
				});
				// Create accounts at each auth level
				authed_account = await test_app.create_account({
					username: 'round_trip_authed',
					roles: [],
				});
				admin_account = await test_app.create_account({
					username: 'round_trip_admin',
					roles: [ROLE_ADMIN],
				});
			});

			afterAll(async () => {
				await test_app.cleanup();
				await factory.close(db);
			});

			test('all routes produce schema-valid responses', async () => {
				for (const spec of test_app.route_specs) {
					const route_key = `${spec.method} ${spec.path}`;
					if (skip_set.has(route_key)) continue;

					// Resolve URL with valid param values
					const url = resolve_valid_path(spec.path, spec.params);

					// Generate or override request body
					const override = options.input_overrides?.get(route_key);
					const body = override ?? generate_valid_body(spec.input);

					// Pick auth headers based on route auth requirement
					const headers = pick_auth_headers(spec, test_app, authed_account, admin_account);

					// Fire request
					const request_init: RequestInit = {
						method: spec.method,
						headers: {
							...headers,
							...(body ? {'content-type': 'application/json'} : {}),
						},
						...(body ? {body: JSON.stringify(body)} : {}),
					};

					const res = await test_app.app.request(url, request_init); // eslint-disable-line no-await-in-loop

					// Skip SSE responses — streaming bodies can't be parsed as JSON
					if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
						await res.body?.cancel(); // eslint-disable-line no-await-in-loop
						continue;
					}

					// Validate response against declared schemas
					try {
						await assert_response_matches_spec(test_app.route_specs, spec.method, url, res); // eslint-disable-line no-await-in-loop
					} catch (e) {
						// Re-throw with route context for easier debugging
						throw new Error(
							`Round-trip validation failed for ${route_key} (status ${res.status}): ${(e as Error).message}`,
						);
					}
				}
			});
		});
	}
};

/**
 * Pick auth headers matching a route spec's auth requirement.
 */
const pick_auth_headers = (
	spec: RouteSpec,
	test_app: TestApp,
	authed_account: TestAccount,
	admin_account: TestAccount,
): Record<string, string> => {
	switch (spec.auth.type) {
		case 'none':
			return {host: 'localhost', origin: 'http://localhost:5173'};
		case 'authenticated':
			return authed_account.create_session_headers();
		case 'role':
			if (spec.auth.role === ROLE_ADMIN) {
				return admin_account.create_session_headers();
			}
			// Keeper role uses the bootstrapped account (which has keeper role)
			return test_app.create_session_headers();
		case 'keeper':
			return test_app.create_bearer_headers();
	}
};
