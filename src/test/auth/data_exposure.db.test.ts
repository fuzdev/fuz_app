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
import {create_admin_account_route_specs} from '$lib/auth/admin_routes.js';
import {create_invite_route_specs} from '$lib/auth/invite_routes.js';
import {create_app_settings_route_specs} from '$lib/auth/app_settings_routes.js';
import {create_audit_log_route_specs} from '$lib/auth/audit_log_routes.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import {create_test_app_surface_spec} from '$lib/testing/stubs.js';
import {describe_data_exposure_tests} from '$lib/testing/data_exposure.js';

const session_options = create_session_config('test_session');

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	create_account_status_route_spec({bootstrap_status: ctx.bootstrap_status}),
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: null,
			login_account_rate_limiter: null,
		}),
	]),
	...prefix_route_specs('/api/admin', [
		...create_admin_account_route_specs(ctx.deps),
		...create_invite_route_specs(ctx.deps),
		...create_app_settings_route_specs(ctx.deps, {app_settings: ctx.app_settings}),
		...create_audit_log_route_specs(),
	]),
];

describe_data_exposure_tests({
	build: () => create_test_app_surface_spec({session_options, create_route_specs}),
	session_options,
	create_route_specs,
});
