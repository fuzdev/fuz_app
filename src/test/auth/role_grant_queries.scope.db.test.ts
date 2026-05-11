/**
 * Tests for `role_grant_queries.ts` — `query_create_role_grant` + `query_role_grant_has_role`
 * scope semantics.
 *
 * Covers global-role_grant idempotence on the NULL-scope sentinel, scope-keyed
 * distinct rows, same-scope idempotence, and `has_role` matching rules
 * (scoped vs global, no cross-match either direction).
 *
 * @module
 */

import {assert, test} from 'vitest';

import {query_create_role_grant, query_role_grant_has_role} from '$lib/auth/role_grant_queries.js';
import {create_uuid} from '@fuzdev/fuz_util/id.js';

import {describe_db} from '../db_fixture.js';
import {make_account} from './role_grant_offer_queries.fixtures.js';

describe_db('role_grant_queries.scope', (get_db) => {
	test('query_create_role_grant: global role_grant (scope_id NULL) idempotent on sentinel', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'global_grantee');
		const first = await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'admin',
			granted_by: null,
		});
		const second = await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'admin',
			granted_by: null,
		});
		assert.strictEqual(first.id, second.id);
	});

	test('query_create_role_grant: different scopes produce distinct role_grants', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'scoped_grantee');
		const classroom_a = create_uuid();
		const classroom_b = create_uuid();
		const a = await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_a,
			granted_by: null,
		});
		const b = await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_b,
			granted_by: null,
		});
		assert.notStrictEqual(a.id, b.id);
		assert.strictEqual(a.scope_id, classroom_a);
		assert.strictEqual(b.scope_id, classroom_b);
	});

	test('query_create_role_grant: same scope is idempotent', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'idem_scope_grantee');
		const classroom = create_uuid();
		const a = await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null,
		});
		const b = await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom,
			granted_by: null,
		});
		assert.strictEqual(a.id, b.id);
	});

	test('query_role_grant_has_role: scope_id distinguishes grants', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'scope_check_grantee');
		const classroom_a = create_uuid();
		const classroom_b = create_uuid();
		await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_a,
			granted_by: null,
		});
		assert.strictEqual(
			await query_role_grant_has_role(deps, grantee.actor_id, 'classroom_student', classroom_a),
			true,
		);
		assert.strictEqual(
			await query_role_grant_has_role(deps, grantee.actor_id, 'classroom_student', classroom_b),
			false,
		);
		// No scope_id argument means "global (NULL) scope" — the scoped grant must not match.
		assert.strictEqual(
			await query_role_grant_has_role(deps, grantee.actor_id, 'classroom_student'),
			false,
		);
	});

	test('query_role_grant_has_role: global grant does not match a scoped check', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'global_vs_scoped');
		await query_create_role_grant(deps, {
			actor_id: grantee.actor_id,
			role: 'admin',
			granted_by: null,
		});
		assert.strictEqual(await query_role_grant_has_role(deps, grantee.actor_id, 'admin'), true);
		assert.strictEqual(
			await query_role_grant_has_role(deps, grantee.actor_id, 'admin', create_uuid()),
			false,
		);
	});
});
