/**
 * Data exposure audit — verifies sensitive fields never leak through HTTP responses.
 *
 * Tests fuz_app's standard auth route factories against the composable
 * `describe_data_exposure_tests` suite.
 *
 * @module
 */

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { create_admin_actions } from '$lib/auth/admin_actions.ts';
import { create_audit_log_route_specs } from '$lib/auth/audit_log_routes.ts';
import { create_rpc_endpoint } from '$lib/actions/action_rpc.ts';
import { prefix_route_specs, type RouteSpec } from '$lib/http/route_spec.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import { describe_data_exposure_tests } from '$lib/testing/data_exposure.ts';
import { default_in_process_suite_options } from '$lib/testing/cross_backend/in_process_setup.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: null,
			login_account_rate_limiter: null,
			login_fail_floor_ms: 0,
			bootstrap_status: ctx.bootstrap_status
		})
	]),
	...prefix_route_specs('/api/admin', [...create_audit_log_route_specs()]),
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_admin_actions(ctx.deps),
		log: ctx.deps.log
	})
];

describe_data_exposure_tests(
	default_in_process_suite_options({ session_options, create_route_specs })
);
