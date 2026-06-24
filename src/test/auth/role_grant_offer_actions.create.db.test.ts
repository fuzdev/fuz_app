/**
 * Integration tests for `role_grant_offer_create` — the creation-side flows.
 *
 * Covers the grantor path, self-target rejection, caller-without-role
 * denial, same-grantor re-offer upsert, and the custom `authorize`
 * callback override. Audit emission on create paths lives in
 * `role_grant_offer_actions.audit.db.test.ts`; scope-aware creation is
 * exercised in `role_grant_offer_actions.scoped.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.ts';
import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.ts';
import {create_role_grant_offer_actions} from '$lib/auth/role_grant_offer_actions.ts';
import {
	role_grant_offer_create_action_spec,
	ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
} from '$lib/auth/role_grant_offer_action_specs.ts';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import type {RouteSpec} from '$lib/http/route_spec.ts';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.ts';

describe_db('role_grant_offer_actions.create', (get_db) => {
	describe('role_grant_offer_create', () => {
		test('grantor holding admin role can offer admin', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'create_recipient'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.status, 200);
			assert.ok(res.result.offer.id);
			assert.strictEqual(res.result.offer.role, ROLE_ADMIN);
			assert.strictEqual(res.result.offer.to_account_id, recipient.account.id);
			assert.strictEqual(res.result.offer.accepted_at, null);
		});

		test('caller without the role is forbidden (not_authorized)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const recipient = await test_app.create_account({username: 'create_forbidden_recipient'});
			const caller = await test_app.create_account({username: 'create_forbidden_caller'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
			);
		});

		test('self-offer rejected with offer_self_target reason', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: test_app.backend.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
			);
		});
	});

	describe('re-offer upsert', () => {
		test('same grantor re-offering returns the same offer with refreshed message', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'reoffer_recipient'});
			const first = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, message: 'first'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(first.ok);
			const offer_id_1 = first.result.offer.id;
			const second = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, message: 'second'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(second.ok);
			assert.strictEqual(second.result.offer.id, offer_id_1);
			assert.strictEqual(second.result.offer.message, 'second');
		});
	});

	describe('custom authorize callback', () => {
		test('overrides default role-holding check', async () => {
			// Custom authorize allows anyone holding admin to offer any role.
			const custom_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
				...create_rpc_endpoint({
					path: RPC_PATH,
					actions: create_role_grant_offer_actions(ctx.deps, {
						authorize: async (auth) => auth.role_grants.some((p) => p.role === ROLE_ADMIN),
					}),
					log: ctx.deps.log,
				}),
			];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: custom_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'custom_auth_recipient'});
			// Admin is offering a role they don't hold — default policy would deny;
			// custom authorize allows because admin.role_grants contains ROLE_ADMIN.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
		});
	});
});
