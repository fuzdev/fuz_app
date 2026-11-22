/**
 * Error-branch RPC integration coverage for `invite_create` / `invite_delete`.
 *
 * `error_schemas.test.ts` asserts the `ERROR_INVITE_*` constants are exported
 * with the right string values, but does not fire them through the dispatcher.
 * These tests round-trip each denial path through a real RPC call against a
 * database-backed admin surface and assert `error.data.reason`.
 *
 * The `invite_create` refusals write no audit row: their probe keys are an
 * email or a username. A delete of a missing invite writes one
 * `outcome: 'failure'` row — its probe key is a UUID — through the pool, so
 * it outlives the rollback of the refused transaction. The cross-backend
 * twin, on both spines, is `cross_backend/invite_audit.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	invite_create_action_spec,
	invite_delete_action_spec
} from '#lib/auth/admin_action_specs.ts';
import {
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_NOT_FOUND
} from '#lib/http/error_schemas.ts';
import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import { create_test_app } from '#lib/testing/test_app.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import { describe_db } from '../auth_db_default.ts';
import {
	RPC_PATH,
	create_admin_route_specs,
	session_cookie_name
} from './admin_rpc_test_helpers.ts';

// Valid v4 UUID that won't collide with any real invite row.
const missing_invite_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as Uuid;

describe_db('invite_actions_failure', (get_db) => {
	install_audit_drift_guard();

	/** Every `invite_*` audit row, oldest first. */
	const read_invite_audit_rows = () =>
		get_db().query<{
			event_type: string;
			outcome: string;
			actor_id: string | null;
			account_id: string | null;
			target_account_id: string | null;
			target_actor_id: string | null;
			metadata: Record<string, unknown> | null;
		}>(
			`SELECT event_type, outcome, actor_id, account_id, target_account_id, target_actor_id, metadata
			 FROM audit_log WHERE event_type LIKE 'invite_%' ORDER BY seq`
		);

	describe('invite_create', () => {
		test('rejects empty input with a validation error', async () => {
			const test_app = await create_test_app({
				session_cookie_name,
				create_route_specs: create_admin_route_specs,
				db: get_db()
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: {},
				headers: test_app.create_session_headers()
			});
			assert.ok(!res.ok, 'Expected 400 for missing identifier');
			assert.strictEqual(res.status, 400);
			const issues = (res.error.data as { issues: Array<{ message: string }> }).issues;
			assert.ok(Array.isArray(issues) && issues.length > 0);
			assert.ok(issues.some((i) => i.message.includes('email or username')));
		});

		test('rejects username colliding with an existing account', async () => {
			const test_app = await create_test_app({
				session_cookie_name,
				create_route_specs: create_admin_route_specs,
				db: get_db()
			});
			const existing_username = test_app.backend.account.username;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: existing_username },
				headers: test_app.create_session_headers()
			});
			assert.ok(!res.ok, 'Expected 409 for existing username');
			assert.strictEqual(res.status, 409);
			assert.strictEqual(
				(res.error.data as { reason: string }).reason,
				ERROR_INVITE_ACCOUNT_EXISTS_USERNAME
			);
		});

		test('rejects email colliding with an existing account', async () => {
			const test_app = await create_test_app({
				session_cookie_name,
				create_route_specs: create_admin_route_specs,
				db: get_db()
			});
			const existing_email = 'existing@example.test';
			await query_create_account_with_actor(
				{ db: test_app.backend.deps.db },
				{
					username: 'account_with_email',
					password_hash: 'stub_hash_irrelevant',
					email: existing_email
				}
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: existing_email },
				headers: test_app.create_session_headers()
			});
			assert.ok(!res.ok, 'Expected 409 for existing email');
			assert.strictEqual(res.status, 409);
			assert.strictEqual(
				(res.error.data as { reason: string }).reason,
				ERROR_INVITE_ACCOUNT_EXISTS_EMAIL
			);
		});

		test('rejects a duplicate unclaimed invite for the same identifier', async () => {
			const test_app = await create_test_app({
				session_cookie_name,
				create_route_specs: create_admin_route_specs,
				db: get_db()
			});
			const invitee_username = 'prospective_user';

			const first = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: invitee_username },
				headers: test_app.create_session_headers()
			});
			assert.ok(first.ok, 'First invite should succeed');

			const second = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: invitee_username },
				headers: test_app.create_session_headers()
			});
			assert.ok(!second.ok, 'Expected 409 for duplicate unclaimed invite');
			assert.strictEqual(second.status, 409);
			assert.strictEqual((second.error.data as { reason: string }).reason, ERROR_INVITE_DUPLICATE);
			// the refusal writes nothing; the first create its success row
			const rows = await read_invite_audit_rows();
			assert.strictEqual(rows.length, 1, JSON.stringify(rows));
			assert.strictEqual(rows[0]!.outcome, 'success');
		});
	});

	describe('invite_delete', () => {
		test('returns 404 `invite_not_found` for a missing invite id', async () => {
			const test_app = await create_test_app({
				session_cookie_name,
				create_route_specs: create_admin_route_specs,
				db: get_db()
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_delete_action_spec,
				params: { invite_id: missing_invite_id },
				headers: test_app.create_session_headers()
			});
			assert.ok(!res.ok, 'Expected 404 for missing invite');
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as { reason: string }).reason, ERROR_INVITE_NOT_FOUND);

			// one failure row, written through the pool: the refusal rolled back
			// the handler's transaction, and the row is still there
			const rows = await read_invite_audit_rows();
			assert.deepStrictEqual(rows, [
				{
					event_type: 'invite_delete',
					outcome: 'failure',
					actor_id: test_app.backend.actor.id,
					account_id: test_app.backend.account.id,
					target_account_id: null,
					target_actor_id: null,
					metadata: { reason: ERROR_INVITE_NOT_FOUND, attempted_invite_id: missing_invite_id }
				}
			]);
		});

		test('a delete and the create before it each write a success row carrying the acting actor', async () => {
			const test_app = await create_test_app({
				session_cookie_name,
				create_route_specs: create_admin_route_specs,
				db: get_db()
			});
			const created = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'invitee@example.test' },
				headers: test_app.create_session_headers()
			});
			assert.ok(created.ok, JSON.stringify(created));
			const invite_id = created.result.invite.id;
			const deleted = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_delete_action_spec,
				params: { invite_id },
				headers: test_app.create_session_headers()
			});
			assert.ok(deleted.ok, JSON.stringify(deleted));

			const acting = {
				outcome: 'success',
				actor_id: test_app.backend.actor.id,
				account_id: test_app.backend.account.id,
				target_account_id: null,
				target_actor_id: null
			};
			assert.deepStrictEqual(await read_invite_audit_rows(), [
				{
					event_type: 'invite_create',
					...acting,
					metadata: { invite_id, email: 'invitee@example.test', username: null }
				},
				{ event_type: 'invite_delete', ...acting, metadata: { invite_id } }
			]);
		});
	});
});
