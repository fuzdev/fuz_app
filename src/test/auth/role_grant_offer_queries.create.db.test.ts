/**
 * Tests for `role_grant_offer_queries.ts` — offer creation paths.
 *
 * Covers the create insert, same-(to_account, role, scope) re-offer upsert,
 * scope-distinguished offers under the partial unique index, the
 * self-target rejection, and the parties' rule: a recipient or grantor that is
 * not an active account is refused here, so a caller creating offers without
 * the spine's handler gets it too.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	query_role_grant_offer_create,
	RoleGrantOfferActorAccountMismatchError,
	RoleGrantOfferGrantorNotActiveError,
	RoleGrantOfferRecipientNotActiveError,
	RoleGrantOfferSelfTargetError
} from '#lib/auth/role_grant_offer_queries.ts';
import { query_account_soft_delete, query_actor_soft_delete } from '#lib/auth/account_queries.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';
import type { Db } from '#lib/db/db.ts';

import { describe_db } from '../db_fixture.ts';
import { make_account, future, hour } from './role_grant_offer_queries.fixtures.ts';

describe_db('role_grant_offer_queries.create', (get_db) => {
	test('create inserts a pending offer', async () => {
		const db = get_db();
		const deps = { db };
		const grantor = await make_account(db, 'grantor_create');
		const recipient = await make_account(db, 'recipient_create');
		const offer = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'welcome',
			expires_at: future(hour)
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
		const deps = { db };
		const grantor = await make_account(db, 'grantor_upsert');
		const recipient = await make_account(db, 'recipient_upsert');
		const first = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'first',
			expires_at: future(hour)
		});
		const later_expiry = future(hour * 2);
		const second = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'second',
			expires_at: later_expiry
		});
		assert.strictEqual(second.id, first.id);
		assert.strictEqual(second.message, 'second');
		// Compare timestamps numerically — `Date >` works on Date objects but
		// not consistently on bare ISO strings depending on driver shape.
		assert.ok(new Date(second.expires_at).getTime() > new Date(first.expires_at).getTime());
		// still a single row in the table for this recipient/role.
		const rows = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM role_grant_offer WHERE to_account_id = $1 AND role = $2`,
			[recipient.account_id, 'teacher']
		);
		assert.strictEqual(rows[0]!.c, 1);
	});

	test('different scope produces a distinct offer (partial unique index covers scope)', async () => {
		const db = get_db();
		const deps = { db };
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
			expires_at: future(hour)
		});
		const offer_b = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_kind: 'classroom',
			scope_id: classroom_b,
			expires_at: future(hour)
		});
		assert.notStrictEqual(offer_a.id, offer_b.id);
	});

	test('self-offer rejected (from_actor belongs to to_account)', async () => {
		const db = get_db();
		const deps = { db };
		const self = await make_account(db, 'self_offer');
		const err = await assert_rejects(() =>
			query_role_grant_offer_create(deps, {
				from_actor_id: self.actor_id,
				to_account_id: self.account_id,
				role: 'teacher',
				expires_at: future(hour)
			})
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
		const deps = { db };
		const grantor = await make_account(db, 'grantor_narrow');
		const recipient = await make_account(db, 'recipient_narrow');
		const account_grain = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour)
		});
		assert.strictEqual(account_grain.to_actor_id, null);
		const narrowed = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			to_actor_id: recipient.actor_id,
			role: 'teacher',
			expires_at: future(hour)
		});
		assert.strictEqual(narrowed.id, account_grain.id);
		assert.strictEqual(narrowed.to_actor_id, recipient.actor_id);
	});

	test('re-offer widens actor-grain row back to account-grain (to_actor_id set → null)', async () => {
		// Companion to the narrow case: re-offer with `to_actor_id: null`
		// must reset the column. Closes the asymmetric path where an
		// actor-grain offer accidentally stays bound after a wider re-offer.
		const db = get_db();
		const deps = { db };
		const grantor = await make_account(db, 'grantor_widen');
		const recipient = await make_account(db, 'recipient_widen');
		const actor_grain = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			to_actor_id: recipient.actor_id,
			role: 'teacher',
			expires_at: future(hour)
		});
		assert.strictEqual(actor_grain.to_actor_id, recipient.actor_id);
		const widened = await query_role_grant_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			to_actor_id: null,
			role: 'teacher',
			expires_at: future(hour)
		});
		assert.strictEqual(widened.id, actor_grain.id);
		assert.strictEqual(widened.to_actor_id, null);
	});

	/** An offer from `from_actor_id` to `to_account_id` (and `to_actor_id`), or the error it threw. */
	const try_offer = async (
		db: Db,
		from_actor_id: Uuid,
		to_account_id: Uuid,
		to_actor_id: Uuid | null = null
	): Promise<unknown> => {
		try {
			return await query_role_grant_offer_create(
				{ db },
				{ from_actor_id, to_account_id, to_actor_id, role: 'teacher', expires_at: future(hour) }
			);
		} catch (err) {
			return err;
		}
	};
	const count_offers = async (db: Db, to_account_id: Uuid): Promise<number> =>
		Number(
			(
				await db.query<{ n: string }>(
					`SELECT COUNT(*) AS n FROM role_grant_offer WHERE to_account_id = $1`,
					[to_account_id]
				)
			)[0]!.n
		);

	test('a deleted recipient and a missing one are the one refusal, writing nothing', async () => {
		const db = get_db();
		const grantor = await make_account(db, 'grantor_parties');
		const deleted = await make_account(db, 'recipient_deleted');
		await query_account_soft_delete({ db }, deleted.account_id, null);
		await query_actor_soft_delete({ db }, deleted.actor_id, null);
		const actorless = await make_account(db, 'recipient_actorless');
		await query_actor_soft_delete({ db }, actorless.actor_id, null);

		for (const [to_account_id, label] of [
			[deleted.account_id, 'a deleted recipient'],
			[create_uuid(), 'a missing recipient'],
			[actorless.account_id, 'a live account with no active actor']
		] as const) {
			assert.instanceOf(
				await try_offer(db, grantor.actor_id, to_account_id),
				RoleGrantOfferRecipientNotActiveError,
				label
			);
		}
		// an actor named on a deleted or missing recipient: the same refusal,
		// which the handler answers as the actor mismatch
		assert.instanceOf(
			await try_offer(db, grantor.actor_id, deleted.account_id, deleted.actor_id),
			RoleGrantOfferRecipientNotActiveError
		);
		assert.instanceOf(
			await try_offer(db, grantor.actor_id, create_uuid(), create_uuid()),
			RoleGrantOfferRecipientNotActiveError
		);
		assert.strictEqual(await count_offers(db, deleted.account_id), 0, 'nothing written');
	});

	test('a named actor must be an active actor of the recipient', async () => {
		const db = get_db();
		const grantor = await make_account(db, 'grantor_actor');
		const recipient = await make_account(db, 'recipient_actor');
		const stranger = await make_account(db, 'recipient_stranger');
		const tombstoned = await make_account(db, 'recipient_tombstoned');
		// a second, tombstoned actor on a live account
		const row = await db.query_one<{ id: Uuid }>(
			`INSERT INTO actor (account_id, name) VALUES ($1, 'gone') RETURNING id`,
			[tombstoned.account_id]
		);
		await query_actor_soft_delete({ db }, row!.id, null);

		for (const [to_account_id, to_actor_id, label] of [
			[recipient.account_id, stranger.actor_id, "another account's actor"],
			[recipient.account_id, create_uuid(), 'a missing actor'],
			[tombstoned.account_id, row!.id, 'a tombstoned actor of a live account']
		] as const) {
			assert.instanceOf(
				await try_offer(db, grantor.actor_id, to_account_id, to_actor_id),
				RoleGrantOfferActorAccountMismatchError,
				label
			);
		}
	});

	test('the self-target check comes first, whatever actor is named', async () => {
		const db = get_db();
		const grantor = await make_account(db, 'grantor_self');
		const stranger = await make_account(db, 'stranger_self');
		assert.instanceOf(
			await try_offer(db, grantor.actor_id, grantor.account_id, stranger.actor_id),
			RoleGrantOfferSelfTargetError
		);
	});

	test('a deleted or missing grantor is refused, writing nothing', async () => {
		const db = get_db();
		const recipient = await make_account(db, 'recipient_of_gone');
		const deleted = await make_account(db, 'grantor_deleted');
		await query_account_soft_delete({ db }, deleted.account_id, null);
		await query_actor_soft_delete({ db }, deleted.actor_id, null);
		const tombstoned_only = await make_account(db, 'grantor_actor_gone');
		await query_actor_soft_delete({ db }, tombstoned_only.actor_id, null);

		for (const [from_actor_id, label] of [
			[deleted.actor_id, 'a deleted grantor'],
			[tombstoned_only.actor_id, 'a tombstoned grantor actor on a live account'],
			[create_uuid(), 'a missing grantor actor']
		] as const) {
			assert.instanceOf(
				await try_offer(db, from_actor_id, recipient.account_id),
				RoleGrantOfferGrantorNotActiveError,
				label
			);
		}
		assert.strictEqual(await count_offers(db, recipient.account_id), 0, 'nothing written');
	});
});
