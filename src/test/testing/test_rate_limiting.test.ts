/**
 * Tests for the composable rate limiting test suite.
 *
 * Exercises `describe_rate_limiting_tests` using fuz_app's own account routes,
 * verifying that the composable suite works end-to-end.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.ts';

import {fuz_session_config} from '$lib/auth/session_cookie.ts';
import {create_health_route_spec} from '$lib/http/common_routes.ts';
import {create_account_route_specs} from '$lib/auth/account_routes.ts';
import {create_account_actions} from '$lib/auth/account_actions.ts';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import type {RpcEndpointSpec} from '$lib/http/surface.ts';
import {describe_rate_limiting_tests} from '$lib/testing/rate_limiting.ts';
import {default_in_process_suite_options} from '$lib/testing/cross_backend/in_process_setup.ts';

const RPC_PATH = '/api/rpc';
const rpc_log = new Logger('rate-limiting-rpc', {level: 'off'});

/** Route factory using fuz_app's own account routes. */
const test_route_factory = (ctx: AppServerContext): Array<RouteSpec> => [
	create_health_route_spec(),
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options: fuz_session_config,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			login_fail_floor_ms: 0,
		}),
	),
];

/** RPC endpoint factory — ctx-bound so the bound `audit` matches each test's real backend. */
const test_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: RPC_PATH,
		actions: create_account_actions({
			log: rpc_log,
			audit: ctx.deps.audit,
		}),
	},
];

describe_rate_limiting_tests(
	default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs: test_route_factory,
		rpc_endpoints: test_rpc_endpoints,
	}),
);
