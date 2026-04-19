import './assert_dev_env.js';

/**
 * Schema-driven round-trip validation for RPC endpoints.
 *
 * For every RPC method, generates valid params and fires JSON-RPC requests
 * (POST for all methods, GET for reads), validating that responses are
 * well-formed JSON-RPC. Successful responses are validated against the
 * method's declared output schema. DB-backed via `create_test_app`.
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
import {generate_valid_body} from './schema_generators.js';
import {run_migrations} from '../db/migrate.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import type {Db} from '../db/db.js';
import type {RpcEndpointSpec, AppSurfaceRpcMethod} from '../http/surface.js';
import {
	create_rpc_post_init,
	create_rpc_get_url,
	assert_jsonrpc_error_response,
	assert_jsonrpc_success_response,
} from './rpc_helpers.js';

/** Options for `describe_rpc_round_trip_tests`. */
export interface RpcRoundTripTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** RPC endpoint specs — the source `RpcAction` arrays for params generation. */
	rpc_endpoints: Array<RpcEndpointSpec>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: Partial<
		Omit<AppServerOptions, 'backend' | 'session_options' | 'create_route_specs'>
	>;
	/** Database factories to run tests against. Default: pglite only. */
	db_factories?: Array<DbFactory>;
	/** Methods to skip, by name (e.g., `'tx_plan'`). */
	skip_methods?: Array<string>;
	/** Override generated params for specific methods (method name → params). */
	input_overrides?: Map<string, Record<string, unknown>>;
}

/**
 * Pick auth headers matching an RPC method's auth requirement.
 */
const pick_rpc_auth_headers = (
	method: AppSurfaceRpcMethod,
	test_app: TestApp,
	authed_account: TestAccount,
	admin_account: TestAccount,
): Record<string, string> => {
	switch (method.auth.type) {
		case 'none':
			return {host: 'localhost', origin: 'http://localhost:5173'};
		case 'authenticated':
			return authed_account.create_session_headers();
		case 'role':
			if (method.auth.role === ROLE_ADMIN) {
				return admin_account.create_session_headers();
			}
			// keeper role uses the bootstrapped account
			return test_app.create_session_headers();
		case 'keeper':
			return test_app.create_daemon_token_headers();
	}
};

/**
 * Run schema-driven round-trip validation for RPC endpoints.
 *
 * For each method:
 * 1. Generate valid params from the action's input schema
 * 2. Fire a POST request with JSON-RPC envelope
 * 3. For `side_effects: false` methods, also fire a GET request
 * 4. Validate response is well-formed JSON-RPC; successful responses are
 *    also validated against the method's declared output schema
 *
 * Error responses (from missing DB state, etc.) are expected and validated
 * as well-formed JSON-RPC errors. Successful responses are validated against
 * `action.spec.output`.
 *
 * @param options - round-trip test configuration
 */
export const describe_rpc_round_trip_tests = (options: RpcRoundTripTestOptions): void => {
	const skip_set = new Set(options.skip_methods);
	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [AUTH_MIGRATION_NS]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];

	for (const factory of factories) {
		const describe_fn = factory.skip ? describe.skip : describe;
		describe_fn(`RPC round-trip validation (${factory.name})`, () => {
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
					app_options: {
						rpc_endpoints: options.rpc_endpoints,
						...options.app_options,
					},
				});
				authed_account = await test_app.create_account({
					username: 'rpc_round_trip_authed',
					roles: [],
				});
				admin_account = await test_app.create_account({
					username: 'rpc_round_trip_admin',
					roles: [ROLE_ADMIN],
				});
			});

			afterAll(async () => {
				await test_app.cleanup();
				await factory.close(db);
			});

			test('all RPC methods produce valid JSON-RPC responses (POST)', async () => {
				for (const ep_spec of options.rpc_endpoints) {
					const surface_ep = test_app.surface_spec.surface.rpc_endpoints.find(
						(e) => e.path === ep_spec.path,
					);
					if (!surface_ep) continue;

					for (const action of ep_spec.actions) {
						if (skip_set.has(action.spec.method)) continue;

						const surface_method = surface_ep.methods.find((m) => m.name === action.spec.method);
						if (!surface_method) continue;

						// generate or override params
						const override = options.input_overrides?.get(action.spec.method);
						const params = override ?? generate_valid_body(action.spec.input) ?? null;

						// pick auth
						const headers = pick_rpc_auth_headers(
							surface_method,
							test_app,
							authed_account,
							admin_account,
						);

						const init = create_rpc_post_init(action.spec.method, params);
						// merge auth headers into init
						Object.assign(init.headers as Record<string, string>, headers);

						const res = await test_app.app.request(ep_spec.path, init);
						const body = await res.json();

						// validate well-formed JSON-RPC; successful responses also checked against output schema
						try {
							if (res.ok) {
								assert_jsonrpc_success_response(body, action.spec.output);
							} else {
								assert_jsonrpc_error_response(body);
							}
						} catch (e) {
							throw new Error(
								`RPC round-trip POST failed for ${action.spec.method} (status ${res.status}): ${(e as Error).message}`,
							);
						}
					}
				}
			});

			test('all read RPC methods produce valid JSON-RPC responses (GET)', async () => {
				for (const ep_spec of options.rpc_endpoints) {
					const surface_ep = test_app.surface_spec.surface.rpc_endpoints.find(
						(e) => e.path === ep_spec.path,
					);
					if (!surface_ep) continue;

					const read_actions = ep_spec.actions.filter((a) => !a.spec.side_effects);
					for (const action of read_actions) {
						if (skip_set.has(action.spec.method)) continue;

						const surface_method = surface_ep.methods.find((m) => m.name === action.spec.method);
						if (!surface_method) continue;

						const override = options.input_overrides?.get(action.spec.method);
						const params = override ?? generate_valid_body(action.spec.input) ?? undefined;

						const headers = pick_rpc_auth_headers(
							surface_method,
							test_app,
							authed_account,
							admin_account,
						);

						const url = create_rpc_get_url(ep_spec.path, action.spec.method, params);
						const res = await test_app.app.request(url, {headers});
						const body = await res.json();

						try {
							if (res.ok) {
								assert_jsonrpc_success_response(body, action.spec.output);
							} else {
								assert_jsonrpc_error_response(body);
							}
						} catch (e) {
							throw new Error(
								`RPC round-trip GET failed for ${action.spec.method} (status ${res.status}): ${(e as Error).message}`,
							);
						}
					}
				}
			});
		});
	}
};
