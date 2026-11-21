/**
 * Tests for `query_actor_has_active_global_role` — the actor-keyed live read
 * of a global grant: the actor and its account both live, the grant global,
 * active, and on that actor, not another of its account.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { query_account_soft_delete } from '#lib/auth/account_queries.ts';
import { query_revoke_role_grant } from '#lib/auth/role_grant_offer_queries.ts';
import {
	query_create_role_grant,
	query_actor_has_active_global_role
} from '#lib/auth/role_grant_queries.ts';
import { create_uuid } from '#lib/primitive_schemas.ts';
import {
	create_test_account_with_actor,
	create_test_extra_actor,
	soft_delete_test_actor
} from '#lib/testing/db_entities.ts';

import { describe_db } from '../db_fixture.ts';

describe_db('query_actor_has_active_global_role', (get_db) => {
	test('an active global grant on a live actor and account counts', async () => {
		const db = get_db();
		const deps = { db };
		const { actor } = await create_test_account_with_actor(db, { username: 'holder' });
		assert.isFalse(await query_actor_has_active_global_role(deps, actor.id, ROLE_ADMIN));
		await query_create_role_grant(deps, { actor_id: actor.id, role: ROLE_ADMIN, granted_by: null });
		assert.isTrue(await query_actor_has_active_global_role(deps, actor.id, ROLE_ADMIN));
		// another role is another read
		assert.isFalse(await query_actor_has_active_global_role(deps, actor.id, 'teacher'));
	});

	test('a soft-deleted actor holds nothing', async () => {
		const db = get_db();
		const deps = { db };
		const { account } = await create_test_account_with_actor(db, { username: 'actor_gone' });
		const extra = await create_test_extra_actor(db, account.id, 'extra');
		await query_create_role_grant(deps, { actor_id: extra.id, role: ROLE_ADMIN, granted_by: null });
		assert.isTrue(await query_actor_has_active_global_role(deps, extra.id, ROLE_ADMIN));
		assert.isTrue(await soft_delete_test_actor(db, extra.id));
		assert.isFalse(await query_actor_has_active_global_role(deps, extra.id, ROLE_ADMIN));
	});

	test("a soft-deleted account's actor holds nothing", async () => {
		const db = get_db();
		const deps = { db };
		const { account, actor } = await create_test_account_with_actor(db, {
			username: 'account_gone'
		});
		await query_create_role_grant(deps, { actor_id: actor.id, role: ROLE_ADMIN, granted_by: null });
		assert.isTrue(await query_actor_has_active_global_role(deps, actor.id, ROLE_ADMIN));
		assert.ok(await query_account_soft_delete(deps, account.id, null));
		assert.isFalse(await query_actor_has_active_global_role(deps, actor.id, ROLE_ADMIN));
	});

	test('a scoped grant is not a global one', async () => {
		const db = get_db();
		const deps = { db };
		const { actor } = await create_test_account_with_actor(db, { username: 'scoped_only' });
		await query_create_role_grant(deps, {
			actor_id: actor.id,
			role: 'teacher',
			scope_kind: 'classroom',
			scope_id: create_uuid(),
			granted_by: null
		});
		assert.isFalse(await query_actor_has_active_global_role(deps, actor.id, 'teacher'));
		await query_create_role_grant(deps, { actor_id: actor.id, role: 'teacher', granted_by: null });
		assert.isTrue(await query_actor_has_active_global_role(deps, actor.id, 'teacher'));
	});

	test("another actor of the account holding the role doesn't count", async () => {
		const db = get_db();
		const deps = { db };
		const { account, actor } = await create_test_account_with_actor(db, {
			username: 'two_actors'
		});
		const other = await create_test_extra_actor(db, account.id, 'other');
		await query_create_role_grant(deps, { actor_id: other.id, role: ROLE_ADMIN, granted_by: null });
		assert.isTrue(await query_actor_has_active_global_role(deps, other.id, ROLE_ADMIN));
		assert.isFalse(await query_actor_has_active_global_role(deps, actor.id, ROLE_ADMIN));
	});

	test('an expired or revoked grant holds nothing', async () => {
		const db = get_db();
		const deps = { db };
		const expired = await create_test_account_with_actor(db, { username: 'expired' });
		await query_create_role_grant(deps, {
			actor_id: expired.actor.id,
			role: ROLE_ADMIN,
			expires_at: new Date(Date.now() - 1000),
			granted_by: null
		});
		assert.isFalse(await query_actor_has_active_global_role(deps, expired.actor.id, ROLE_ADMIN));

		const revoked = await create_test_account_with_actor(db, { username: 'revoked' });
		const grant = await query_create_role_grant(deps, {
			actor_id: revoked.actor.id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		assert.isTrue(await query_actor_has_active_global_role(deps, revoked.actor.id, ROLE_ADMIN));
		await query_revoke_role_grant(deps, grant.id, revoked.actor.id, null);
		assert.isFalse(await query_actor_has_active_global_role(deps, revoked.actor.id, ROLE_ADMIN));
	});
});
