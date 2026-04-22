import './assert_dev_env.js';

/**
 * Combined standard test suite helper.
 *
 * Convenience wrapper that runs both `describe_standard_integration_tests`
 * and `describe_standard_admin_integration_tests` in a single call.
 * Existing per-suite calls keep working — this is purely additive.
 *
 * @module
 */

import type {SessionOptions} from '../auth/session_cookie.js';
import type {AppServerContext, AppServerOptions} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import type {RoleSchemaResult} from '../auth/role_schema.js';
import type {DbFactory} from './db.js';
import {describe_standard_integration_tests} from './integration.js';
import {describe_standard_admin_integration_tests} from './admin_integration.js';
import type {RpcEndpointSpec} from '../http/surface.js';

/**
 * Configuration for `describe_standard_tests`.
 */
export interface StandardTestOptions {
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
	 * Role schema result from `create_role_schema()`.
	 * When provided, admin integration tests are included — and `rpc_endpoints`
	 * must be provided alongside since admin tests now drive permit
	 * grant/revoke through the RPC surface.
	 */
	roles?: RoleSchemaResult;
	/**
	 * RPC endpoint specs — the source `RpcAction` arrays. Required when
	 * `roles` is set; admin tests hard-fail without an RPC endpoint since
	 * permit grant/revoke are RPC-only.
	 */
	rpc_endpoints?: Array<RpcEndpointSpec>;
	/**
	 * Path prefix where admin routes are mounted.
	 * Default `'/api/admin'`.
	 */
	admin_prefix?: string;
}

/**
 * Run both standard integration and admin integration test suites.
 *
 * Admin tests are only included when `roles` is provided. When `roles` is set
 * but `rpc_endpoints` is not, throws synchronously — the admin suite requires
 * the RPC endpoint for permit grant/revoke coverage.
 *
 * @param options - session config, route factory, and optional role schema + RPC endpoints
 */
export const describe_standard_tests = (options: StandardTestOptions): void => {
	describe_standard_integration_tests(options);
	if (options.roles) {
		if (!options.rpc_endpoints) {
			throw new Error(
				'describe_standard_tests: `rpc_endpoints` is required when `roles` is provided. ' +
					'Admin tests drive permit grant/revoke through the RPC surface — pass the ' +
					'same `rpc_endpoints` array used by `describe_rpc_round_trip_tests`.',
			);
		}
		describe_standard_admin_integration_tests({
			...options,
			roles: options.roles,
			rpc_endpoints: options.rpc_endpoints,
		});
	}
};
