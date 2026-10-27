/**
 * Integration tests for `role_grant_revoke` — admin-only revocation via the
 * role_grant_offer action surface (spec-level `auth: {account: 'required', actor: 'required', roles: ['admin']}` — the
 * RPC dispatcher rejects non-admin callers before the handler runs).
 *
 * Covers success, non-admin denial, IDOR guard, admin-grant-path
 * denial with failure-outcome audit, 404 on missing role_grant, reason
 * persistence, sibling-offer supersede in the same transaction as
 * the revoke, the revokee's own outgoing offers superseded with it, and the
 * keeper and last-admin guards on a global `admin` grant (counted without the
 * grant being revoked, so a second admin actor on the account still counts).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_test_app } from '#lib/testing/app_server.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import {
	ERROR_CANNOT_REVOKE_KEEPER_ADMIN,
	ERROR_CANNOT_REVOKE_LAST_ADMIN,
	role_grant_revoke_action_spec
} from '#lib/auth/role_grant_offer_action_specs.ts';
import { query_create_role_grant } from '#lib/auth/role_grant_queries.ts';
import { query_create_actor } from '#lib/auth/account_queries.ts';
import { query_role_grant_offer_create } from '#lib/auth/role_grant_offer_queries.ts';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_ROLE_GRANT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE
} from '#lib/http/error_schemas.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';
import type { AuditLogEvent } from '#lib/auth/audit_log_schema.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options
} from './role_grant_offer_test_helpers.ts';

describe_db('role_grant_offer_actions.revoke', (get_db) => {
	describe('role_grant_revoke', () => {
		test('admin revokes a role_grant and gets {ok, revoked}', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const target = await test_app.create_account({ username: 'revoke_target_basic' });
			const db = get_db();
			const { id: role_grant_id } = await query_create_role_grant(
				{ db },
				{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: target.actor.id, role_grant_id },
				headers: test_app.create_session_headers()
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.result, { ok: true, revoked: true });

			const after = await db.query<{ revoked_at: string | null }>(
				`SELECT revoked_at FROM role_grant WHERE id = $1`,
				[role_grant_id]
			);
			assert.ok(after[0]?.revoked_at, 'role_grant should be revoked');
		});

		test('non-admin caller forbidden with insufficient_permissions', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const caller = await test_app.create_account({ username: 'revoke_non_admin' });
			const target = await test_app.create_account({ username: 'revoke_target_nonadmin' });
			const db = get_db();
			const role_grant = await query_create_role_grant(
				{ db },
				{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
			);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: target.actor.id, role_grant_id: role_grant.id },
				headers: caller.create_session_headers()
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as { reason: string } | undefined)?.reason,
				ERROR_INSUFFICIENT_PERMISSIONS
			);

			const after = await db.query<{ revoked_at: string | null }>(
				`SELECT revoked_at FROM role_grant WHERE id = $1`,
				[role_grant.id]
			);
			assert.strictEqual(after[0]?.revoked_at, null);
		});

		test('cross-actor revoke returns role_grant_not_found (IDOR guard)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const target = await test_app.create_account({ username: 'revoke_idor_target' });
			const other = await test_app.create_account({ username: 'revoke_idor_other' });
			const db = get_db();
			const role_grant = await query_create_role_grant(
				{ db },
				{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
			);
			// Pass the other account's actor_id with the real role_grant id —
			// the IDOR guard must treat this as not-found.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: other.actor.id, role_grant_id: role_grant.id },
				headers: test_app.create_session_headers()
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as { reason: string } | undefined)?.reason,
				ERROR_ROLE_GRANT_NOT_FOUND
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
						}
					})
			});
			// bootstrap account holds the keeper role_grant.
			const keeper_rows = await get_db().query<{ id: Uuid; actor_id: Uuid }>(
				`SELECT id, actor_id FROM role_grant WHERE role = $1 AND revoked_at IS NULL LIMIT 1`,
				[ROLE_KEEPER]
			);
			const keeper_role_grant = keeper_rows[0]!;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: keeper_role_grant.actor_id, role_grant_id: keeper_role_grant.id },
				headers: test_app.create_session_headers()
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(
				(res.error.data as { reason: string } | undefined)?.reason,
				ERROR_ROLE_NOT_WEB_GRANTABLE
			);

			const failure = events.find(
				(e) => e.event_type === 'role_grant_revoke' && e.outcome === 'failure'
			);
			assert.ok(failure, 'expected a failure-outcome role_grant_revoke audit event');
			assert.strictEqual((failure.metadata as { role?: string }).role, ROLE_KEEPER);
		});

		test('nonexistent role_grant returns role_grant_not_found', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const target = await test_app.create_account({ username: 'revoke_missing_target' });
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: target.actor.id, role_grant_id: create_uuid() },
				headers: test_app.create_session_headers()
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				(res.error.data as { reason: string } | undefined)?.reason,
				ERROR_ROLE_GRANT_NOT_FOUND
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
						}
					})
			});
			const target = await test_app.create_account({ username: 'revoke_reason_target' });
			const db = get_db();
			const { id: role_grant_id } = await query_create_role_grant(
				{ db },
				{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
			);

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: target.actor.id, role_grant_id, reason: 'misuse' },
				headers: test_app.create_session_headers()
			});

			const after = await db.query<{ revoked_reason: string | null }>(
				`SELECT revoked_reason FROM role_grant WHERE id = $1`,
				[role_grant_id]
			);
			assert.strictEqual(after[0]?.revoked_reason, 'misuse');

			const audit = events.find(
				(e) => e.event_type === 'role_grant_revoke' && e.outcome !== 'failure'
			);
			assert.ok(audit);
			assert.strictEqual((audit.metadata as { reason?: string }).reason, 'misuse');
		});

		test('supersedes pending sibling offers in the same transaction', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const grantor_b = await test_app.create_account({
				username: 'revoke_supersede_grantor_b',
				roles: [ROLE_ADMIN]
			});
			const target = await test_app.create_account({ username: 'revoke_supersede_target' });
			const db = get_db();
			const { id: role_grant_id } = await query_create_role_grant(
				{ db },
				{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
			);

			const offer = await query_role_grant_offer_create(
				{ db },
				{
					from_actor_id: grantor_b.actor.id,
					to_account_id: target.account.id,
					role: ROLE_ADMIN,
					expires_at: new Date(Date.now() + 60 * 60 * 1000)
				}
			);

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: target.actor.id, role_grant_id },
				headers: test_app.create_session_headers()
			});

			const offer_after = await db.query<{ superseded_at: string | null }>(
				`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
				[offer.id]
			);
			assert.ok(offer_after[0]?.superseded_at);
		});

		test("supersedes the revokee's own pending offers, audited, and leaves others'", async () => {
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
						}
					})
			});
			const db = get_db();
			const grantor = await test_app.create_account({
				username: 'revoke_outgoing_grantor',
				roles: [ROLE_ADMIN]
			});
			const recipient_a = await test_app.create_account({ username: 'revoke_outgoing_a' });
			const recipient_b = await test_app.create_account({ username: 'revoke_outgoing_b' });
			const grant = await db.query_one<{ id: Uuid }>(
				`SELECT id FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
				[grantor.actor.id, ROLE_ADMIN]
			);
			assert.ok(grant);
			const offer = (from: Uuid, to: Uuid) =>
				query_role_grant_offer_create(
					{ db },
					{
						from_actor_id: from,
						to_account_id: to,
						role: ROLE_ADMIN,
						expires_at: new Date(Date.now() + 60 * 60 * 1000)
					}
				);
			const outgoing = [
				await offer(grantor.actor.id, recipient_a.account.id),
				await offer(grantor.actor.id, recipient_b.account.id)
			];
			const control = await offer(test_app.backend.actor.id, recipient_a.account.id);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id: grantor.actor.id, role_grant_id: grant.id },
				headers: test_app.create_session_headers()
			});
			assert.ok(res.ok, JSON.stringify(res));

			const superseded_at = async (id: Uuid) =>
				(
					await db.query_one<{ superseded_at: string | null }>(
						`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
						[id]
					)
				)?.superseded_at ?? null;
			for (const o of outgoing) {
				assert.ok(await superseded_at(o.id), 'the revokee offer is superseded');
				const row = events.find(
					(e) =>
						e.event_type === 'role_grant_offer_supersede' &&
						(e.metadata as { offer_id?: string }).offer_id === o.id
				);
				assert.ok(row, 'supersede audited');
				assert.include(row.metadata, { reason: 'role_grant_revoked', cause_id: grant.id });
			}
			assert.strictEqual(await superseded_at(control.id), null, "another grantor's offer stays");
		});

		describe('the global admin grant', () => {
			const revoke = (
				test_app: Awaited<ReturnType<typeof create_test_app>>,
				actor_id: Uuid,
				role_grant_id: Uuid,
				headers: Record<string, string>,
				acting?: Uuid
			) =>
				rpc_call_for_spec({
					app: test_app.app,
					path: RPC_PATH,
					spec: role_grant_revoke_action_spec,
					params: { actor_id, role_grant_id, acting },
					headers
				});
			const admin_grant_of = async (actor_id: Uuid): Promise<Uuid> => {
				const row = await get_db().query_one<{ id: Uuid }>(
					`SELECT id FROM role_grant
					 WHERE actor_id = $1 AND role = $2 AND scope_id IS NULL AND revoked_at IS NULL`,
					[actor_id, ROLE_ADMIN]
				);
				assert.ok(row, 'an active admin grant');
				return row.id;
			};
			const is_active = async (id: Uuid) =>
				(
					await get_db().query_one<{ active: boolean }>(
						`SELECT revoked_at IS NULL AS active FROM role_grant WHERE id = $1`,
						[id]
					)
				)?.active;

			test("the keeper account's admin grant is never revoked", async () => {
				const test_app = await create_test_app({
					session_options,
					create_route_specs,
					db: get_db(),
					roles: [ROLE_KEEPER, ROLE_ADMIN]
				});
				// another admin exists, so only the keeper guard can refuse
				const other = await test_app.create_account({
					username: 'keeper_guard_other_admin',
					roles: [ROLE_ADMIN]
				});
				const keeper_admin = await admin_grant_of(test_app.backend.actor.id);
				for (const headers of [test_app.create_session_headers(), other.create_session_headers()]) {
					const res = await revoke(test_app, test_app.backend.actor.id, keeper_admin, headers);
					assert.ok(!res.ok);
					assert.strictEqual(res.status, 403);
					assert.deepStrictEqual(res.error.data, { reason: ERROR_CANNOT_REVOKE_KEEPER_ADMIN });
				}
				assert.isTrue(await is_active(keeper_admin));
			});

			test("the last active admin's admin grant is not revoked; a second admin lifts the guard", async () => {
				const test_app = await create_test_app({
					session_options,
					create_route_specs,
					db: get_db(),
					roles: [ROLE_ADMIN]
				});
				// the keeper drops out of the count (its grant revoked out of band),
				// leaving one active admin, who tries to revoke their own grant
				const keeper_admin = await admin_grant_of(test_app.backend.actor.id);
				await get_db().query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [
					keeper_admin
				]);
				const sole = await test_app.create_account({
					username: 'last_admin_sole',
					roles: [ROLE_ADMIN]
				});
				const sole_admin = await admin_grant_of(sole.actor.id);
				const refused = await revoke(
					test_app,
					sole.actor.id,
					sole_admin,
					sole.create_session_headers()
				);
				assert.ok(!refused.ok);
				assert.strictEqual(refused.status, 403);
				assert.deepStrictEqual(refused.error.data, { reason: ERROR_CANNOT_REVOKE_LAST_ADMIN });
				assert.isTrue(await is_active(sole_admin));

				await test_app.create_account({ username: 'last_admin_second', roles: [ROLE_ADMIN] });
				const allowed = await revoke(
					test_app,
					sole.actor.id,
					sole_admin,
					sole.create_session_headers()
				);
				assert.ok(allowed.ok, JSON.stringify(allowed));
				assert.isFalse(await is_active(sole_admin));
			});

			// the sole admin account with its admin grant on two actors
			const create_sole_admin_with_two_actors = async () => {
				const test_app = await create_test_app({
					session_options,
					create_route_specs,
					db: get_db(),
					roles: [ROLE_ADMIN]
				});
				const keeper_admin = await admin_grant_of(test_app.backend.actor.id);
				await get_db().query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [
					keeper_admin
				]);
				const sole = await test_app.create_account({
					username: 'two_actor_admin',
					roles: [ROLE_ADMIN]
				});
				const second = await query_create_actor(
					{ db: get_db() },
					sole.account.id,
					'second_persona'
				);
				await query_create_role_grant(
					{ db: get_db() },
					{ actor_id: second.id, role: ROLE_ADMIN, granted_by: sole.actor.id }
				);
				return {
					test_app,
					sole,
					first_admin: await admin_grant_of(sole.actor.id),
					second_id: second.id,
					second_admin: await admin_grant_of(second.id)
				};
			};

			test('a second admin actor on the sole admin account keeps it counted', async () => {
				const { test_app, sole, first_admin, second_id, second_admin } =
					await create_sole_admin_with_two_actors();
				const headers = sole.create_session_headers();

				const allowed = await revoke(test_app, second_id, second_admin, headers, sole.actor.id);
				assert.ok(allowed.ok, JSON.stringify(allowed));
				assert.isFalse(await is_active(second_admin));

				const refused = await revoke(test_app, sole.actor.id, first_admin, headers, sole.actor.id);
				assert.ok(!refused.ok);
				assert.strictEqual(refused.status, 403);
				assert.deepStrictEqual(refused.error.data, { reason: ERROR_CANNOT_REVOKE_LAST_ADMIN });
				assert.isTrue(await is_active(first_admin));
			});

			test("a tombstoned actor's admin grant is revocable while an active admin remains", async () => {
				const { test_app, sole, first_admin, second_id, second_admin } =
					await create_sole_admin_with_two_actors();
				await get_db().query(`UPDATE actor SET deleted_at = NOW() WHERE id = $1`, [second_id]);

				const allowed = await revoke(
					test_app,
					second_id,
					second_admin,
					sole.create_session_headers(),
					sole.actor.id
				);
				assert.ok(allowed.ok, JSON.stringify(allowed));
				assert.isFalse(await is_active(second_admin));
				assert.isTrue(await is_active(first_admin));
			});
		});
	});
});
