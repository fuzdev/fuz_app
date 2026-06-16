/**
 * Integration tests for `role_grant_offer_list`.
 *
 * Covers self-inbox listing, admin cross-account inspection, non-admin
 * cross-account denial, empty inbox shape, and `expires_at` asc
 * ordering. `role_grant_offer_history` is not exercised here (no tests in
 * the original file); add a `.history.db.test.ts` sibling if that
 * surface gains coverage.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.ts';
import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import {
	role_grant_offer_create_action_spec,
	role_grant_offer_list_action_spec,
} from '$lib/auth/role_grant_offer_action_specs.ts';
import {query_role_grant_offer_create} from '$lib/auth/role_grant_offer_queries.ts';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.ts';

describe_db('role_grant_offer_actions.list', (get_db) => {
	describe('role_grant_offer_list', () => {
		test('caller lists own inbox', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'list_recipient'});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_list_action_spec,
				params: {},
				headers: recipient.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.result.offers.length, 1);
			assert.strictEqual(res.result.offers[0]!.to_account_id, recipient.account.id);
		});

		test('non-admin cross-account list is forbidden', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const other = await test_app.create_account({username: 'list_other_recipient'});
			const caller = await test_app.create_account({username: 'list_other_caller'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_list_action_spec,
				params: {account_id: other.account.id},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
		});

		test('admin can list another account with account_id param', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'admin_list_target'});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_list_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.result.offers.length, 1);
		});
	});

	describe('list edge cases', () => {
		test('empty inbox returns {offers: []}', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const recipient = await test_app.create_account({username: 'list_empty_recipient'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_list_action_spec,
				params: {},
				headers: recipient.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.result, {offers: []});
		});

		test('list orders by expires_at asc', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const grantor_b = await test_app.create_account({
				username: 'list_order_grantor_b',
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'list_order_recipient'});
			// Insert two offers directly with controlled expires_at so ordering is deterministic.
			const db = get_db();
			const day_ms = 24 * 60 * 60 * 1000;
			const later = await query_role_grant_offer_create(
				{db},
				{
					from_actor_id: test_app.backend.actor.id,
					to_account_id: recipient.account.id,
					role: ROLE_ADMIN,
					expires_at: new Date(Date.now() + 30 * day_ms),
				},
			);
			const sooner = await query_role_grant_offer_create(
				{db},
				{
					from_actor_id: grantor_b.actor.id,
					to_account_id: recipient.account.id,
					role: ROLE_ADMIN,
					expires_at: new Date(Date.now() + day_ms),
				},
			);
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_list_action_spec,
				params: {},
				headers: recipient.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.deepStrictEqual(
				res.result.offers.map((o) => o.id),
				[sooner.id, later.id],
			);
		});
	});
});
