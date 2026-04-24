/**
 * Integration tests for `permit_offer_list`.
 *
 * Covers self-inbox listing, admin cross-account inspection, non-admin
 * cross-account denial, empty inbox shape, and `expires_at` asc
 * ordering. `permit_offer_history` is not exercised here (no tests in
 * the original file); add a `.history.db.test.ts` sibling if that
 * surface gains coverage.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	permit_offer_create_action_spec,
	permit_offer_list_action_spec,
} from '$lib/auth/permit_offer_action_specs.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';

describe_db('permit_offer_actions.list', (get_db) => {
	describe('permit_offer_list', () => {
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
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_list_action_spec,
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
				spec: permit_offer_list_action_spec,
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
				spec: permit_offer_create_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_list_action_spec,
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
				spec: permit_offer_list_action_spec,
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
			const later = await db.query<{id: string}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')
				 RETURNING id`,
				[test_app.backend.actor.id, recipient.account.id, ROLE_ADMIN],
			);
			const sooner = await db.query<{id: string}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')
				 RETURNING id`,
				[grantor_b.actor.id, recipient.account.id, ROLE_ADMIN],
			);
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_list_action_spec,
				params: {},
				headers: recipient.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.deepStrictEqual(
				res.result.offers.map((o) => o.id),
				[sooner[0]?.id, later[0]?.id],
			);
		});
	});
});
