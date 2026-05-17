/**
 * Integration tests for `role_grant_revoke` — admin-only revocation via the
 * role_grant_offer action surface (spec-level `auth: {account: 'required', actor: 'required', roles: ['admin']}` — the
 * RPC dispatcher rejects non-admin callers before the handler runs).
 *
 * Covers success, non-admin denial, IDOR guard, admin-grant-path
 * denial with failure-outcome audit, 404 on missing role_grant, reason
 * persistence, and sibling-offer supersede in the same transaction as
 * the revoke.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {role_grant_revoke_action_spec} from '$lib/auth/role_grant_offer_action_specs.js';
import {query_create_role_grant} from '$lib/auth/role_grant_queries.js';
import {query_role_grant_offer_create} from '$lib/auth/role_grant_offer_queries.js';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_ROLE_GRANT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
} from '$lib/http/error_schemas.js';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {create_audit_emitter} from '$lib/auth/audit_emitter.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.js';

describe_db('role_grant_offer_actions.revoke', (get_db) => {
	describe('role_grant_revoke', () => {
		test('admin revokes a role_grant and gets {ok, revoked}', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_target_basic'});
			const db = get_db();
			const {id: role_grant_id} = await query_create_role_grant(
				{db},
				{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: {actor_id: target.actor.id, role_grant_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.result, {ok: true, revoked: true});

			const after = await db.query<{revoked_at: string | null}>(
				`SELECT revoked_at FROM role_grant WHERE id = $1`,
				[role_grant_id],
			);
			assert.ok(after[0]?.revoked_at, 'role_grant should be revoked');
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
			const role_grant = await query_create_role_grant(
				{db},
				{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: {actor_id: target.actor.id, role_grant_id: role_grant.id},
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
				`SELECT revoked_at FROM role_grant WHERE id = $1`,
				[role_grant.id],
			);
			assert.strictEqual(after[0]?.revoked_at, null);
		});

		test('cross-actor revoke returns role_grant_not_found (IDOR guard)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_idor_target'});
			const other = await test_app.create_account({username: 'revoke_idor_other'});
			const db = get_db();
			const role_grant = await query_create_role_grant(
				{db},
				{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
			);
			// Pass the other account's actor_id with the real role_grant id —
			// the IDOR guard must treat this as not-found.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: {actor_id: other.actor.id, role_grant_id: role_grant.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_NOT_FOUND,
			);
		});

		test('non-admin-grant-path role (keeper) rejected with role_not_web_grantable + failure audit', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({
						...params,
						on_audit_event: (event) => {
							events.push(event);
						},
					}),
			});
			// bootstrap account holds the keeper role_grant.
			const keeper_rows = await get_db().query<{id: Uuid; actor_id: Uuid}>(
				`SELECT id, actor_id FROM role_grant WHERE role = $1 AND revoked_at IS NULL LIMIT 1`,
				[ROLE_KEEPER],
			);
			const keeper_role_grant = keeper_rows[0]!;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: {actor_id: keeper_role_grant.actor_id, role_grant_id: keeper_role_grant.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_NOT_WEB_GRANTABLE,
			);

			const failure = events.find(
				(e) => e.event_type === 'role_grant_revoke' && e.outcome === 'failure',
			);
			assert.ok(failure, 'expected a failure-outcome role_grant_revoke audit event');
			assert.strictEqual((failure.metadata as {role?: string}).role, ROLE_KEEPER);
		});

		test('nonexistent role_grant returns role_grant_not_found', async () => {
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
				spec: role_grant_revoke_action_spec,
				params: {actor_id: target.actor.id, role_grant_id: create_uuid()},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_NOT_FOUND,
			);
		});

		test('reason persists on role_grant.revoked_reason and audit metadata', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({
						...params,
						on_audit_event: (event) => {
							events.push(event);
						},
					}),
			});
			const target = await test_app.create_account({username: 'revoke_reason_target'});
			const db = get_db();
			const {id: role_grant_id} = await query_create_role_grant(
				{db},
				{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
			);

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: {actor_id: target.actor.id, role_grant_id, reason: 'misuse'},
				headers: test_app.create_session_headers(),
			});

			const after = await db.query<{revoked_reason: string | null}>(
				`SELECT revoked_reason FROM role_grant WHERE id = $1`,
				[role_grant_id],
			);
			assert.strictEqual(after[0]?.revoked_reason, 'misuse');

			const audit = events.find(
				(e) => e.event_type === 'role_grant_revoke' && e.outcome !== 'failure',
			);
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
			const {id: role_grant_id} = await query_create_role_grant(
				{db},
				{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
			);

			const offer = await query_role_grant_offer_create(
				{db},
				{
					from_actor_id: grantor_b.actor.id,
					to_account_id: target.account.id,
					role: ROLE_ADMIN,
					expires_at: new Date(Date.now() + 60 * 60 * 1000),
				},
			);

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: {actor_id: target.actor.id, role_grant_id},
				headers: test_app.create_session_headers(),
			});

			const offer_after = await db.query<{superseded_at: string | null}>(
				`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
				[offer.id],
			);
			assert.ok(offer_after[0]?.superseded_at);
		});
	});
});
