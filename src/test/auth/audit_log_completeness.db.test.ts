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
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_permit_offer_actions} from '$lib/auth/permit_offer_actions.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import type {AppSettings} from '$lib/auth/app_settings_schema.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {db_factories} from '../db_fixture.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

// Action deps shared between the surface actions (stub `app_settings`) and
// the mounted RPC endpoint (captures the per-test `ctx.app_settings`). Audit
// rows land via `audit_log_fire_and_forget` which reads `ctx.db` from the
// transaction — the noop `on_audit_event` here is fine because the test
// verifies audit rows in the DB, not SSE fan-out.
const rpc_deps = {
	log: new Logger('audit-completeness-rpc', {level: 'off'}),
	on_audit_event: () => {},
};

// Surface-only stub. The per-test mounted endpoint builds its own actions
// closed over `ctx.app_settings` so the `app_settings_update` handler mutates
// the ref that signup middleware reads.
const surface_app_settings: AppSettings = {
	open_signup: false,
	updated_at: null,
	updated_by: null,
};

const surface_actions = [
	...create_permit_offer_actions(rpc_deps),
	...create_admin_actions(rpc_deps, {app_settings: surface_app_settings}),
];

describe_audit_completeness_tests({
	session_options,
	db_factories,
	rpc_endpoints: [{path: RPC_PATH, actions: surface_actions}],
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
			...create_rpc_endpoint({
				path: RPC_PATH,
				actions: [
					...create_permit_offer_actions(rpc_deps),
					...create_admin_actions(rpc_deps, {app_settings: ctx.app_settings}),
				],
				log: deps.log,
			}),
		];
	},
});
