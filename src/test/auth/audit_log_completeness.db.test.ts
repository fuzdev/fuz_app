/**
 * Audit log completeness tests — wires the composable suite against fuz_app's standard routes.
 *
 * Verifies that every auth mutation route produces the expected audit log event.
 *
 * @module
 */

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_audit_log_route_specs} from '$lib/auth/audit_log_routes.js';
import {create_signup_route_specs} from '$lib/auth/signup_routes.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server_context.js';
import type {RpcEndpointSpec} from '$lib/http/surface.js';
import {describe_audit_completeness_tests} from '$lib/testing/audit_completeness.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import {default_in_process_suite_options} from '$lib/testing/cross_backend/setup.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

// Factory form — create_app_server evaluates this at mount time and
// auto-mounts via create_rpc_endpoint.
const rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
	},
];

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => {
	const {deps} = ctx;
	return [
		...prefix_route_specs('/api/account', [
			...create_account_route_specs(deps, {
				session_options,
				ip_rate_limiter: null,
				login_account_rate_limiter: null,
				login_fail_floor_ms: 0,
			}),
			...create_signup_route_specs(deps, {
				session_options,
				ip_rate_limiter: null,
				signup_account_rate_limiter: null,
			}),
		]),
		...prefix_route_specs('/api/admin', [...create_audit_log_route_specs()]),
	];
};

describe_audit_completeness_tests(
	default_in_process_suite_options({
		session_options,
		create_route_specs,
		rpc_endpoints,
		extra_keeper_roles: [ROLE_ADMIN],
	}),
);
