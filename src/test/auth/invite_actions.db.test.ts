/**
 * Error-branch RPC integration coverage for `invite_create` / `invite_delete`.
 *
 * `error_schemas.test.ts` asserts the `ERROR_INVITE_*` constants are exported
 * with the right string values, but does not fire them through the dispatcher.
 * These tests round-trip each denial path through a real RPC call against a
 * PGlite-backed admin surface and assert `error.data.reason`.
 *
 * Unlike `admin_actions.failure_audit.db.test.ts`, the invite handlers do not
 * emit `outcome: 'failure'` audit rows on denial paths — so only the JSON-RPC
 * error envelope is asserted here.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	invite_create_action_spec,
	invite_delete_action_spec,
} from '$lib/auth/admin_action_specs.ts';
import {
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_NOT_FOUND,
} from '$lib/http/error_schemas.ts';
import {query_create_account_with_actor} from '$lib/auth/account_queries.ts';
import {create_test_app} from '$lib/testing/app_server.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import {
	RPC_PATH,
	create_admin_route_specs,
	describe_db,
	session_options,
} from './admin_rpc_test_helpers.ts';

// Valid v4 UUID that won't collide with any real invite row.
const missing_invite_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as Uuid;

describe_db('invite_actions_failure', (get_db) => {
	describe('invite_create', () => {
		test('rejects empty input with Zod validation error', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: {},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 400 for missing identifier');
			assert.strictEqual(res.status, 400);
			const issues = (res.error.data as {issues: Array<{message: string}>}).issues;
			assert.ok(Array.isArray(issues) && issues.length > 0);
			assert.ok(issues.some((i) => i.message.includes('email or username')));
		});

		test('rejects username colliding with an existing account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const existing_username = test_app.backend.account.username;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: {username: existing_username},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 409 for existing username');
			assert.strictEqual(res.status, 409);
			assert.strictEqual(
				(res.error.data as {reason: string}).reason,
				ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
			);
		});

		test('rejects email colliding with an existing account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const existing_email = 'existing@example.test';
			await query_create_account_with_actor(
				{db: test_app.backend.deps.db},
				{
					username: 'account_with_email',
					password_hash: 'stub_hash_irrelevant',
					email: existing_email,
				},
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: {email: existing_email},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 409 for existing email');
			assert.strictEqual(res.status, 409);
			assert.strictEqual(
				(res.error.data as {reason: string}).reason,
				ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
			);
		});

		test('rejects a duplicate unclaimed invite for the same identifier', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const invitee_username = 'prospective_user';

			const first = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: {username: invitee_username},
				headers: test_app.create_session_headers(),
			});
			assert.ok(first.ok, 'First invite should succeed');

			const second = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: {username: invitee_username},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!second.ok, 'Expected 409 for duplicate unclaimed invite');
			assert.strictEqual(second.status, 409);
			assert.strictEqual((second.error.data as {reason: string}).reason, ERROR_INVITE_DUPLICATE);
		});
	});

	describe('invite_delete', () => {
		test('returns 404 `invite_not_found` for a missing invite id', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_delete_action_spec,
				params: {invite_id: missing_invite_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 404 for missing invite');
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as {reason: string}).reason, ERROR_INVITE_NOT_FOUND);
		});
	});
});
