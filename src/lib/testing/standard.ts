import './assert_dev_env.ts';

/**
 * Combined standard test suite helper.
 *
 * Bundles every DB-backed suite carrying the standard option shape, each
 * gated on its relevant config — silent-skip when the gate isn't met
 * (same precedent as `describe_standard_admin_integration_tests` skipping
 * when `roles` isn't provided). Consumers wire the standard surface in
 * one call instead of seven; forgetting a suite no longer silently loses
 * coverage.
 *
 * Attack surface suites stay separate — their option shape is
 * `{build, snapshot_path, expected_public_routes, ...}` rather than
 * `{setup_test, surface_source, capabilities}`. A peer bundler lives
 * for that side if/when needed.
 *
 * @module
 */

import type { SessionOptions } from '../auth/session_cookie.ts';
import type { RoleSchemaResult } from '../auth/role_schema.ts';
import type { BootstrapServerOptions } from '../server/app_server.ts';
import type { AppServerContext } from '../server/app_server_context.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import { describe_standard_integration_tests } from './integration.ts';
import { describe_standard_admin_integration_tests } from './admin_integration.ts';
import { describe_round_trip_validation } from './round_trip.ts';
import { describe_data_exposure_tests } from './data_exposure.ts';
import { describe_rpc_round_trip_tests } from './rpc_round_trip.ts';
import { describe_audit_completeness_tests } from './audit_completeness.ts';
import { describe_rate_limiting_tests } from './rate_limiting.ts';
import { describe_bootstrap_success_tests } from './bootstrap_success.ts';
import type { RpcEndpointsSuiteOption } from './rpc_helpers.ts';
import type { BackendCapabilities } from './cross_backend/capabilities.ts';
import type { SetupTest } from './cross_backend/setup.ts';
import type { AppSurfaceSpec } from '../http/surface.ts';
import type { SuiteAppOptions } from './app_server.ts';

/**
 * Configuration for `describe_standard_tests`.
 */
export interface StandardTestOptions {
	/** Per-test fixture-producing function. */
	setup_test: SetupTest;
	/**
	 * App surface. Constructed in TS by the consumer; same shape for
	 * in-process and cross-process tests.
	 */
	surface_source: AppSurfaceSpec;
	/** Backend capability declarations. */
	capabilities: BackendCapabilities;
	/** Session config — needed for cookie_name + factory-form rpc_endpoints resolution. */
	session_options: SessionOptions<string>;
	/**
	 * Route spec factory — same one used in production. Required by
	 * `describe_rate_limiting_tests`, which builds a fresh `TestApp` per test
	 * (bypasses the shared `setup_test` fixture) so it can pass tight
	 * per-test rate-limiter overrides.
	 */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/**
	 * RPC endpoint specs — required. The standard integration tests drive
	 * `account_verify`, `account_session_*`, `account_token_*` through the
	 * RPC surface (and admin tests, when wired, drive role_grant grant/revoke
	 * through it too).
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Role schema result from `create_role_schema()`.
	 * When provided, admin integration + audit completeness suites are included.
	 */
	roles?: RoleSchemaResult;
	/**
	 * Bootstrap config — when set to `mode: 'live'`, the bootstrap success
	 * suite runs against `create_test_app_for_bootstrap`. Other modes
	 * (`'disabled'` / `'surface_only'` / omission) silent-skip the suite.
	 */
	bootstrap?: BootstrapServerOptions;
	/** Optional overrides forwarded to `describe_rate_limiting_tests`. */
	rate_limiting_app_options?: SuiteAppOptions;
	/**
	 * Path prefix where admin routes are mounted.
	 * Default `'/api/admin'`.
	 */
	admin_prefix?: string;
	/**
	 * Forwarded to `describe_standard_integration_tests` — overrides the
	 * default error-coverage threshold on the scoped REST surface. Set to
	 * `0` to skip the assertion entirely.
	 */
	error_coverage_min?: number;
	/** Override the bootstrap-success suite's synthetic token. */
	bootstrap_token?: string;
}

/**
 * Run the full standard test bundle — integration, admin (when `roles`
 * provided), audit completeness (when `roles` provided), bootstrap
 * success (when `bootstrap.mode === 'live'`), round trip, RPC round
 * trip, data exposure, rate limiting.
 */
export const describe_standard_tests = (options: StandardTestOptions): void => {
	describe_standard_integration_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities,
		session_options: options.session_options,
		rpc_endpoints: options.rpc_endpoints,
		error_coverage_min: options.error_coverage_min
	});
	describe_round_trip_validation({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities
	});
	describe_rpc_round_trip_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities,
		session_options: options.session_options,
		rpc_endpoints: options.rpc_endpoints
	});
	describe_data_exposure_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities
	});
	describe_rate_limiting_tests({
		session_options: options.session_options,
		create_route_specs: options.create_route_specs,
		rpc_endpoints: options.rpc_endpoints,
		app_options: options.rate_limiting_app_options
	});
	if (options.roles) {
		describe_standard_admin_integration_tests({
			setup_test: options.setup_test,
			surface_source: options.surface_source,
			capabilities: options.capabilities,
			session_options: options.session_options,
			roles: options.roles,
			rpc_endpoints: options.rpc_endpoints,
			admin_prefix: options.admin_prefix
		});
		describe_audit_completeness_tests({
			setup_test: options.setup_test,
			surface_source: options.surface_source,
			capabilities: options.capabilities,
			session_options: options.session_options,
			rpc_endpoints: options.rpc_endpoints
		});
	}
	if (options.bootstrap?.mode === 'live') {
		describe_bootstrap_success_tests({
			session_options: options.session_options,
			create_route_specs: options.create_route_specs,
			rpc_endpoints: options.rpc_endpoints,
			bootstrap: options.bootstrap,
			bootstrap_token: options.bootstrap_token
		});
	}
};
