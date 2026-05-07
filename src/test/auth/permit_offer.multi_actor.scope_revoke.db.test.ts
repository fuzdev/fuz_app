/**
 * Multi-actor coverage — `query_permit_revoke_for_scope` returns one
 * row per revoked permit with the right actor + account on each.
 *
 * Scope-cascade revocation produces an audit event per revoked permit,
 * keyed by `(actor_id, account_id)`. This test seeds two accounts with
 * a permit each on the same scope and asserts the cascade returns both
 * rows with the correct identity columns.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {query_permit_revoke_for_scope, query_grant_permit} from '$lib/auth/permit_queries.js';

import {create_route_specs, describe_db, session_options} from './permit_offer_test_helpers.js';

describe_db('permit_offer.multi_actor — scope_revoke', (get_db) => {
	describe('query_permit_revoke_for_scope returns actor + account per revoked permit', () => {
		test('cascade returns one entry per revoked permit with correct actor + account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const a = await test_app.create_account({username: 'scope_revoke_a'});
			const b = await test_app.create_account({username: 'scope_revoke_b'});

			const scope: Uuid = '11111111-1111-4111-8111-111111111111' as Uuid;

			await query_grant_permit(
				{db: get_db()},
				{actor_id: a.actor.id, role: 'classroom_student', scope_id: scope, granted_by: null},
			);
			await query_grant_permit(
				{db: get_db()},
				{actor_id: b.actor.id, role: 'classroom_student', scope_id: scope, granted_by: null},
			);

			const result = await get_db().transaction(async (tx) =>
				query_permit_revoke_for_scope({db: tx}, scope, null, 'scope_destroyed'),
			);

			assert.strictEqual(result.revoked.length, 2);
			const by_actor = new Map<string, (typeof result.revoked)[number]>();
			for (const row of result.revoked) by_actor.set(row.actor_id, row);
			const a_row = by_actor.get(a.actor.id);
			const b_row = by_actor.get(b.actor.id);
			assert.ok(a_row);
			assert.ok(b_row);
			assert.strictEqual(a_row.account_id, a.account.id);
			assert.strictEqual(b_row.account_id, b.account.id);
			assert.strictEqual(a_row.scope_id, scope);
			assert.strictEqual(b_row.role, 'classroom_student');
		});
	});
});
