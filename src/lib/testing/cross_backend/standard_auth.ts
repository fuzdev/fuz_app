import '../assert_dev_env.ts';

/**
 * The standard auth suites against a spawned backend:
 * `describe_standard_integration_tests`, and
 * `describe_standard_admin_integration_tests` when the consumer supplies a
 * `RoleRegistry`. Every request they send goes through the fixture
 * transports, each test building its own fixture, so fuz_app's transcript
 * differential runs them — the login, session, token and invite verbs each
 * diffed request by request, and the database each test leaves.
 *
 * The rest of the standard suites — the middleware-gate probes, written to a
 * raw socket, and the round trips and data exposure, which build fixtures
 * outside a test — are `describe_standard_cross_tests` (`standard.ts`);
 * `describe_standard_cross_process_tests` (`standard_bundle.ts`) runs both.
 *
 * @module
 */

import type { RoleRegistry } from '../../auth/role_schema.ts';
import type { AppSurfaceSpec } from '../../http/surface.ts';
import { describe_standard_integration_tests } from '../integration.ts';
import { describe_standard_admin_integration_tests } from '../admin_integration.ts';
import type { RpcEndpointsSuiteOption } from '../rpc_helpers.ts';
import type { UncoveredEntry } from '../error_coverage.ts';
import type { BackendCapabilities } from './capabilities.ts';
import type { SetupTest } from './setup.ts';

/** Configuration for `describe_standard_auth_cross_tests`. */
export interface StandardAuthCrossTestOptions {
	/** Per-test fixture-producing function. */
	setup_test: SetupTest;
	/**
	 * App surface. Constructed in TS by the consumer; same shape for
	 * in-process and cross-process tests.
	 */
	surface_source: AppSurfaceSpec;
	/**
	 * Backend capability declarations, read by the integration suite's gated
	 * cases.
	 */
	capabilities: BackendCapabilities;
	/** The session cookie's name — read for the session cookie and the factory-form `rpc_endpoints` resolution. */
	session_cookie_name: string;
	/**
	 * RPC endpoint specs — required. The integration suite drives
	 * `account_verify`, `account_session_*` and `account_token_*` through the
	 * RPC surface, and the admin suite, when wired, the admin and role-grant
	 * verbs.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Role registry from `create_role_registry()`.
	 * When provided, the admin integration suite is included.
	 */
	roles?: RoleRegistry;
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
	/**
	 * Forwarded to `describe_standard_integration_tests` — called with the
	 * declared error paths of its counted routes it never observed.
	 */
	check_uncovered_errors?: (uncovered: Array<UncoveredEntry>) => void;
}

/**
 * Run the standard auth suites against a spawned backend — integration, and
 * admin when `roles` is provided.
 */
export const describe_standard_auth_cross_tests = (options: StandardAuthCrossTestOptions): void => {
	describe_standard_integration_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		capabilities: options.capabilities,
		session_cookie_name: options.session_cookie_name,
		rpc_endpoints: options.rpc_endpoints,
		error_coverage_min: options.error_coverage_min,
		check_uncovered_errors: options.check_uncovered_errors
	});
	if (options.roles) {
		describe_standard_admin_integration_tests({
			setup_test: options.setup_test,
			surface_source: options.surface_source,
			session_cookie_name: options.session_cookie_name,
			roles: options.roles,
			rpc_endpoints: options.rpc_endpoints,
			admin_prefix: options.admin_prefix
		});
	}
};
