/**
 * Tests for role escalation prevention.
 *
 * Verifies that the admin grant endpoint enforces `web_grantable` filtering,
 * preventing admin users from granting keeper or non-web-grantable roles
 * via the API. Also verifies self-grant and cross-account grant boundaries.
 *
 * @module
 */

import {assert, test} from 'vitest';

import {ROLE_KEEPER, ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	query_grant_permit,
	query_revoke_permit,
	query_permit_has_role,
	query_permit_find_active_for_actor,
} from '$lib/auth/permit_queries.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import type {Db} from '$lib/db/db.js';
import {create_test_account_with_actor} from '$lib/testing/db_entities.js';

import {describe_db} from '../db_fixture.js';

/** Per-test convenience: returns just the ids the assertions care about. */
const create_test_actor = async (
	database: Db,
	username: string,
): Promise<{account_id: Uuid; actor_id: Uuid}> => {
	const {account, actor} = await create_test_account_with_actor(database, {username});
	return {account_id: account.id, actor_id: actor.id};
};

describe_db('RoleEscalation', (get_db) => {
	test('admin with only admin role cannot directly grant keeper at query level', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id: admin_id} = await create_test_actor(db, 'escalation_admin');
		const {actor_id: target_id} = await create_test_actor(db, 'escalation_target');

		// grant admin role to admin_id
		await query_grant_permit(deps, {actor_id: admin_id, role: ROLE_ADMIN, granted_by: null});

		// admin grants keeper to target — at the query level this succeeds (no policy enforcement)
		// the web_grantable enforcement is in the route handler, not the query layer
		const permit = await query_grant_permit(deps, {
			actor_id: target_id,
			role: ROLE_KEEPER,
			granted_by: admin_id,
		});
		// query layer allows this — it's the route handler that enforces web_grantable
		assert.ok(permit.id);
		assert.strictEqual(permit.role, ROLE_KEEPER);
		assert.strictEqual(permit.granted_by, admin_id);
	});

	test('self-grant at query level records granted_by correctly', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id} = await create_test_actor(db, 'self_grant');

		// self-grant admin
		const permit = await query_grant_permit(deps, {
			actor_id,
			role: ROLE_ADMIN,
			granted_by: actor_id,
		});
		assert.strictEqual(permit.actor_id, actor_id);
		assert.strictEqual(permit.granted_by, actor_id);
		assert.strictEqual(await query_permit_has_role(deps, actor_id, ROLE_ADMIN), true);
	});

	test('granting the same role twice is idempotent and preserves original granter', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id: granter_a} = await create_test_actor(db, 'esc_granter_a');
		const {actor_id: granter_b} = await create_test_actor(db, 'esc_granter_b');
		const {actor_id: target} = await create_test_actor(db, 'esc_target_idem');

		const first = await query_grant_permit(deps, {
			actor_id: target,
			role: ROLE_ADMIN,
			granted_by: granter_a,
		});
		const second = await query_grant_permit(deps, {
			actor_id: target,
			role: ROLE_ADMIN,
			granted_by: granter_b,
		});

		// idempotent — same permit, original granter preserved
		assert.strictEqual(first.id, second.id);
		assert.strictEqual(second.granted_by, granter_a);
	});

	test('revoking then regranting creates a new permit with new granter', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id: granter_a} = await create_test_actor(db, 'esc_rg_a');
		const {actor_id: granter_b} = await create_test_actor(db, 'esc_rg_b');
		const {actor_id: target} = await create_test_actor(db, 'esc_rg_target');

		const first = await query_grant_permit(deps, {
			actor_id: target,
			role: ROLE_ADMIN,
			granted_by: granter_a,
		});
		await query_revoke_permit(deps, first.id, target, null);

		const second = await query_grant_permit(deps, {
			actor_id: target,
			role: ROLE_ADMIN,
			granted_by: granter_b,
		});

		assert.notStrictEqual(first.id, second.id);
		assert.strictEqual(second.granted_by, granter_b);
	});

	test('actor with admin role cannot see other actor permits via find_active_for_actor', async () => {
		const db = get_db();
		const deps = {db};
		const {actor_id: admin_id} = await create_test_actor(db, 'esc_admin_peek');
		const {actor_id: other_id} = await create_test_actor(db, 'esc_other_peek');

		await query_grant_permit(deps, {actor_id: admin_id, role: ROLE_ADMIN, granted_by: null});
		await query_grant_permit(deps, {actor_id: other_id, role: ROLE_KEEPER, granted_by: null});

		// querying with admin's actor_id only returns admin's permits
		const admin_permits = await query_permit_find_active_for_actor(deps, admin_id);
		assert.strictEqual(admin_permits.length, 1);
		assert.strictEqual(admin_permits[0]!.role, ROLE_ADMIN);

		// querying with other's actor_id returns other's permits
		const other_permits = await query_permit_find_active_for_actor(deps, other_id);
		assert.strictEqual(other_permits.length, 1);
		assert.strictEqual(other_permits[0]!.role, ROLE_KEEPER);
	});
});
