/**
 * Tests for the composable rate limiting test suite.
 *
 * Exercises `describe_rate_limiting_tests` using fuz_app's own account routes,
 * verifying that the composable suite works end-to-end.
 *
 * @module
 */

import {fuz_session_config} from '$lib/auth/session_cookie.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import {describe_rate_limiting_tests} from '$lib/testing/rate_limiting.js';

/** Route factory using fuz_app's own account routes. */
const test_route_factory = (ctx: AppServerContext): Array<RouteSpec> => [
	create_health_route_spec(),
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options: fuz_session_config,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
		}),
	),
];

describe_rate_limiting_tests({
	session_options: fuz_session_config,
	create_route_specs: test_route_factory,
});
