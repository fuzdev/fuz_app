/**
 * Audit log completeness tests — wires the composable suite against fuz_app's standard routes.
 *
 * Verifies that every auth mutation route produces the expected audit log event.
 *
 * @module
 */

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_admin_account_route_specs} from '$lib/auth/admin_routes.js';
import {create_invite_route_specs} from '$lib/auth/invite_routes.js';
import {create_app_settings_route_specs} from '$lib/auth/app_settings_routes.js';
import {create_audit_log_route_specs} from '$lib/auth/audit_log_routes.js';
import {create_signup_route_specs} from '$lib/auth/signup_routes.js';
import {prefix_route_specs} from '$lib/http/route_spec.js';
import {describe_audit_completeness_tests} from '$lib/testing/audit_completeness.js';

import {db_factories} from '../db_fixture.js';

const session_options = create_session_config('test_session');

describe_audit_completeness_tests({
	session_options,
	db_factories,
	create_route_specs: (ctx) => {
		const {deps} = ctx;
		return [
			...prefix_route_specs('/api/account', [
				...create_account_route_specs(deps, {
					session_options,
					ip_rate_limiter: null,
					login_account_rate_limiter: null,
				}),
				...create_signup_route_specs(deps, {
					session_options,
					ip_rate_limiter: null,
					signup_account_rate_limiter: null,
					app_settings: ctx.app_settings,
				}),
			]),
			...prefix_route_specs('/api/admin', [
				...create_admin_account_route_specs(deps),
				...create_invite_route_specs(deps),
				...create_app_settings_route_specs(deps, {app_settings: ctx.app_settings}),
				...create_audit_log_route_specs(),
			]),
		];
	},
});
