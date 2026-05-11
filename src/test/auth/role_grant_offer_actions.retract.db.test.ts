/**
 * Integration tests for `role_grant_offer_retract`.
 *
 * Covers the grantor happy path and the non-grantor IDOR 404 mask.
 * Audit emission on retract lives in
 * `role_grant_offer_actions.audit.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	role_grant_offer_create_action_spec,
	role_grant_offer_retract_action_spec,
	ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
} from '$lib/auth/role_grant_offer_action_specs.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.js';

describe_db('role_grant_offer_actions.retract', (get_db) => {
	describe('role_grant_offer_retract', () => {
		test('grantor retracts successfully', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'retract_recipient'});
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
				spec: role_grant_offer_retract_action_spec,
				params: {offer_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.result, {ok: true});
		});

		test('non-grantor retract attempt returns offer_not_found', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'retract_other_recipient'});
			const other = await test_app.create_account({
				username: 'retract_other_actor',
				roles: [ROLE_ADMIN],
			});
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
				spec: role_grant_offer_retract_action_spec,
				params: {offer_id},
				headers: other.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
			);
		});
	});
});
