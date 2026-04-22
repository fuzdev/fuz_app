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
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_permit_offer_actions} from '$lib/auth/permit_offer_actions.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {db_factories} from '../db_fixture.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

// Actions are built once and shared between the surface (`rpc_endpoints`)
// and the mounted RPC endpoint. The closures capture this silent logger; at
// runtime `ctx.deps.db` / `ctx.auth` flow through the RPC dispatcher.
// Audit rows land via `audit_log_fire_and_forget` which reads
// `ctx.db` from the transaction — the null `on_audit_event` here is fine
// because the test verifies audit rows in the DB, not SSE fan-out.
const rpc_deps = {
	log: new Logger('audit-completeness-rpc', {level: 'off'}),
	on_audit_event: () => {},
};
const rpc_actions = [...create_permit_offer_actions(rpc_deps), ...create_admin_actions(rpc_deps)];

describe_audit_completeness_tests({
	session_options,
	db_factories,
	rpc_endpoints: [{path: RPC_PATH, actions: rpc_actions}],
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
			...prefix_route_specs('/api/admin', [
				...create_admin_account_route_specs(deps),
				...create_invite_route_specs(deps),
				...create_app_settings_route_specs(deps, {app_settings: ctx.app_settings}),
				...create_audit_log_route_specs(),
			]),
			...create_rpc_endpoint({
				path: RPC_PATH,
				actions: rpc_actions,
				log: deps.log,
			}),
		];
	},
});
