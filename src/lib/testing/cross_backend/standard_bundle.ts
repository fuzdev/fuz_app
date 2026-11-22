import '../assert_dev_env.ts';

/**
 * One call wiring the standard suites that run against a spawned backend —
 * the ones whose option shape is `{setup_test, surface_source, capabilities, ...}`
 * and whose bodies fire requests through `fixture.transport` rather than
 * touching the in-process `Backend`, for a consumer wiring them outside
 * `describe_spine_cross_suites`, which registers the two halves apart:
 *
 * - `describe_standard_auth_cross_tests` (`standard_auth.ts`) —
 *   `describe_standard_integration_tests`, and
 *   `describe_standard_admin_integration_tests` when the consumer supplies a
 *   `RoleRegistry`
 * - `describe_standard_cross_tests` (`standard.ts`) —
 *   `describe_middleware_gate_tests`, `describe_round_trip_validation`,
 *   `describe_rpc_round_trip_tests` and `describe_data_exposure_tests`
 *
 * **Suites omitted** — the ones that don't survive a process boundary,
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
 *
 * @module
 */

import { describe_standard_cross_tests, type StandardCrossTestOptions } from './standard.ts';
import {
	describe_standard_auth_cross_tests,
	type StandardAuthCrossTestOptions
} from './standard_auth.ts';

/**
 * Configuration for `describe_standard_cross_process_tests`: both halves'
 * options — the in-process suites' shared options minus their
 * in-process-only knobs (`create_route_specs`, `rate_limiting_app_options`).
 */
export interface StandardCrossProcessTestOptions
	extends StandardAuthCrossTestOptions, StandardCrossTestOptions {}

/**
 * Run the cross-process standard test bundle — the auth suites (integration,
 * admin when `roles` is provided), then the middleware-gate probes, round
 * trip, RPC round trip and data exposure. See the module doc for the suites
 * omitted and why.
 */
export const describe_standard_cross_process_tests = (
	options: StandardCrossProcessTestOptions
): void => {
	describe_standard_auth_cross_tests(options);
	describe_standard_cross_tests(options);
};
