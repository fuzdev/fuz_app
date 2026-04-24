/**
 * Integration tests for `permit_revoke` — admin-only revocation via the
 * permit_offer action surface (spec-level `auth: {role: 'admin'}` — the
 * RPC dispatcher rejects non-admin callers before the handler runs).
 *
 * Covers success, non-admin denial, IDOR guard, web_grantable denial with
 * failure-outcome audit, 404 on missing permit, reason persistence, and
 * sibling-offer supersede in the same transaction as the revoke.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {permit_revoke_action_spec} from '$lib/auth/permit_offer_action_specs.js';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_PERMIT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
} from '$lib/http/error_schemas.js';
import {create_uuid, type Uuid} from '$lib/uuid.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';

describe_db('permit_offer_actions.revoke', (get_db) => {
	describe('permit_revoke', () => {
		test('admin revokes a permit and gets {ok, revoked}', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_target_basic'});
			const db = get_db();
			const permit_rows = await db.query<{id: Uuid}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			const permit_id = permit_rows[0]!.id;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: target.actor.id, permit_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.result, {ok: true, revoked: true});

			const after = await db.query<{revoked_at: string | null}>(
				`SELECT revoked_at FROM permit WHERE id = $1`,
				[permit_id],
			);
			assert.ok(after[0]?.revoked_at, 'permit should be revoked');
		});

		test('non-admin caller forbidden with insufficient_permissions', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const caller = await test_app.create_account({username: 'revoke_non_admin'});
			const target = await test_app.create_account({username: 'revoke_target_nonadmin'});
			const db = get_db();
			const permit_rows = await db.query<{id: Uuid}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: target.actor.id, permit_id: permit_rows[0]!.id},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_INSUFFICIENT_PERMISSIONS,
			);

			const after = await db.query<{revoked_at: string | null}>(
				`SELECT revoked_at FROM permit WHERE id = $1`,
				[permit_rows[0]!.id],
			);
			assert.strictEqual(after[0]?.revoked_at, null);
		});

		test('cross-actor revoke returns permit_not_found (IDOR guard)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_idor_target'});
			const other = await test_app.create_account({username: 'revoke_idor_other'});
			const db = get_db();
			const permit_rows = await db.query<{id: Uuid}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			// Pass the other account's actor_id with the real permit id —
			// the IDOR guard must treat this as not-found.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: other.actor.id, permit_id: permit_rows[0]!.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_PERMIT_NOT_FOUND,
			);
		});

		test('keeper role rejected with role_not_web_grantable + failure audit', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				on_audit_event: (event) => {
					events.push(event);
				},
			});
			// bootstrap account holds the keeper permit.
			const keeper_rows = await get_db().query<{id: Uuid; actor_id: Uuid}>(
				`SELECT id, actor_id FROM permit WHERE role = $1 AND revoked_at IS NULL LIMIT 1`,
				[ROLE_KEEPER],
			);
			const keeper_permit = keeper_rows[0]!;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: keeper_permit.actor_id, permit_id: keeper_permit.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_NOT_WEB_GRANTABLE,
			);

			const failure = events.find(
				(e) => e.event_type === 'permit_revoke' && e.outcome === 'failure',
			);
			assert.ok(failure, 'expected a failure-outcome permit_revoke audit event');
			assert.strictEqual((failure.metadata as {role?: string}).role, ROLE_KEEPER);
		});

		test('nonexistent permit returns permit_not_found', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_missing_target'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: target.actor.id, permit_id: create_uuid()},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_PERMIT_NOT_FOUND,
			);
		});

		test('reason persists on permit.revoked_reason and audit metadata', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
				on_audit_event: (event) => {
					events.push(event);
				},
			});
			const target = await test_app.create_account({username: 'revoke_reason_target'});
			const db = get_db();
			const permit_rows = await db.query<{id: Uuid}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			const permit_id = permit_rows[0]!.id;

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: target.actor.id, permit_id, reason: 'misuse'},
				headers: test_app.create_session_headers(),
			});

			const after = await db.query<{revoked_reason: string | null}>(
				`SELECT revoked_reason FROM permit WHERE id = $1`,
				[permit_id],
			);
			assert.strictEqual(after[0]?.revoked_reason, 'misuse');

			const audit = events.find((e) => e.event_type === 'permit_revoke' && e.outcome !== 'failure');
			assert.ok(audit);
			assert.strictEqual((audit.metadata as {reason?: string}).reason, 'misuse');
		});

		test('supersedes pending sibling offers in the same transaction', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const grantor_b = await test_app.create_account({
				username: 'revoke_supersede_grantor_b',
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_supersede_target'});
			const db = get_db();
			const permit_rows = await db.query<{id: Uuid}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			const permit_id = permit_rows[0]!.id;

			const offer_rows = await db.query<{id: Uuid}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
				 RETURNING id`,
				[grantor_b.actor.id, target.account.id, ROLE_ADMIN],
			);

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: target.actor.id, permit_id},
				headers: test_app.create_session_headers(),
			});

			const offer_after = await db.query<{superseded_at: string | null}>(
				`SELECT superseded_at FROM permit_offer WHERE id = $1`,
				[offer_rows[0]!.id],
			);
			assert.ok(offer_after[0]?.superseded_at);
		});
	});
});
