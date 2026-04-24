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
import type {RpcEndpointsSuiteOption} from './rpc_helpers.js';

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
	 * When provided, admin integration tests are included.
	 */
	roles?: RoleSchemaResult;
	/**
	 * RPC endpoint specs — required. The standard integration tests drive
	 * `account_verify`, `account_session_*`, `account_token_*` through the
	 * RPC surface (and admin tests, when wired, drive permit grant/revoke
	 * through it too).
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>`. Round-tripped
	 * to both sub-suites unchanged — see their docstrings for the full
	 * factory-form contract.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Path prefix where admin routes are mounted.
	 * Default `'/api/admin'`.
	 */
	admin_prefix?: string;
}

/**
 * Run both standard integration and admin integration test suites.
 *
 * Admin tests are only included when `roles` is provided.
 *
 * @param options - session config, route factory, RPC endpoints, and optional role schema
 */
export const describe_standard_tests = (options: StandardTestOptions): void => {
	describe_standard_integration_tests(options);
	if (options.roles) {
		describe_standard_admin_integration_tests({
			...options,
			roles: options.roles,
			rpc_endpoints: options.rpc_endpoints,
		});
	}
};
