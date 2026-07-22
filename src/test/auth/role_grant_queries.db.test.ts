/**
 * Tests for backend_role_grant_queries.ts - Role grant create, revoke, and role checks.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { ROLE_KEEPER, ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { query_purge_account } from '$lib/auth/account_queries.ts';
import {
	query_create_role_grant,
	query_revoke_role_grant,
	query_role_grant_find_active_for_actor,
	query_role_grant_has_role,
	query_role_grant_list_for_actor,
	query_role_grant_find_account_id_for_role,
	query_role_grant_revoke_role,
	query_role_grant_revoke_for_scope,
	query_account_has_active_global_role,
	query_count_active_accounts_with_global_role,
	query_account_has_global_role
} from '$lib/auth/role_grant_queries.ts';
import { query_role_grant_offer_create } from '$lib/auth/role_grant_offer_queries.ts';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';
import type { Db } from '$lib/db/db.ts';
import {
	create_test_account_with_actor,
	create_test_extra_actor,
	soft_delete_test_actor
} from '$lib/testing/db_entities.ts';

import { describe_db } from '../db_fixture.ts';

/** Per-test convenience: returns just the ids the assertions care about. */
const create_test_actor = async (
	database: Db,
	username: string
): Promise<{ account_id: Uuid; actor_id: Uuid }> => {
	const { account, actor } = await create_test_account_with_actor(database, { username });
	return { account_id: account.id, actor_id: actor.id };
};

describe_db('RoleGrantQueries', (get_db) => {
	test('grant creates a role_grant', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'alice');
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		assert.ok(role_grant.id);
		assert.strictEqual(role_grant.actor_id, actor_id);
		assert.strictEqual(role_grant.role, ROLE_ADMIN);
		assert.strictEqual(role_grant.revoked_at, null);
		assert.strictEqual(role_grant.granted_by, null);
	});

	test('grant with expiration', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'bob');
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			expires_at: future,
			granted_by: null
		});
		assert.ok(role_grant.expires_at);
	});

	test('grant with granted_by', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id: keeper_id } = await create_test_actor(db, 'keeper');
		const { actor_id: admin_id } = await create_test_actor(db, 'admin');
		const role_grant = await query_create_role_grant(deps, {
			actor_id: admin_id,
			role: ROLE_ADMIN,
			granted_by: keeper_id
		});
		assert.strictEqual(role_grant.granted_by, keeper_id);
	});

	test('has_role returns false for a different role than the one granted', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'dave');
		await query_create_role_grant(deps, { actor_id, role: ROLE_ADMIN, granted_by: null });
		assert.strictEqual(await query_role_grant_has_role(deps, actor_id, ROLE_KEEPER), false);
	});

	test('revoke returns id and role when revoking an active role_grant', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'grace');
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		const result = await query_revoke_role_grant(deps, role_grant.id, actor_id, null);
		assert.strictEqual(result?.id, role_grant.id);
		assert.strictEqual(result?.role, ROLE_ADMIN);
	});

	test('revoke returns null for already revoked role_grant', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'heidi');
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		await query_revoke_role_grant(deps, role_grant.id, actor_id, null);
		assert.strictEqual(await query_revoke_role_grant(deps, role_grant.id, actor_id, null), null);
	});

	test('find_active_for_actor returns only active role_grants', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'ivan');
		await query_create_role_grant(deps, { actor_id, role: ROLE_KEEPER, granted_by: null });
		const revokable = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		await query_revoke_role_grant(deps, revokable.id, actor_id, null);
		const past = new Date(Date.now() - 1000);
		await query_create_role_grant(deps, {
			actor_id,
			role: 'teacher',
			expires_at: past,
			granted_by: null
		});

		const active = await query_role_grant_find_active_for_actor(deps, actor_id);
		assert.strictEqual(active.length, 1);
		assert.strictEqual(active[0]!.role, ROLE_KEEPER);
	});

	test('list_for_actor returns all role_grants including revoked', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'judy');
		await query_create_role_grant(deps, { actor_id, role: ROLE_KEEPER, granted_by: null });
		const revokable = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		await query_revoke_role_grant(deps, revokable.id, actor_id, null);

		const all = await query_role_grant_list_for_actor(deps, actor_id);
		assert.strictEqual(all.length, 2);
	});

	test('revoke_role revokes the active role_grant for a role', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'karen');
		await query_create_role_grant(deps, { actor_id, role: ROLE_ADMIN, granted_by: null });
		await query_create_role_grant(deps, { actor_id, role: ROLE_KEEPER, granted_by: null });

		const result = await query_role_grant_revoke_role(deps, actor_id, ROLE_ADMIN, null);
		assert.strictEqual(result.revoked.length, 1);
		assert.strictEqual(result.revoked[0]?.role, ROLE_ADMIN);
		assert.strictEqual(await query_role_grant_has_role(deps, actor_id, ROLE_ADMIN), false);
		assert.strictEqual(await query_role_grant_has_role(deps, actor_id, ROLE_KEEPER), true);
	});

	test('grant is idempotent — second grant returns existing role_grant', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'dupe_test');
		const first = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		const second = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		assert.strictEqual(first.id, second.id);
	});

	test('idempotent grant preserves original role_grant fields', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id: granter_a } = await create_test_actor(db, 'granter_a');
		const { actor_id: granter_b } = await create_test_actor(db, 'granter_b');
		const { actor_id } = await create_test_actor(db, 'grantee');
		const first = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: granter_a
		});
		const second = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: granter_b
		});
		assert.strictEqual(first.id, second.id);
		assert.strictEqual(second.granted_by, granter_a);
	});

	test('grant allows same role after revocation', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'regranted');
		const first = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		await query_revoke_role_grant(deps, first.id, actor_id, null);
		const second = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		assert.notStrictEqual(first.id, second.id);
		assert.strictEqual(await query_role_grant_has_role(deps, actor_id, ROLE_ADMIN), true);
	});

	test('grant allows different roles for same actor', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'multi_role');
		const keeper = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_KEEPER,
			granted_by: null
		});
		const admin = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		assert.notStrictEqual(keeper.id, admin.id);
		assert.strictEqual(await query_role_grant_has_role(deps, actor_id, ROLE_KEEPER), true);
		assert.strictEqual(await query_role_grant_has_role(deps, actor_id, ROLE_ADMIN), true);
	});

	test('role_grants cascade delete with actor', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id, account_id } = await create_test_actor(db, 'leo');
		await query_create_role_grant(deps, { actor_id, role: ROLE_ADMIN, granted_by: null });

		await query_purge_account(deps, account_id);

		const role_grants = await query_role_grant_list_for_actor(deps, actor_id);
		assert.strictEqual(role_grants.length, 0);
	});

	// -- find_account_id_for_role -------------------------------------------------

	test('find_account_id_for_role returns account_id for active role_grant', async () => {
		const db = get_db();
		const deps = { db };
		const { account_id, actor_id } = await create_test_actor(db, 'farole_active');
		await query_create_role_grant(deps, { actor_id, role: ROLE_ADMIN, granted_by: null });
		const result = await query_role_grant_find_account_id_for_role(deps, ROLE_ADMIN);
		assert.strictEqual(result, account_id);
	});

	test('find_account_id_for_role returns null when no active role_grant', async () => {
		const db = get_db();
		const deps = { db };
		await create_test_actor(db, 'farole_none');
		// no role_grants granted at all — use a role nobody has
		const result = await query_role_grant_find_account_id_for_role(deps, 'nonexistent_role');
		assert.strictEqual(result, null);
	});

	test('find_account_id_for_role returns null for revoked role_grant', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'farole_revoked');
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: 'teacher',
			granted_by: null
		});
		await query_revoke_role_grant(deps, role_grant.id, actor_id, null);
		const result = await query_role_grant_find_account_id_for_role(deps, 'teacher');
		assert.strictEqual(result, null);
	});

	test('find_account_id_for_role returns null for expired role_grant', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'farole_expired');
		const past = new Date(Date.now() - 1000);
		await query_create_role_grant(deps, {
			actor_id,
			role: 'teacher',
			expires_at: past,
			granted_by: null
		});
		const result = await query_role_grant_find_account_id_for_role(deps, 'teacher');
		assert.strictEqual(result, null);
	});

	// -- cartesian: role × state → has_role ---------------------------------------

	const CARTESIAN_ROLES = [ROLE_KEEPER, ROLE_ADMIN, 'teacher'] as const;
	const CARTESIAN_STATES = ['active', 'expired', 'revoked', 'not_granted'] as const;

	for (const role of CARTESIAN_ROLES) {
		for (const state of CARTESIAN_STATES) {
			const expected = state === 'active';
			test(`has_role(${role}, ${state}) → ${String(expected)}`, async () => {
				const db = get_db();
				const deps = { db };
				const username = `cart_${role}_${state}`;
				const { actor_id } = await create_test_actor(db, username);

				if (state === 'active') {
					await query_create_role_grant(deps, { actor_id, role, granted_by: null });
				} else if (state === 'expired') {
					const past = new Date(Date.now() - 1000);
					await query_create_role_grant(deps, {
						actor_id,
						role,
						expires_at: past,
						granted_by: null
					});
				} else if (state === 'revoked') {
					const role_grant = await query_create_role_grant(deps, {
						actor_id,
						role,
						granted_by: null
					});
					await query_revoke_role_grant(deps, role_grant.id, actor_id, null);
				}
				// 'not_granted' — no grant at all

				assert.strictEqual(await query_role_grant_has_role(deps, actor_id, role), expected);
			});
		}
	}

	// -- revoke IDOR guard --------------------------------------------------------

	test('revoke rejects cross-actor revocation (IDOR guard)', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id: actor_a } = await create_test_actor(db, 'idor_actor_a');
		const { actor_id: actor_b } = await create_test_actor(db, 'idor_actor_b');

		const role_grant = await query_create_role_grant(deps, {
			actor_id: actor_a,
			role: ROLE_ADMIN,
			granted_by: null
		});

		// actor B tries to revoke actor A's role_grant
		const result = await query_revoke_role_grant(deps, role_grant.id, actor_b, null);
		assert.strictEqual(result, null);

		// role_grant is still active for actor A
		assert.strictEqual(await query_role_grant_has_role(deps, actor_a, ROLE_ADMIN), true);
	});

	// -- revoke reason + supersede on revoke -----------------------------------

	test('revoke plumbs reason to revoked_reason column', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'revoke_reason');
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		await query_revoke_role_grant(deps, role_grant.id, actor_id, null, 'misconduct');
		const rows = await db.query<{ revoked_reason: string | null }>(
			`SELECT revoked_reason FROM role_grant WHERE id = $1`,
			[role_grant.id]
		);
		assert.strictEqual(rows[0]!.revoked_reason, 'misconduct');
	});

	test('revoke supersedes pending offers for the revoked (actor, role, scope)', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id, account_id } = await create_test_actor(db, 'revoke_supersede_recipient');
		const { actor_id: grantor_actor } = await create_test_actor(db, 'revoke_supersede_grantor');
		const classroom = create_uuid();

		// grant the role_grant we will revoke (scoped)
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});

		// a pending offer for the same (account, role, scope) from a different
		// grantor — the stale-offer bypass vector
		const expires_at = new Date(Date.now() + 60 * 60 * 1000);
		const { id: stale_offer_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: account_id,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: classroom,
				expires_at
			}
		);

		// an unrelated pending offer for a different scope — must NOT be superseded
		const other_classroom = create_uuid();
		const { id: unrelated_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: account_id,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: other_classroom,
				expires_at
			}
		);

		const result = await query_revoke_role_grant(
			deps,
			role_grant.id,
			actor_id,
			null,
			'classroom ended'
		);
		assert.ok(result);
		assert.strictEqual(result.superseded_offers.length, 1);
		assert.strictEqual(result.superseded_offers[0]!.id, stale_offer_id);
		// from_account_id is populated by the CTE join on `actor` — direct
		// guard so a rename or dropped join breaks this test, not just the
		// downstream WS fan-out e2es.
		const grantor_account_rows = await db.query<{ account_id: string }>(
			`SELECT account_id FROM actor WHERE id = $1`,
			[grantor_actor]
		);
		assert.strictEqual(
			result.superseded_offers[0]!.from_account_id,
			grantor_account_rows[0]!.account_id
		);

		// stale offer is terminal on disk
		const stale_rows = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[stale_offer_id]
		);
		assert.ok(stale_rows[0]!.superseded_at);
		// unrelated offer is untouched
		const unrelated_rows = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[unrelated_id]
		);
		assert.strictEqual(unrelated_rows[0]!.superseded_at, null);

		// RevokeRoleGrantResult exposes the revoked role_grant's scope, and the
		// superseded sibling's scope matches — catches any IS NOT DISTINCT FROM
		// vs `=` mismatches on the supersede WHERE clause.
		assert.strictEqual(result.scope_id, classroom);
		assert.strictEqual(result.superseded_offers[0]!.scope_id, classroom);
	});

	test('revoke with no pending offers returns empty superseded_offers', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id } = await create_test_actor(db, 'revoke_no_offers');
		const role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		const result = await query_revoke_role_grant(deps, role_grant.id, actor_id, null);
		assert.ok(result);
		assert.deepStrictEqual(result.superseded_offers, []);
	});

	test('revoke global role_grant does not supersede scoped offers (and vice versa)', async () => {
		// The `scope_id IS NOT DISTINCT FROM $3` clause is load-bearing here —
		// plain `=` would silently drop the NULL-scope case, and the converse
		// (using =-semantics for NULL) would over-match. Direct guard so
		// "simplifying" the SQL breaks this test.
		const db = get_db();
		const deps = { db };
		const { actor_id, account_id } = await create_test_actor(db, 'scope_isolation_actor');
		const { actor_id: grantor_actor } = await create_test_actor(db, 'scope_isolation_grantor');
		const classroom = create_uuid();

		// Global role_grant (scope_id NULL) for role 'teacher'.
		const global_role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: 'teacher',
			granted_by: null
		});
		// A pending SCOPED offer for the same role — must survive revoking the global.
		const { id: scoped_offer_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: account_id,
				role: 'teacher',
				scope_kind: 'classroom',
				scope_id: classroom,
				expires_at: new Date(Date.now() + 60 * 60 * 1000)
			}
		);

		const revoke_global = await query_revoke_role_grant(deps, global_role_grant.id, actor_id, null);
		assert.ok(revoke_global);
		assert.deepStrictEqual(revoke_global.superseded_offers, []);

		const scoped_check = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[scoped_offer_id]
		);
		assert.strictEqual(scoped_check[0]!.superseded_at, null);

		// Converse: revoke a scoped role_grant must not supersede a pending global offer.
		const scoped_role_grant = await query_create_role_grant(deps, {
			actor_id,
			role: 'ta',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});
		const { id: global_offer_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: account_id,
				role: 'ta',
				expires_at: new Date(Date.now() + 60 * 60 * 1000)
			}
		);

		const revoke_scoped = await query_revoke_role_grant(deps, scoped_role_grant.id, actor_id, null);
		assert.ok(revoke_scoped);
		assert.deepStrictEqual(revoke_scoped.superseded_offers, []);

		const global_check = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[global_offer_id]
		);
		assert.strictEqual(global_check[0]!.superseded_at, null);
	});

	test('revoke_role supersedes pending offers across every scope, leaving other roles alone', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id, account_id } = await create_test_actor(db, 'revoke_role_scopes_actor');
		const { actor_id: grantor_actor } = await create_test_actor(db, 'revoke_role_scopes_grantor');
		const classroom_x = create_uuid();
		const classroom_y = create_uuid();

		// Two active scoped student role_grants (one per classroom).
		await query_create_role_grant(deps, {
			actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_x,
			granted_by: null
		});
		await query_create_role_grant(deps, {
			actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_y,
			granted_by: null
		});

		// Pending classroom_student offers in each classroom — these must all
		// be superseded by revoke_role.
		const expires_at = new Date(Date.now() + 60 * 60 * 1000);
		const { id: student_x_offer } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: account_id,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: classroom_x,
				expires_at
			}
		);
		const { id: student_y_offer } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: account_id,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: classroom_y,
				expires_at
			}
		);

		// Distractor: a pending classroom_teacher offer for the same actor/scope.
		// Different role → must be untouched.
		const { id: teacher_offer_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: account_id,
				role: 'classroom_teacher',
				scope_kind: 'classroom',
				scope_id: classroom_x,
				expires_at
			}
		);

		const result = await query_role_grant_revoke_role(deps, actor_id, 'classroom_student', null);
		assert.strictEqual(result.revoked.length, 2);

		// Both classroom_student offers are superseded.
		const student_states = await db.query<{ id: string; superseded_at: string | null }>(
			`SELECT id, superseded_at FROM role_grant_offer WHERE id = ANY($1)`,
			[[student_x_offer, student_y_offer]]
		);
		assert.strictEqual(student_states.length, 2);
		for (const row of student_states) {
			assert.ok(row.superseded_at, `offer ${row.id} should be superseded`);
		}

		// from_account_id is populated for every superseded row via CTE join —
		// direct guard so a broken join fails here before any downstream
		// notification test.
		const grantor_account_rows = await db.query<{ account_id: string }>(
			`SELECT account_id FROM actor WHERE id = $1`,
			[grantor_actor]
		);
		const expected_grantor_account = grantor_account_rows[0]!.account_id;
		assert.strictEqual(result.superseded_offers.length, 2);
		for (const sibling of result.superseded_offers) {
			assert.strictEqual(sibling.from_account_id, expected_grantor_account);
		}

		// The classroom_teacher distractor is untouched.
		const teacher_state = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[teacher_offer_id]
		);
		assert.strictEqual(teacher_state[0]!.superseded_at, null);
	});

	// -- revoke_for_scope (parent-scope cascade) ----------------------------

	test('revoke_for_scope returns empty result when nothing is bound to the scope', async () => {
		const db = get_db();
		const deps = { db };
		const empty_scope = create_uuid();
		const result = await query_role_grant_revoke_for_scope(deps, empty_scope, null);
		assert.deepStrictEqual(result, { revoked: [], superseded_offers: [] });
	});

	test('revoke_for_scope revokes every active role_grant at the scope, role-agnostic', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id: student_a, account_id: student_a_account } = await create_test_actor(
			db,
			'rfs_student_a'
		);
		const { actor_id: student_b, account_id: student_b_account } = await create_test_actor(
			db,
			'rfs_student_b'
		);
		const { actor_id: teacher_actor } = await create_test_actor(db, 'rfs_teacher');
		const classroom = create_uuid();

		// Three role_grants at the scope: two students + one teacher (different roles).
		const role_grant_a = await query_create_role_grant(deps, {
			actor_id: student_a,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});
		const role_grant_b = await query_create_role_grant(deps, {
			actor_id: student_b,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});
		const role_grant_teacher = await query_create_role_grant(deps, {
			actor_id: teacher_actor,
			role: 'classroom_teacher',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});

		// Already-revoked role_grant at the same scope — must not appear in `revoked`.
		const stale = await query_create_role_grant(deps, {
			actor_id: student_a,
			role: 'classroom_observer',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});
		await query_revoke_role_grant(deps, stale.id, student_a, null, 'pre-cascade');

		const result = await query_role_grant_revoke_for_scope(
			deps,
			classroom,
			teacher_actor,
			'classroom destroyed'
		);
		assert.strictEqual(result.revoked.length, 3);

		const by_id = new Map(result.revoked.map((r) => [r.role_grant_id, r]));
		assert.strictEqual(by_id.get(role_grant_a.id)?.role, 'classroom_student');
		assert.strictEqual(by_id.get(role_grant_a.id)?.account_id, student_a_account);
		assert.strictEqual(by_id.get(role_grant_b.id)?.account_id, student_b_account);
		assert.strictEqual(by_id.get(role_grant_teacher.id)?.role, 'classroom_teacher');
		for (const r of result.revoked) {
			assert.strictEqual(r.scope_id, classroom);
		}

		// revoked_by + revoked_reason plumbed onto every freshly-revoked row.
		const rows = await db.query<{
			id: Uuid;
			revoked_by: Uuid | null;
			revoked_reason: string | null;
		}>(`SELECT id, revoked_by, revoked_reason FROM role_grant WHERE id = ANY($1)`, [
			[role_grant_a.id, role_grant_b.id, role_grant_teacher.id]
		]);
		for (const row of rows) {
			assert.strictEqual(row.revoked_by, teacher_actor);
			assert.strictEqual(row.revoked_reason, 'classroom destroyed');
		}

		// Already-revoked role_grant's reason is preserved (not overwritten).
		const stale_rows = await db.query<{ revoked_reason: string | null }>(
			`SELECT revoked_reason FROM role_grant WHERE id = $1`,
			[stale.id]
		);
		assert.strictEqual(stale_rows[0]!.revoked_reason, 'pre-cascade');
	});

	test('revoke_for_scope supersedes tuple-matched and orphan offers, undifferentiated', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id: student_actor, account_id: student_account } = await create_test_actor(
			db,
			'rfs_super_student'
		);
		const { account_id: orphan_account } = await create_test_actor(db, 'rfs_super_orphan');
		const { actor_id: grantor_actor, account_id: grantor_account } = await create_test_actor(
			db,
			'rfs_super_grantor'
		);
		const classroom = create_uuid();

		// Active role_grant + tuple-matched pending offer (the classic stale-offer
		// bypass vector — must become terminal).
		await query_create_role_grant(deps, {
			actor_id: student_actor,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});
		const expires_at = new Date(Date.now() + 60 * 60 * 1000);
		const { id: tuple_matched_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: student_account,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: classroom,
				expires_at
			}
		);

		// Orphan: pending offer at the scope whose recipient has no active
		// role_grant at this (account, role, scope) tuple.
		const { id: orphan_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_actor,
				to_account_id: orphan_account,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: classroom,
				expires_at
			}
		);

		const result = await query_role_grant_revoke_for_scope(deps, classroom, null);
		assert.strictEqual(result.superseded_offers.length, 2);
		const superseded_ids = result.superseded_offers.map((o) => o.id).sort();
		assert.deepStrictEqual(superseded_ids, [tuple_matched_id, orphan_id].sort());
		// Both entries carry from_account_id via the CTE join — guard so a
		// rename / dropped join breaks here, not in WS fan-out e2es.
		for (const offer of result.superseded_offers) {
			assert.strictEqual(offer.from_account_id, grantor_account);
			assert.strictEqual(offer.scope_id, classroom);
			assert.ok(offer.superseded_at);
		}

		// Both rows are terminal on disk.
		const disk = await db.query<{ id: Uuid; superseded_at: string | null }>(
			`SELECT id, superseded_at FROM role_grant_offer WHERE id = ANY($1)`,
			[[tuple_matched_id, orphan_id]]
		);
		for (const row of disk) {
			assert.ok(row.superseded_at);
		}
	});

	test('revoke_for_scope leaves already-terminal offers at the scope untouched', async () => {
		// `superseded_at IS NULL` (and the three sibling guards) gate the
		// supersede UPDATE — direct test so a refactor that drops a guard
		// breaks here before any audit / notification surface drifts.
		const db = get_db();
		const deps = { db };
		const { actor_id: recipient_a, account_id: recipient_a_account } = await create_test_actor(
			db,
			'rfs_term_a'
		);
		const { account_id: recipient_b_account } = await create_test_actor(db, 'rfs_term_b');
		const { account_id: recipient_c_account } = await create_test_actor(db, 'rfs_term_c');
		const { account_id: recipient_d_account } = await create_test_actor(db, 'rfs_term_d');
		const { actor_id: grantor } = await create_test_actor(db, 'rfs_term_grantor');
		const classroom = create_uuid();

		// One offer per terminal kind, all at the same scope.
		const accepted_role_grant = await query_create_role_grant(deps, {
			actor_id: recipient_a,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null
		});
		const accepted = await db.query<{ id: Uuid }>(
			`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, scope_kind, scope_id, expires_at, accepted_at, resulting_role_grant_id)
			 VALUES ($1, $2, 'classroom_student', 'classroom', $3, NOW() + INTERVAL '1 hour', NOW(), $4)
			 RETURNING id`,
			[grantor, recipient_a_account, classroom, accepted_role_grant.id]
		);
		const declined = await db.query<{ id: Uuid }>(
			`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, scope_kind, scope_id, expires_at, declined_at, decline_reason)
			 VALUES ($1, $2, 'classroom_student', 'classroom', $3, NOW() + INTERVAL '1 hour', NOW(), 'no thanks')
			 RETURNING id`,
			[grantor, recipient_b_account, classroom]
		);
		const retracted = await db.query<{ id: Uuid }>(
			`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, scope_kind, scope_id, expires_at, retracted_at)
			 VALUES ($1, $2, 'classroom_student', 'classroom', $3, NOW() + INTERVAL '1 hour', NOW())
			 RETURNING id`,
			[grantor, recipient_c_account, classroom]
		);
		const already_superseded = await db.query<{ id: Uuid }>(
			`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, scope_kind, scope_id, expires_at, superseded_at)
			 VALUES ($1, $2, 'classroom_student', 'classroom', $3, NOW() + INTERVAL '1 hour', NOW())
			 RETURNING id`,
			[grantor, recipient_d_account, classroom]
		);

		const result = await query_role_grant_revoke_for_scope(deps, classroom, null);
		// The accepted role_grant is the only active row at the scope; the four
		// terminal offers are untouched.
		assert.strictEqual(result.revoked.length, 1);
		assert.strictEqual(result.revoked[0]?.role_grant_id, accepted_role_grant.id);
		assert.deepStrictEqual(result.superseded_offers, []);

		// Confirm the terminal columns on each terminal offer are unchanged.
		const accepted_row = await db.query<{ accepted_at: string; superseded_at: string | null }>(
			`SELECT accepted_at, superseded_at FROM role_grant_offer WHERE id = $1`,
			[accepted[0]!.id]
		);
		assert.ok(accepted_row[0]!.accepted_at);
		assert.strictEqual(accepted_row[0]!.superseded_at, null);

		const declined_row = await db.query<{ declined_at: string; superseded_at: string | null }>(
			`SELECT declined_at, superseded_at FROM role_grant_offer WHERE id = $1`,
			[declined[0]!.id]
		);
		assert.ok(declined_row[0]!.declined_at);
		assert.strictEqual(declined_row[0]!.superseded_at, null);

		const retracted_row = await db.query<{ retracted_at: string; superseded_at: string | null }>(
			`SELECT retracted_at, superseded_at FROM role_grant_offer WHERE id = $1`,
			[retracted[0]!.id]
		);
		assert.ok(retracted_row[0]!.retracted_at);
		assert.strictEqual(retracted_row[0]!.superseded_at, null);

		// Already-superseded row's superseded_at timestamp is the original — the
		// idempotency check we care about is "didn't get rewritten by the new
		// cascade", so just confirm the row still has a superseded_at value.
		const already_super_row = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[already_superseded[0]!.id]
		);
		assert.ok(already_super_row[0]!.superseded_at);
	});

	test('revoke_for_scope leaves role_grants and offers at other scopes untouched', async () => {
		const db = get_db();
		const deps = { db };
		const { actor_id: actor, account_id } = await create_test_actor(db, 'rfs_xscope_actor');
		const { actor_id: grantor } = await create_test_actor(db, 'rfs_xscope_grantor');
		const target_scope = create_uuid();
		const sibling_scope = create_uuid();

		// Role grant at the target scope (will be revoked).
		const target_role_grant = await query_create_role_grant(deps, {
			actor_id: actor,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: target_scope,
			granted_by: null
		});
		// Role grant at a sibling scope (must survive).
		const sibling_role_grant = await query_create_role_grant(deps, {
			actor_id: actor,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: sibling_scope,
			granted_by: null
		});
		// Global (NULL-scope) role_grant (must survive — `scope_id = $1` excludes NULL).
		const global_role_grant = await query_create_role_grant(deps, {
			actor_id: actor,
			role: 'teacher',
			granted_by: null
		});

		const expires_at = new Date(Date.now() + 60 * 60 * 1000);
		// Offer at sibling scope.
		const sibling_offer = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor,
				to_account_id: account_id,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: sibling_scope,
				expires_at
			}
		);
		// Global pending offer (NULL scope_id — must survive).
		const global_offer = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor,
				to_account_id: account_id,
				role: 'teacher',
				expires_at
			}
		);

		const result = await query_role_grant_revoke_for_scope(deps, target_scope, null);
		assert.strictEqual(result.revoked.length, 1);
		assert.strictEqual(result.revoked[0]?.role_grant_id, target_role_grant.id);
		assert.deepStrictEqual(result.superseded_offers, []);

		// Sibling-scope role_grant still active.
		assert.strictEqual(
			await query_role_grant_has_role(deps, actor, 'classroom_student', sibling_scope),
			true
		);
		// Global role_grant still active.
		assert.strictEqual(await query_role_grant_has_role(deps, actor, 'teacher'), true);
		// Role grant ids resolved unchanged on disk.
		const sibling_check = await db.query<{ revoked_at: string | null }>(
			`SELECT revoked_at FROM role_grant WHERE id = $1`,
			[sibling_role_grant.id]
		);
		assert.strictEqual(sibling_check[0]!.revoked_at, null);
		const global_check = await db.query<{ revoked_at: string | null }>(
			`SELECT revoked_at FROM role_grant WHERE id = $1`,
			[global_role_grant.id]
		);
		assert.strictEqual(global_check[0]!.revoked_at, null);

		// Sibling-scope offer untouched.
		const sibling_offer_check = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[sibling_offer.id]
		);
		assert.strictEqual(sibling_offer_check[0]!.superseded_at, null);
		// Global offer untouched.
		const global_offer_check = await db.query<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[global_offer.id]
		);
		assert.strictEqual(global_offer_check[0]!.superseded_at, null);
	});

	// A6-sibling: the admin-removability guards and keeper resolution must not
	// count a grant held by a *tombstoned* actor. Soft-delete doesn't revoke
	// role_grant rows (reversible), so an account whose only admin/keeper grant
	// sits on a soft-deleted actor would otherwise still read as one. Twin of the
	// Rust `account_delete.rs` guard tests; latent until per-actor delete ships,
	// seeded directly here.

	test('tombstoned actor admin grant is excluded from the last-admin guards', async () => {
		const db = get_db();
		const deps = { db };

		// Account 1: an active actor holding admin — a usable admin.
		const a1 = await create_test_actor(db, 'usable_admin');
		await query_create_role_grant(deps, {
			actor_id: a1.actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});

		// Account 2: its only admin grant sits on an extra actor we then tombstone.
		const a2 = await create_test_actor(db, 'ghost_admin');
		const a2_extra = (await create_test_extra_actor(db, a2.account_id, 'to_delete')).id;
		await query_create_role_grant(deps, { actor_id: a2_extra, role: ROLE_ADMIN, granted_by: null });
		await soft_delete_test_actor(db, a2_extra);

		// Only account 1 counts; account 2's admin grant is on a tombstone.
		assert.strictEqual(await query_count_active_accounts_with_global_role(deps, ROLE_ADMIN), 1);
		assert.strictEqual(
			await query_account_has_active_global_role(deps, a1.account_id, ROLE_ADMIN),
			true
		);
		assert.strictEqual(
			await query_account_has_active_global_role(deps, a2.account_id, ROLE_ADMIN),
			false
		);

		// Activating account 2's base actor restores a usable admin → count rises to 2.
		await query_create_role_grant(deps, {
			actor_id: a2.actor_id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		assert.strictEqual(await query_count_active_accounts_with_global_role(deps, ROLE_ADMIN), 2);
	});

	test('tombstoned keeper actor is excluded from resolution but not the removability guard', async () => {
		const db = get_db();
		const deps = { db };
		const k = await create_test_actor(db, 'keeper_host');
		const k_extra = (await create_test_extra_actor(db, k.account_id, 'keeper_actor')).id;
		await query_create_role_grant(deps, { actor_id: k_extra, role: ROLE_KEEPER, granted_by: null });
		await soft_delete_test_actor(db, k_extra);

		// Resolution excludes the tombstoned keeper actor → no keeper resolves.
		assert.strictEqual(await query_role_grant_find_account_id_for_role(deps, ROLE_KEEPER), null);
		// The removability guard stays unconditional → still sees the keeper.
		assert.strictEqual(await query_account_has_global_role(deps, k.account_id, ROLE_KEEPER), true);

		// Control: an active keeper actor resolves the keeper account.
		await query_create_role_grant(deps, {
			actor_id: k.actor_id,
			role: ROLE_KEEPER,
			granted_by: null
		});
		assert.strictEqual(
			await query_role_grant_find_account_id_for_role(deps, ROLE_KEEPER),
			k.account_id
		);
	});
});
