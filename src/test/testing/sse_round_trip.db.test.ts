/**
 * Self-test for `describe_sse_route_tests` against fuz_app's own audit-log SSE.
 *
 * Mirrors how downstream consumers wire the harness: `audit_log_sse: true`
 * auto-creates the registry + guard + broadcaster, and `create_audit_log_route_specs`
 * mounts `/api/admin/audit/stream` using them. The trigger revokes all
 * sessions for a second test account via the `admin_session_revoke_all` RPC
 * — emits `session_revoke_all` on the stream without invalidating the
 * subscribing admin's session. Keeps the SSE self-test orthogonal to the
 * role_grant work.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_audit_log_route_specs} from '$lib/auth/audit_log_routes.js';
import {prefix_route_specs} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RpcEndpointSpec} from '$lib/http/surface.js';
import {describe_sse_route_tests} from '$lib/testing/sse_round_trip.js';
import {audit_log_event_specs} from '$lib/realtime/sse_auth_guard.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {create_account_actions} from '$lib/auth/account_actions.js';
import {admin_session_revoke_all_action_spec} from '$lib/auth/admin_action_specs.js';
import {rpc_call} from '$lib/testing/rpc_helpers.js';

import {db_factories} from '../db_fixture.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';
const rpc_log = new Logger('sse-round-trip-rpc', {level: 'off'});

/** RPC endpoint factory — ctx-bound so the bound `audit` / `app_settings` match each test's real refs. */
const test_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: RPC_PATH,
		actions: [
			...create_admin_actions(
				{log: rpc_log, audit: ctx.deps.audit},
				{app_settings: ctx.app_settings},
			),
			...create_account_actions({
				log: rpc_log,
				audit: ctx.deps.audit,
			}),
		],
	},
];

describe_sse_route_tests({
	session_options,
	db_factories,
	app_options: {
		audit_log_sse: true,
		event_specs: audit_log_event_specs,
	},
	rpc_endpoints: test_rpc_endpoints,
	create_route_specs: (ctx) => [
		...prefix_route_specs('/api/account', [
			...create_account_route_specs(ctx.deps, {
				session_options,
				ip_rate_limiter: null,
				login_account_rate_limiter: null,
				login_fail_floor_ms: 0,
			}),
		]),
		...prefix_route_specs('/api/admin', [
			...create_audit_log_route_specs({stream: ctx.audit_sse!}),
		]),
	],
	routes: [
		{
			path: '/api/admin/audit/stream',
			event_specs: audit_log_event_specs,
			trigger: async ({test_app, account}) => {
				// Revoke all sessions for a fresh account. This fires a
				// `session_revoke_all` audit event with
				// target_account_id = the new account's id — does NOT close the
				// subscribing admin's stream because groups match the target,
				// not the subscriber.
				const target = await test_app.create_account({
					username: 'sse_revoke_target',
					roles: [],
				});
				const res = await rpc_call({
					app: test_app.app,
					path: RPC_PATH,
					method: admin_session_revoke_all_action_spec.method,
					params: {account_id: target.account.id},
					headers: account.create_session_headers(),
				});
				if (!res.ok) {
					throw new Error(`admin_session_revoke_all trigger failed: ${JSON.stringify(res.error)}`);
				}
			},
		},
	],
});
