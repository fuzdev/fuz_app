/**
 * Tests for `role_grant_offer_queries.ts` — offer creation paths.
 *
 * Covers the create insert, same-(to_account, role, scope) re-offer upsert,
 * scope-distinguished offers under the partial unique index, and the
 * self-target rejection.
 *
 * @module
 */

import {assert, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.ts';

import {
	query_role_grant_offer_create,
	RoleGrantOfferSelfTargetError,
} from '$lib/auth/role_grant_offer_queries.ts';
import {create_uuid} from '@fuzdev/fuz_util/id.ts';

import {describe_db} from '../db_fixture.ts';
import {make_account, future, hour} from './role_grant_offer_queries.fixtures.ts';

describe_db('role_grant_offer_queries.create', (get_db) => {
	test('create inserts a pending offer', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_create');
		const recipient = await make_account(db, 'recipient_create');
		const offer = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'welcome',
			expires_at: future(hour),
		});
		assert.match(offer.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		assert.strictEqual(offer.role, 'teacher');
		assert.strictEqual(offer.from_actor_id, grantor.actor_id);
		assert.strictEqual(offer.to_account_id, recipient.account_id);
		assert.strictEqual(offer.scope_id, null);
		assert.strictEqual(offer.message, 'welcome');
		assert.strictEqual(offer.accepted_at, null);
		assert.strictEqual(offer.declined_at, null);
		assert.strictEqual(offer.retracted_at, null);
		assert.strictEqual(offer.resulting_role_grant_id, null);
	});

	test('re-offer while pending upserts the same row (refreshes message + expires_at)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_upsert');
		const recipient = await make_account(db, 'recipient_upsert');
		const first = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'first',
			expires_at: future(hour),
		});
		const later_expiry = future(hour * 2);
		const second = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'second',
			expires_at: later_expiry,
		});
		assert.strictEqual(second.id, first.id);
		assert.strictEqual(second.message, 'second');
		// Compare timestamps numerically — `Date >` works on Date objects but
		// not consistently on bare ISO strings depending on driver shape.
		assert.ok(new Date(second.expires_at).getTime() > new Date(first.expires_at).getTime());
		// still a single row in the table for this recipient/role.
		const rows = await db.query<{c: number}>(
			`SELECT COUNT(*)::int AS c FROM role_grant_offer WHERE to_account_id = $1 AND role = $2`,
			[recipient.account_id, 'teacher'],
		);
		assert.strictEqual(rows[0]!.c, 1);
	});

	test('different scope produces a distinct offer (partial unique index covers scope)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_scope');
		const recipient = await make_account(db, 'recipient_scope');
		const classroom_a = create_uuid();
		const classroom_b = create_uuid();
		const offer_a = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_a,
			expires_at: future(hour),
		});
		const offer_b = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_b,
			expires_at: future(hour),
		});
		assert.notStrictEqual(offer_a.id, offer_b.id);
	});

	test('self-offer rejected (from_actor belongs to to_account)', async () => {
		const db = get_db();
		const deps = {db};
		const self = await make_account(db, 'self_offer');
		const err = await assert_rejects(() =>
			query_role_grant_offer_create(deps, {
				from_actor_id: self.actor_id,
				to_account_id: self.account_id,
				role: 'teacher',
				expires_at: future(hour),
			}),
		);
		assert.ok(err instanceof RoleGrantOfferSelfTargetError);
	});

	test('re-offer narrows account-grain row to a specific actor (to_actor_id null → set)', async () => {
		// Source contract: "supplying a different `to_actor_id` on re-offer
		// narrows the existing row to the named actor". Pins the
		// `EXCLUDED.to_actor_id` upsert behavior — without it the second call
		// would silently ignore the actor binding while still claiming the
		// re-offer landed.
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_narrow');
		const recipient = await make_account(db, 'recipient_narrow');
		const account_grain = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		assert.strictEqual(account_grain.to_actor_id, null);
		const narrowed = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			to_actor_id: recipient.actor_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		assert.strictEqual(narrowed.id, account_grain.id);
		assert.strictEqual(narrowed.to_actor_id, recipient.actor_id);
	});

	test('re-offer widens actor-grain row back to account-grain (to_actor_id set → null)', async () => {
		// Companion to the narrow case: re-offer with `to_actor_id: null`
		// must reset the column. Closes the asymmetric path where an
		// actor-grain offer accidentally stays bound after a wider re-offer.
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_widen');
		const recipient = await make_account(db, 'recipient_widen');
		const actor_grain = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			to_actor_id: recipient.actor_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		assert.strictEqual(actor_grain.to_actor_id, recipient.actor_id);
		const widened = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			to_actor_id: null,
			role: 'teacher',
			expires_at: future(hour),
		});
		assert.strictEqual(widened.id, actor_grain.id);
		assert.strictEqual(widened.to_actor_id, null);
	});
});
