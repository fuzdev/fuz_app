/**
 * Data exposure audit — verifies sensitive fields never leak through HTTP responses.
 *
 * Tests fuz_app's standard auth route factories against the composable
 * `describe_data_exposure_tests` suite.
 *
 * @module
 */

import {create_session_config} from '$lib/auth/session_cookie.js';
import {
	create_account_status_route_spec,
	create_account_route_specs,
} from '$lib/auth/account_routes.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {create_audit_log_route_specs} from '$lib/auth/audit_log_routes.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import {describe_data_exposure_tests} from '$lib/testing/data_exposure.js';
import {default_in_process_suite_options} from '$lib/testing/cross_backend/setup.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	create_account_status_route_spec({bootstrap_status: ctx.bootstrap_status}),
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: null,
			login_account_rate_limiter: null,
			login_fail_floor_ms: 0,
		}),
	]),
	...prefix_route_specs('/api/admin', [...create_audit_log_route_specs()]),
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_admin_actions(ctx.deps),
		log: ctx.deps.log,
	}),
];

describe_data_exposure_tests(
	default_in_process_suite_options({session_options, create_route_specs}),
);
