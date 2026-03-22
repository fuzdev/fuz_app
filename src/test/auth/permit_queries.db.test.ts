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

		const revoked = await query_permit_revoke_role(deps, actor_id, ROLE_ADMIN, null);
		assert.strictEqual(revoked, true);
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
});
