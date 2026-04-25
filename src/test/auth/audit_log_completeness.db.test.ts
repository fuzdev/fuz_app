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
import {prefix_route_specs} from '$lib/http/route_spec.js';
import {describe_audit_completeness_tests} from '$lib/testing/audit_completeness.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';

import {db_factories} from '../db_fixture.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

describe_audit_completeness_tests({
	session_options,
	db_factories,
	// Factory form lets the `app_settings_update` handler close over the
	// per-test `ctx.app_settings` — create_app_server evaluates this at
	// mount time and auto-mounts via create_rpc_endpoint. Spreading
	// `ctx.deps` (with a noop `on_audit_event` override) keeps any future
	// `AppDeps` field — `audit_log_config`, etc. — flowing into the RPC
	// surface without a per-field allowlist that drifts.
	rpc_endpoints: (ctx) => [
		{
			path: RPC_PATH,
			actions: create_standard_rpc_actions(
				{...ctx.deps, on_audit_event: () => {}},
				{app_settings: ctx.app_settings},
			),
		},
	],
	create_route_specs: (ctx) => {
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
					app_settings: ctx.app_settings,
				}),
			]),
			...prefix_route_specs('/api/admin', [...create_audit_log_route_specs()]),
		];
	},
});
