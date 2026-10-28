/**
 * `account_delete`'s self path is **session-only**, handler-enforced.
 *
 * The spec declares no `credential_types` — an admin deleting another account
 * keeps any credential — so the handler checks the channel when the target is
 * the caller's own account, and refuses an API or daemon token with the
 * dispatcher's own 403 `credential_type_required` body, ahead of the keeper /
 * last-admin guards. See `docs/security.md` §Credential-channel gating.
 *
 * @module
 */

import { test, assert } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import {
	account_delete_action_spec,
	ERROR_CANNOT_DELETE_KEEPER
} from '#lib/auth/admin_action_specs.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { credential_type_required_error } from '#lib/actions/perform_action.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { query_account_by_id } from '#lib/auth/account_queries.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { describe_db } from '../auth_db_default.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
		log: ctx.deps.log
	});

const SESSION_ONLY_REFUSAL = credential_type_required_error(['session']);

const assert_session_only_refusal = (res: {
	ok: boolean;
	status: number;
	error?: unknown;
}): void => {
	assert.strictEqual(res.ok, false, 'expected the self-delete to be refused');
	assert.strictEqual(res.status, 403);
	assert.deepStrictEqual(res.error, SESSION_ONLY_REFUSAL);
};

describe_db('account_delete self path is session-only', (get_db) => {
	install_audit_drift_guard();

	test('self via session → deleted', async () => {
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const member = await test_app.create_account({ username: 'self_session' });
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: member.create_session_headers()
		});
		assert.ok(res.ok, JSON.stringify(res));
		assert.strictEqual(res.result.deleted, true);
	});

	test('self via session naming the own id uppercased → deleted, not an elevation refusal', async () => {
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const member = await test_app.create_account({ username: 'self_session_upper' });
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: { account_id: member.account.id.toUpperCase() as Uuid },
			headers: member.create_session_headers()
		});
		assert.ok(res.ok, JSON.stringify(res));
		assert.strictEqual(res.result.deleted, true);
	});

	test('self via api token → 403 credential_type_required, account survives', async () => {
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const member = await test_app.create_account({ username: 'self_bearer' });
		for (const params of [
			{},
			{ account_id: member.account.id },
			{ account_id: member.account.id.toUpperCase() as Uuid }
		]) {
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_delete_action_spec,
				params,
				headers: member.create_bearer_headers(),
				suppress_default_origin: true
			});
			assert_session_only_refusal(res);
		}
		const still = await query_account_by_id({ db: test_app.backend.deps.db }, member.account.id);
		assert.ok(still, 'the account survives the refused self-deletes');
	});

	test('self via daemon token → 403 credential_type_required, ahead of the keeper guard', async () => {
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: test_app.create_daemon_token_headers(),
			suppress_default_origin: true
		});
		assert_session_only_refusal(res);
	});

	test('a keeper self-deleting via api token gets credential_type_required, not cannot_delete_keeper', async () => {
		const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
		const by_bearer = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: test_app.create_bearer_headers(),
			suppress_default_origin: true
		});
		assert_session_only_refusal(by_bearer);
		// Over a session the keeper guard answers.
		const by_session = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: test_app.create_session_headers()
		});
		assert.ok(!by_session.ok, 'a keeper must not self-delete');
		assert.strictEqual(
			(by_session.error.data as { reason?: string } | undefined)?.reason,
			ERROR_CANNOT_DELETE_KEEPER
		);
	});

	test('an admin naming their own id uppercased over an api token is still self → refused', async () => {
		// another admin (the keeper) is present, so the last-admin guard can't
		// stand in for the credential check
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
			roles: [ROLE_KEEPER, ROLE_ADMIN]
		});
		const admin = await test_app.create_account({ username: 'upper_admin', roles: [ROLE_ADMIN] });
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: { account_id: admin.account.id.toUpperCase() as Uuid },
			headers: admin.create_bearer_headers(),
			suppress_default_origin: true
		});
		assert_session_only_refusal(res);
		const still = await query_account_by_id({ db: test_app.backend.deps.db }, admin.account.id);
		assert.ok(still, 'the account survives');
	});

	test('an admin deleting another account via api or daemon token → deleted', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
			roles: [ROLE_KEEPER, ROLE_ADMIN]
		});
		for (const [username, headers] of [
			['other_by_bearer', test_app.create_bearer_headers()],
			['other_by_daemon', test_app.create_daemon_token_headers()]
		] as const) {
			const victim = await test_app.create_account({ username });
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_delete_action_spec,
				params: { account_id: victim.account.id },
				headers,
				suppress_default_origin: true
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.deleted, true);
		}
	});
});
