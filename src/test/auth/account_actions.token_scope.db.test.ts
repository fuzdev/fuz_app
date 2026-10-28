/**
 * `account_token_create`'s over-cap scope refusal on the in-process
 * dispatcher: a well-formed scope whose stored document exceeds
 * `MAX_TOKEN_SCOPE_BYTES` passes the input schema and is refused by the
 * handler, with the `ERROR_TOKEN_SCOPE_INVALID` reason `scope` declares for
 * every other refusal — before any write.
 *
 * @module
 */

import { test, assert } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_actions } from '#lib/auth/account_actions.ts';
import {
	ERROR_TOKEN_SCOPE_INVALID,
	account_token_create_action_spec,
	account_token_list_action_spec
} from '#lib/auth/account_action_specs.ts';
import { MAX_TOKEN_SCOPE_BYTES } from '#lib/auth/token_scope.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
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

/** Well-formed method names whose stored scope document overruns the cap. */
const OVER_CAP_METHODS = Array.from(
	{ length: 160 },
	(_, i) => `scope_cap_method_${i}_${'x'.repeat(16)}`
);

describe_db('account_token_create over-cap scope', (get_db) => {
	test('the refusal carries token_scope_invalid and writes no token', async () => {
		assert.ok(
			JSON.stringify(OVER_CAP_METHODS).length > MAX_TOKEN_SCOPE_BYTES,
			'the fixture must overrun the cap'
		);
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const headers = test_app.create_session_headers();
		const before = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_list_action_spec,
			params: undefined,
			headers
		});
		assert.ok(before.ok);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_create_action_spec,
			params: {
				name: 'over-cap',
				scope: { kind: 'methods', methods: OVER_CAP_METHODS },
				lifetime: { kind: 'eternal' }
			},
			headers
		});
		assert.isFalse(res.ok);
		assert.strictEqual(res.status, 400);
		const error = res.error as { code: number; data?: { reason?: string } };
		assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.strictEqual(error.data?.reason, ERROR_TOKEN_SCOPE_INVALID);

		const after = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_token_list_action_spec,
			params: undefined,
			headers
		});
		assert.ok(after.ok);
		assert.deepStrictEqual(after.result, before.result, 'no token was minted');
	});
});
