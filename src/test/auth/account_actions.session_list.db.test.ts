/**
 * `account_session_list` marks the caller's own session `is_current` — the
 * session its credential hashes to — and none for a bearer caller, which no
 * session authenticated.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_actions } from '#lib/auth/account_actions.ts';
import { account_session_list_action_spec } from '#lib/auth/account_action_specs.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';

import { describe_db } from '../auth_db_default.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_account_actions(ctx.deps),
		log: ctx.deps.log
	});

describe_db('account_actions.session_list', (get_db) => {
	describe('account_session_list is_current', () => {
		test("a session caller's list marks its own session, and only it", async () => {
			const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
			const account = await test_app.create_account({ username: 'session_list_current' });

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_list_action_spec,
				params: undefined,
				headers: account.create_session_headers()
			});
			assert.ok(res.ok, JSON.stringify(res));
			const current = res.result.sessions.filter((s) => s.is_current);
			assert.strictEqual(current.length, 1);
			assert.strictEqual(current[0]!.account_id, account.account.id);
		});

		test("a bearer caller's list marks no session current", async () => {
			const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
			const account = await test_app.create_account({ username: 'session_list_bearer' });

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_list_action_spec,
				params: undefined,
				headers: account.create_bearer_headers(),
				suppress_default_origin: true
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.ok(res.result.sessions.length > 0, 'the account has a session to list');
			assert.isFalse(res.result.sessions.some((s) => s.is_current));
		});
	});
});
