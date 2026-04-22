/**
 * Self-test for `describe_sse_route_tests` against fuz_app's own audit-log SSE.
 *
 * Mirrors how downstream consumers wire the harness: `audit_log_sse: true`
 * auto-creates the registry + guard + broadcaster, and `create_audit_log_route_specs`
 * mounts `/api/admin/audit-log/stream` using them. The trigger revokes all
 * sessions for a second test account — emits `session_revoke_all` on the
 * stream without invalidating the subscribing admin's session. Keeps the
 * SSE self-test orthogonal to the permit work.
 *
 * @module
 */

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_admin_account_route_specs} from '$lib/auth/admin_routes.js';
import {create_audit_log_route_specs} from '$lib/auth/audit_log_routes.js';
import {prefix_route_specs} from '$lib/http/route_spec.js';
import {describe_sse_route_tests} from '$lib/testing/sse_round_trip.js';
import {AUDIT_LOG_EVENT_SPECS} from '$lib/realtime/sse_auth_guard.js';

import {db_factories} from '../db_fixture.js';

const session_options = create_session_config('test_session');

describe_sse_route_tests({
	session_options,
	db_factories,
	app_options: {
		audit_log_sse: true,
		event_specs: AUDIT_LOG_EVENT_SPECS,
	},
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
			...create_admin_account_route_specs(ctx.deps),
			...create_audit_log_route_specs({stream: ctx.audit_sse!}),
		]),
	],
	routes: [
		{
			path: '/api/admin/audit-log/stream',
			event_specs: AUDIT_LOG_EVENT_SPECS,
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
				const res = await test_app.app.request(
					`/api/admin/accounts/${target.account.id}/sessions/revoke-all`,
					{
						method: 'POST',
						headers: {
							...account.create_session_headers(),
							'content-type': 'application/json',
						},
					},
				);
				if (!res.ok) {
					throw new Error(`session_revoke_all trigger failed: ${res.status} ${await res.text()}`);
				}
			},
		},
	],
});
