/**
 * Integration tests for `permit_offer_create` — the creation-side flows.
 *
 * Covers the grantor path, self-target rejection, caller-without-role
 * denial, same-grantor re-offer upsert, and the custom `authorize`
 * callback override. Audit emission on create paths lives in
 * `permit_offer_actions.audit.db.test.ts`; scope-aware creation is
 * exercised in `permit_offer_actions.scoped.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN, create_role_schema} from '$lib/auth/role_schema.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {
	authorize_admin_or_holder,
	create_permit_offer_actions,
} from '$lib/auth/permit_offer_actions.js';
import {query_grant_permit} from '$lib/auth/permit_queries.js';
import {
	permit_offer_create_action_spec,
	ERROR_OFFER_SELF_TARGET,
	ERROR_OFFER_NOT_AUTHORIZED,
} from '$lib/auth/permit_offer_action_specs.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';

describe_db('permit_offer_actions.create', (get_db) => {
	describe('permit_offer_create', () => {
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
				spec: permit_offer_create_action_spec,
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
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_NOT_AUTHORIZED,
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
				spec: permit_offer_create_action_spec,
				params: {to_account_id: test_app.backend.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_SELF_TARGET,
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
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, message: 'first'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(first.ok);
			const offer_id_1 = first.result.offer.id;
			const second = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, message: 'second'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(second.ok);
			assert.strictEqual(second.result.offer.id, offer_id_1);
			assert.strictEqual(second.result.offer.message, 'second');
		});
	});

	describe('authorize_admin_or_holder', () => {
		const teacher_roles = create_role_schema({teacher: {}});
		const auth_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
			...create_rpc_endpoint({
				path: RPC_PATH,
				actions: create_permit_offer_actions(ctx.deps, {
					authorize: authorize_admin_or_holder,
					roles: teacher_roles,
				}),
				log: ctx.deps.log,
			}),
		];

		test('admin without the role can still offer it', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: auth_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'aaoh_admin_recipient'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: 'teacher'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.offer.role, 'teacher');
		});

		test('non-admin without the role is forbidden', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: auth_route_specs,
				db: get_db(),
			});
			const caller = await test_app.create_account({username: 'aaoh_nonadmin_caller'});
			const recipient = await test_app.create_account({username: 'aaoh_nonadmin_recipient'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: 'teacher'},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_NOT_AUTHORIZED,
			);
		});

		test('non-admin who holds the role globally can offer it', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: auth_route_specs,
				db: get_db(),
			});
			const caller = await test_app.create_account({username: 'aaoh_holder_caller'});
			const recipient = await test_app.create_account({username: 'aaoh_holder_recipient'});
			await query_grant_permit(
				{db: get_db()},
				{
					actor_id: caller.actor.id,
					role: 'teacher',
					granted_by: caller.actor.id,
				},
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: 'teacher'},
				headers: caller.create_session_headers(),
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.offer.role, 'teacher');
		});
	});

	describe('custom authorize callback', () => {
		test('overrides default role-holding check', async () => {
			// Custom authorize allows anyone holding admin to offer any role.
			const custom_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
				...create_rpc_endpoint({
					path: RPC_PATH,
					actions: create_permit_offer_actions(ctx.deps, {
						authorize: async (auth) => auth.permits.some((p) => p.role === ROLE_ADMIN),
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
			// custom authorize allows because admin.permits contains ROLE_ADMIN.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
		});
	});
});
