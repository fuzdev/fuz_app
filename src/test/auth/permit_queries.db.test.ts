/**
 * Tests for backend_permit_queries.ts - Permit grant, revoke, and role checks.
 *
 * @module
 */

import {assert, test} from 'vitest';

import {ROLE_KEEPER, ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {query_create_account_with_actor, query_delete_account} from '$lib/auth/account_queries.js';
import {
	query_grant_permit,
	query_revoke_permit,
	query_permit_find_active_for_actor,
	query_permit_has_role,
	query_permit_list_for_actor,
	query_permit_find_account_id_for_role,
	query_permit_revoke_role,
} from '$lib/auth/permit_queries.js';
import {create_uuid} from '$lib/uuid.js';
import type {Db} from '$lib/db/db.js';

import {describe_db} from '../db_fixture.js';

/** Helper to create a test account+actor and return the actor_id. */
const create_test_actor = async (
	database: Db,
	username: string,
): Promise<{account_id: string; actor_id: string}> => {
	const deps = {db: database};
	const {account, actor} = await query_create_account_with_actor(deps, {
		username,
		password_hash: 'hash',
	});
	return {account_id: account.id, actor_id: actor.id};
};

describe_db('PermitQueries', (get_db) => {
	test('grant creates a permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'alice');
		const permit = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		assert.ok(permit.id);
		assert.strictEqual(permit.actor_id, actor_id);
		assert.strictEqual(permit.role, ROLE_ADMIN);
		assert.strictEqual(permit.revoked_at, null);
		assert.strictEqual(permit.granted_by, null);
	});

	test('grant with expiration', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'bob');
		const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
		const permit = await query_grant_permit(deps, {
			actor_id,
			role: ROLE_ADMIN,
			expires_at: future,
			granted_by: null,
		});
		assert.ok(permit.expires_at);
	});

	test('grant with granted_by', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id: keeper_id} = await create_test_actor(db, 'keeper');
		const {actor_id: admin_id} = await create_test_actor(db, 'admin');
		const permit = await query_grant_permit(deps, {
			actor_id: admin_id,
			role: ROLE_ADMIN,
			granted_by: keeper_id,
		});
		assert.strictEqual(permit.granted_by, keeper_id);
	});

	test('has_role returns false for a different role than the one granted', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'dave');
		await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		assert.strictEqual(await query_permit_has_role(deps, actor_id, ROLE_KEEPER), false);
	});

	test('revoke returns id and role when revoking an active permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'grace');
		const permit = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		const result = await query_revoke_permit(deps, permit.id, actor_id, null);
		assert.strictEqual(result?.id, permit.id);
		assert.strictEqual(result?.role, ROLE_ADMIN);
	});

	test('revoke returns null for already revoked permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'heidi');
		const permit = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		await query_revoke_permit(deps, permit.id, actor_id, null);
		assert.strictEqual(await query_revoke_permit(deps, permit.id, actor_id, null), null);
	});

	test('find_active_for_actor returns only active permits', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'ivan');
		await query_grant_permit(deps, {actor_id, role: ROLE_KEEPER, granted_by: null});
		const revokable = await query_grant_permit(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null,
		});
		await query_revoke_permit(deps, revokable.id, actor_id, null);
		const past = new Date(Date.now() - 1000);
		await query_grant_permit(deps, {actor_id, role: 'teacher', expires_at: past, granted_by: null});

		const active = await query_permit_find_active_for_actor(deps, actor_id);
		assert.strictEqual(active.length, 1);
		assert.strictEqual(active[0]!.role, ROLE_KEEPER);
	});

	test('list_for_actor returns all permits including revoked', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'judy');
		await query_grant_permit(deps, {actor_id, role: ROLE_KEEPER, granted_by: null});
		const revokable = await query_grant_permit(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: null,
		});
		await query_revoke_permit(deps, revokable.id, actor_id, null);

		const all = await query_permit_list_for_actor(deps, actor_id);
		assert.strictEqual(all.length, 2);
	});

	test('revoke_role revokes the active permit for a role', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'karen');
		await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		await query_grant_permit(deps, {actor_id, role: ROLE_KEEPER, granted_by: null});

		const result = await query_permit_revoke_role(deps, actor_id, ROLE_ADMIN, null);
		assert.strictEqual(result.revoked.length, 1);
		assert.strictEqual(result.revoked[0]?.role, ROLE_ADMIN);
		assert.strictEqual(await query_permit_has_role(deps, actor_id, ROLE_ADMIN), false);
		assert.strictEqual(await query_permit_has_role(deps, actor_id, ROLE_KEEPER), true);
	});

	test('grant is idempotent — second grant returns existing permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'dupe_test');
		const first = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		const second = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		assert.strictEqual(first.id, second.id);
	});

	test('idempotent grant preserves original permit fields', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id: granter_a} = await create_test_actor(db, 'granter_a');
		const {actor_id: granter_b} = await create_test_actor(db, 'granter_b');
		const {actor_id} = await create_test_actor(db, 'grantee');
		const first = await query_grant_permit(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: granter_a,
		});
		const second = await query_grant_permit(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: granter_b,
		});
		assert.strictEqual(first.id, second.id);
		assert.strictEqual(second.granted_by, granter_a);
	});

	test('grant allows same role after revocation', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'regranted');
		const first = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		await query_revoke_permit(deps, first.id, actor_id, null);
		const second = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		assert.notStrictEqual(first.id, second.id);
		assert.strictEqual(await query_permit_has_role(deps, actor_id, ROLE_ADMIN), true);
	});

	test('grant allows different roles for same actor', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'multi_role');
		const keeper = await query_grant_permit(deps, {actor_id, role: ROLE_KEEPER, granted_by: null});
		const admin = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		assert.notStrictEqual(keeper.id, admin.id);
		assert.strictEqual(await query_permit_has_role(deps, actor_id, ROLE_KEEPER), true);
		assert.strictEqual(await query_permit_has_role(deps, actor_id, ROLE_ADMIN), true);
	});

	test('permits cascade delete with actor', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id, account_id} = await create_test_actor(db, 'leo');
		await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});

		await query_delete_account(deps, account_id);

		const permits = await query_permit_list_for_actor(deps, actor_id);
		assert.strictEqual(permits.length, 0);
	});

	// -- find_account_id_for_role -------------------------------------------------

	test('find_account_id_for_role returns account_id for active permit', async () => {
		const db = get_db();
		const deps = {db};
		const {account_id, actor_id} = await create_test_actor(db, 'farole_active');
		await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		const result = await query_permit_find_account_id_for_role(deps, ROLE_ADMIN);
		assert.strictEqual(result, account_id);
	});

	test('find_account_id_for_role returns null when no active permit', async () => {
		const db = get_db();
		const deps = {db};
		await create_test_actor(db, 'farole_none');
		// no permits granted at all — use a role nobody has
		const result = await query_permit_find_account_id_for_role(deps, 'nonexistent_role');
		assert.strictEqual(result, null);
	});

	test('find_account_id_for_role returns null for revoked permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'farole_revoked');
		const permit = await query_grant_permit(deps, {actor_id, role: 'teacher', granted_by: null});
		await query_revoke_permit(deps, permit.id, actor_id, null);
		const result = await query_permit_find_account_id_for_role(deps, 'teacher');
		assert.strictEqual(result, null);
	});

	test('find_account_id_for_role returns null for expired permit', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'farole_expired');
		const past = new Date(Date.now() - 1000);
		await query_grant_permit(deps, {actor_id, role: 'teacher', expires_at: past, granted_by: null});
		const result = await query_permit_find_account_id_for_role(deps, 'teacher');
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
				const deps = {db};
				const username = `cart_${role}_${state}`;
				const {actor_id} = await create_test_actor(db, username);

				if (state === 'active') {
					await query_grant_permit(deps, {actor_id, role, granted_by: null});
				} else if (state === 'expired') {
					const past = new Date(Date.now() - 1000);
					await query_grant_permit(deps, {actor_id, role, expires_at: past, granted_by: null});
				} else if (state === 'revoked') {
					const permit = await query_grant_permit(deps, {actor_id, role, granted_by: null});
					await query_revoke_permit(deps, permit.id, actor_id, null);
				}
				// 'not_granted' — no grant at all

				assert.strictEqual(await query_permit_has_role(deps, actor_id, role), expected);
			});
		}
	}

	// -- revoke IDOR guard --------------------------------------------------------

	test('revoke rejects cross-actor revocation (IDOR guard)', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id: actor_a} = await create_test_actor(db, 'idor_actor_a');
		const {actor_id: actor_b} = await create_test_actor(db, 'idor_actor_b');

		const permit = await query_grant_permit(deps, {
			actor_id: actor_a,
			role: ROLE_ADMIN,
			granted_by: null,
		});

		// actor B tries to revoke actor A's permit
		const result = await query_revoke_permit(deps, permit.id, actor_b, null);
		assert.strictEqual(result, null);

		// permit is still active for actor A
		assert.strictEqual(await query_permit_has_role(deps, actor_a, ROLE_ADMIN), true);
	});

	// -- revoke reason + supersede on revoke -----------------------------------

	test('revoke plumbs reason to revoked_reason column', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'revoke_reason');
		const permit = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		await query_revoke_permit(deps, permit.id, actor_id, null, 'misconduct');
		const rows = await db.query<{revoked_reason: string | null}>(
			`SELECT revoked_reason FROM permit WHERE id = $1`,
			[permit.id],
		);
		assert.strictEqual(rows[0]!.revoked_reason, 'misconduct');
	});

	test('revoke supersedes pending offers for the revoked (actor, role, scope)', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id, account_id} = await create_test_actor(db, 'revoke_supersede_recipient');
		const {actor_id: grantor_actor} = await create_test_actor(db, 'revoke_supersede_grantor');
		const classroom = create_uuid();

		// grant the permit we will revoke (scoped)
		const permit = await query_grant_permit(deps, {
			actor_id,
			role: 'classroom_student',
			scope_id: classroom,
			granted_by: null,
		});

		// a pending offer for the same (account, role, scope) from a different
		// grantor — the stale-offer bypass vector
		const stale_offer = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, 'classroom_student', $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_actor, account_id, classroom],
		);
		const stale_offer_id = stale_offer[0]!.id;

		// an unrelated pending offer for a different scope — must NOT be superseded
		const other_classroom = create_uuid();
		const unrelated = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, 'classroom_student', $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_actor, account_id, other_classroom],
		);
		const unrelated_id = unrelated[0]!.id;

		const result = await query_revoke_permit(deps, permit.id, actor_id, null, 'classroom ended');
		assert.ok(result);
		assert.strictEqual(result.superseded_offers.length, 1);
		assert.strictEqual(result.superseded_offers[0]!.id, stale_offer_id);
		// from_account_id is populated by the CTE join on `actor` — direct
		// guard so a rename or dropped join breaks this test, not just the
		// downstream WS fan-out e2es.
		const grantor_account_rows = await db.query<{account_id: string}>(
			`SELECT account_id FROM actor WHERE id = $1`,
			[grantor_actor],
		);
		assert.strictEqual(
			result.superseded_offers[0]!.from_account_id,
			grantor_account_rows[0]!.account_id,
		);

		// stale offer is terminal on disk
		const stale_rows = await db.query<{superseded_at: string | null}>(
			`SELECT superseded_at FROM permit_offer WHERE id = $1`,
			[stale_offer_id],
		);
		assert.ok(stale_rows[0]!.superseded_at);
		// unrelated offer is untouched
		const unrelated_rows = await db.query<{superseded_at: string | null}>(
			`SELECT superseded_at FROM permit_offer WHERE id = $1`,
			[unrelated_id],
		);
		assert.strictEqual(unrelated_rows[0]!.superseded_at, null);

		// RevokePermitResult exposes the revoked permit's scope, and the
		// superseded sibling's scope matches — catches any IS NOT DISTINCT FROM
		// vs `=` mismatches on the supersede WHERE clause.
		assert.strictEqual(result.scope_id, classroom);
		assert.strictEqual(result.superseded_offers[0]!.scope_id, classroom);
	});

	test('revoke with no pending offers returns empty superseded_offers', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'revoke_no_offers');
		const permit = await query_grant_permit(deps, {actor_id, role: ROLE_ADMIN, granted_by: null});
		const result = await query_revoke_permit(deps, permit.id, actor_id, null);
		assert.ok(result);
		assert.deepStrictEqual(result.superseded_offers, []);
	});

	test('revoke global permit does not supersede scoped offers (and vice versa)', async () => {
		// The `scope_id IS NOT DISTINCT FROM $3` clause is load-bearing here —
		// plain `=` would silently drop the NULL-scope case, and the converse
		// (using =-semantics for NULL) would over-match. Direct guard so
		// "simplifying" the SQL breaks this test.
		const db = get_db();
		const deps = {db};
		const {actor_id, account_id} = await create_test_actor(db, 'scope_isolation_actor');
		const {actor_id: grantor_actor} = await create_test_actor(db, 'scope_isolation_grantor');
		const classroom = create_uuid();

		// Global permit (scope_id NULL) for role 'teacher'.
		const global_permit = await query_grant_permit(deps, {
			actor_id,
			role: 'teacher',
			granted_by: null,
		});
		// A pending SCOPED offer for the same role — must survive revoking the global.
		const scoped_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, 'teacher', $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_actor, account_id, classroom],
		);
		const scoped_offer_id = scoped_rows[0]!.id;

		const revoke_global = await query_revoke_permit(deps, global_permit.id, actor_id, null);
		assert.ok(revoke_global);
		assert.deepStrictEqual(revoke_global.superseded_offers, []);

		const scoped_check = await db.query<{superseded_at: string | null}>(
			`SELECT superseded_at FROM permit_offer WHERE id = $1`,
			[scoped_offer_id],
		);
		assert.strictEqual(scoped_check[0]!.superseded_at, null);

		// Converse: revoke a scoped permit must not supersede a pending global offer.
		const scoped_permit = await query_grant_permit(deps, {
			actor_id,
			role: 'ta',
			scope_id: classroom,
			granted_by: null,
		});
		const global_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
			 VALUES ($1, $2, 'ta', NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_actor, account_id],
		);
		const global_offer_id = global_rows[0]!.id;

		const revoke_scoped = await query_revoke_permit(deps, scoped_permit.id, actor_id, null);
		assert.ok(revoke_scoped);
		assert.deepStrictEqual(revoke_scoped.superseded_offers, []);

		const global_check = await db.query<{superseded_at: string | null}>(
			`SELECT superseded_at FROM permit_offer WHERE id = $1`,
			[global_offer_id],
		);
		assert.strictEqual(global_check[0]!.superseded_at, null);
	});

	test('revoke_role supersedes pending offers across every scope, leaving other roles alone', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id, account_id} = await create_test_actor(db, 'revoke_role_scopes_actor');
		const {actor_id: grantor_actor} = await create_test_actor(db, 'revoke_role_scopes_grantor');
		const classroom_x = create_uuid();
		const classroom_y = create_uuid();

		// Two active scoped student permits (one per classroom).
		await query_grant_permit(deps, {
			actor_id,
			role: 'classroom_student',
			scope_id: classroom_x,
			granted_by: null,
		});
		await query_grant_permit(deps, {
			actor_id,
			role: 'classroom_student',
			scope_id: classroom_y,
			granted_by: null,
		});

		// Pending classroom_student offers in each classroom — these must all
		// be superseded by revoke_role.
		const student_x_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, 'classroom_student', $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_actor, account_id, classroom_x],
		);
		const student_y_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, 'classroom_student', $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_actor, account_id, classroom_y],
		);
		const student_x_offer = student_x_rows[0]!.id;
		const student_y_offer = student_y_rows[0]!.id;

		// Distractor: a pending classroom_teacher offer for the same actor/scope.
		// Different role → must be untouched.
		const teacher_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, 'classroom_teacher', $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_actor, account_id, classroom_x],
		);
		const teacher_offer_id = teacher_rows[0]!.id;

		const result = await query_permit_revoke_role(deps, actor_id, 'classroom_student', null);
		assert.strictEqual(result.revoked.length, 2);

		// Both classroom_student offers are superseded.
		const student_states = await db.query<{id: string; superseded_at: string | null}>(
			`SELECT id, superseded_at FROM permit_offer WHERE id = ANY($1)`,
			[[student_x_offer, student_y_offer]],
		);
		assert.strictEqual(student_states.length, 2);
		for (const row of student_states) {
			assert.ok(row.superseded_at, `offer ${row.id} should be superseded`);
		}

		// from_account_id is populated for every superseded row via CTE join —
		// direct guard so a broken join fails here before any downstream
		// notification test.
		const grantor_account_rows = await db.query<{account_id: string}>(
			`SELECT account_id FROM actor WHERE id = $1`,
			[grantor_actor],
		);
		const expected_grantor_account = grantor_account_rows[0]!.account_id;
		assert.strictEqual(result.superseded_offers.length, 2);
		for (const sibling of result.superseded_offers) {
			assert.strictEqual(sibling.from_account_id, expected_grantor_account);
		}

		// The classroom_teacher distractor is untouched.
		const teacher_state = await db.query<{superseded_at: string | null}>(
			`SELECT superseded_at FROM permit_offer WHERE id = $1`,
			[teacher_offer_id],
		);
		assert.strictEqual(teacher_state[0]!.superseded_at, null);
	});
});
