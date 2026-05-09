/**
 * Integration tests for `role_grant_offer_decline`.
 *
 * Covers the happy path, IDOR 404 mask, and reason persistence into
 * the `decline_reason` column. Audit emission on decline lives in
 * `role_grant_offer_actions.audit.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	role_grant_offer_create_action_spec,
	role_grant_offer_decline_action_spec,
	ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
} from '$lib/auth/role_grant_offer_action_specs.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.js';

describe_db('role_grant_offer_actions.decline', (get_db) => {
	describe('role_grant_offer_decline', () => {
		test('recipient declines successfully', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'decline_recipient'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_decline_action_spec,
				params: {offer_id, reason: 'no thanks'},
				headers: recipient.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.result, {ok: true});
		});

		test('wrong account returns offer_not_found', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'decline_idor_recipient'});
			const attacker = await test_app.create_account({username: 'decline_idor_attacker'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_decline_action_spec,
				params: {offer_id},
				headers: attacker.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
			);
		});
	});

	describe('decline semantics', () => {
		test('decline reason persists to decline_reason column', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'decline_reason_recipient'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_decline_action_spec,
				params: {offer_id, reason: 'wrong classroom'},
				headers: recipient.create_session_headers(),
			});
			const rows = await get_db().query<{decline_reason: string | null}>(
				`SELECT decline_reason FROM role_grant_offer WHERE id = $1`,
				[offer_id],
			);
			assert.strictEqual(rows[0]?.decline_reason, 'wrong classroom');
		});
	});
});
