import '../assert_dev_env.js';

/**
 * Cross-process counterpart to `describe_standard_tests`.
 *
 * Wires the cross-process-safe subset of the standard bundle — the five
 * suites whose option shape is `{setup_test, surface_source, capabilities, ...}`
 * and whose bodies fire requests through `fixture.transport` rather than
 * touching the in-process `Backend`. Consumers wire one call against a
 * spawned binary instead of repeating the five sibling calls per file.
 *
 * **Suites included** — always run:
 *
 * - `describe_standard_integration_tests`
 * - `describe_round_trip_validation`
 * - `describe_rpc_round_trip_tests`
 * - `describe_data_exposure_tests`
 *
 * **Gated on `roles`** — included when the consumer supplies a
 * `RoleSchemaResult`:
 *
 * - `describe_standard_admin_integration_tests`
 *
 * **Suites omitted** — the three that don't survive a process boundary,
 * documented here so per-consumer files don't have to repeat the
 * bookkeeping:
 *
 * - `describe_rate_limiting_tests` — builds a fresh `TestApp` per test to
 *   inject tight per-test rate-limiter overrides. That path requires
 *   in-process construction of `Backend` + rate limiter; the spawned
 *   binary has neither knob nor restart-per-test budget.
 * - `describe_audit_completeness_tests` — reaches into FK-structural
 *   introspection that only the in-process backend exposes. Wire-level
 *   audit observability lives in the consumer's own audit `.cross.test.ts`
 *   driving `audit_log_list` / `audit_log_role_grant_history`.
 * - `describe_bootstrap_success_tests` — bootstrap is one-shot per
 *   backend lifecycle, and the consumer's `globalSetup` already consumed
 *   it before the suite file loads. Re-running would 409.
 *
 * @module
 */

import type {SessionOptions} from '../../auth/session_cookie.js';
import type {RoleSchemaResult} from '../../auth/role_schema.js';
import type {AppSurfaceSpec} from '../../http/surface.js';
import {describe_standard_integration_tests} from '../integration.js';
import {describe_standard_admin_integration_tests} from '../admin_integration.js';
import {describe_round_trip_validation} from '../round_trip.js';
import {describe_rpc_round_trip_tests} from '../rpc_round_trip.js';
import {describe_data_exposure_tests} from '../data_exposure.js';
import type {RpcEndpointsSuiteOption} from '../rpc_helpers.js';
import type {BackendCapabilities} from './capabilities.js';
import type {SetupTest} from './setup.js';

/**
 * Configuration for `describe_standard_cross_process_tests`.
 *
 * Mirrors `StandardTestOptions` minus the in-process-only knobs
 * (`create_route_specs`, `bootstrap`, `rate_limiting_app_options`,
 * `bootstrap_token`) — those drive the three omitted suites.
 */
export interface StandardCrossProcessTestOptions {
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
	 * RPC endpoint specs — required. The standard integration tests drive
	 * `account_verify`, `account_session_*`, `account_token_*` through the
	 * RPC surface (and admin tests, when wired, drive role_grant grant/revoke
	 * through it too).
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Role schema result from `create_role_schema()`.
	 * When provided, the admin integration suite is included.
	 */
	roles?: RoleSchemaResult;
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
}

/**
 * Run the cross-process standard test bundle — integration, admin (when
 * `roles` provided), round trip, RPC round trip, data exposure. See the
 * module doc for the suites omitted from this bundle and why.
 */
export const describe_standard_cross_process_tests = (
	options: StandardCrossProcessTestOptions,
): void => {
	describe_standard_integration_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities,
		session_options: options.session_options,
		rpc_endpoints: options.rpc_endpoints,
		error_coverage_min: options.error_coverage_min,
	});
	describe_round_trip_validation({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities,
	});
	describe_rpc_round_trip_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities,
		session_options: options.session_options,
		rpc_endpoints: options.rpc_endpoints,
	});
	describe_data_exposure_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities,
	});
	if (options.roles) {
		describe_standard_admin_integration_tests({
			setup_test: options.setup_test,
			surface_source: options.surface_source,
			capabilities: options.capabilities,
			session_options: options.session_options,
			roles: options.roles,
			rpc_endpoints: options.rpc_endpoints,
			admin_prefix: options.admin_prefix,
		});
	}
};
