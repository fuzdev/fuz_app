/**
 * Tests for `role_grant_offer_queries.ts` — list / find_pending / sweep readers.
 *
 * Covers the active-offer filter on `query_role_grant_offer_list`, the
 * `find_pending` lookup short-circuit on terminal/expired offers, and the
 * expired-only `sweep_expired` reader. The supersede × sweep interaction
 * lives in `role_grant_offer_queries.supersede.db.test.ts`.
 *
 * @module
 */

import {assert, test} from 'vitest';

import {
	query_accept_offer,
	query_role_grant_offer_decline,
	query_role_grant_offer_retract,
	query_role_grant_offer_list,
	query_role_grant_offer_find_pending,
	query_role_grant_offer_sweep_expired,
} from '$lib/auth/role_grant_offer_queries.ts';
import {create_uuid} from '@fuzdev/fuz_util/id.ts';

import {describe_db} from '../db_fixture.ts';
import {
	make_account,
	create_pending_offer,
	insert_superseded_offer,
	future,
	hour,
} from './role_grant_offer_queries.fixtures.ts';

describe_db('role_grant_offer_queries.list', (get_db) => {
	test('list filters out every terminal state plus expired-pending', async () => {
		// Each terminal column (accepted_at / declined_at / retracted_at /
		// superseded_at) is an independent gate in the WHERE clause; the
		// expired-pending case is a separate `expires_at > NOW()` gate. Cover
		// each path so a refactor that drops one of the IS NULL checks fails
		// here rather than leaking terminal rows into a recipient's inbox.
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_list');
		const recipient = await make_account(db, 'recipient_list');

		// pending, in-window — should appear
		const pending = await create_pending_offer(db, grantor, recipient);

		// accepted — terminal
		const acceptable = await create_pending_offer(db, grantor, recipient, {
			role: 'admin',
			scope_id: create_uuid(),
		});
		await db.transaction((tx) =>
			query_accept_offer(
				{db: tx},
				{
					offer_id: acceptable.id,
					to_account_id: recipient.account_id,
					actor_id: recipient.actor_id,
				},
			),
		);

		// declined — terminal
		const declinable = await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: create_uuid(),
		});
		await query_role_grant_offer_decline(deps, declinable.id, recipient.account_id, null);

		// retracted — terminal
		const retractable = await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: create_uuid(),
		});
		await query_role_grant_offer_retract(deps, retractable.id, grantor.actor_id);

		// superseded — terminal (no public API sets `superseded_at` outside the
		// accept / revoke supersede CTEs, so the fixture raw-INSERTs).
		await insert_superseded_offer(db, grantor, recipient, {scope_id: create_uuid()});

		// expired-pending
		await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: create_uuid(),
			expires_at: future(-hour),
		});

		const list = await query_role_grant_offer_list(deps, recipient.account_id);
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0]!.id, pending.id);
	});

	test('find_pending returns null for every terminal state plus expired-pending', async () => {
		// Same exhaustive coverage as the list test. find_pending shares the
		// same predicate structure — a missing IS NULL would silently break
		// the supersede revoke-bypass forecloser.
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_find');
		const recipient = await make_account(db, 'recipient_find');

		// pending baseline
		const pending = await create_pending_offer(db, grantor, recipient);
		assert.ok(await query_role_grant_offer_find_pending(deps, pending.id));

		// accepted
		const acceptable = await create_pending_offer(db, grantor, recipient, {
			role: 'admin',
			scope_id: create_uuid(),
		});
		await db.transaction((tx) =>
			query_accept_offer(
				{db: tx},
				{
					offer_id: acceptable.id,
					to_account_id: recipient.account_id,
					actor_id: recipient.actor_id,
				},
			),
		);
		assert.strictEqual(await query_role_grant_offer_find_pending(deps, acceptable.id), null);

		// declined
		const declinable = await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: create_uuid(),
		});
		await query_role_grant_offer_decline(deps, declinable.id, recipient.account_id, null);
		assert.strictEqual(await query_role_grant_offer_find_pending(deps, declinable.id), null);

		// retracted
		const retractable = await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: create_uuid(),
		});
		await query_role_grant_offer_retract(deps, retractable.id, grantor.actor_id);
		assert.strictEqual(await query_role_grant_offer_find_pending(deps, retractable.id), null);

		// superseded
		const superseded_id = await insert_superseded_offer(db, grantor, recipient, {
			scope_id: create_uuid(),
		});
		assert.strictEqual(await query_role_grant_offer_find_pending(deps, superseded_id), null);

		// expired-pending
		const expired = await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: create_uuid(),
			expires_at: future(-hour),
		});
		assert.strictEqual(await query_role_grant_offer_find_pending(deps, expired.id), null);

		// missing
		assert.strictEqual(await query_role_grant_offer_find_pending(deps, create_uuid()), null);
	});

	test('sweep returns only expired pending offers', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_sweep');
		const recipient = await make_account(db, 'recipient_sweep');

		const fresh = await create_pending_offer(db, grantor, recipient);
		const expired = await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: create_uuid(),
			expires_at: future(-hour),
		});

		const swept = await query_role_grant_offer_sweep_expired(deps);
		const swept_ids = swept.map((o) => o.id);
		assert.include(swept_ids, expired.id);
		assert.notInclude(swept_ids, fresh.id);
	});

	test('list orders by expires_at ASC (soonest first)', async () => {
		// `query_role_grant_offer_list` ORDER BY expires_at ASC is part of the
		// inbox contract — closest deadline first so users act on the most
		// urgent offer. Three rows with distinct deadlines pin both order
		// and stability.
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_list_order');
		const recipient = await make_account(db, 'recipient_list_order');
		// Insert in reverse expiry order so the result depends on ORDER BY,
		// not insertion order.
		const late = await create_pending_offer(db, grantor, recipient, {
			role: 'a',
			scope_id: create_uuid(),
			expires_at: future(hour * 3),
		});
		const middle = await create_pending_offer(db, grantor, recipient, {
			role: 'b',
			scope_id: create_uuid(),
			expires_at: future(hour * 2),
		});
		const soon = await create_pending_offer(db, grantor, recipient, {
			role: 'c',
			scope_id: create_uuid(),
			expires_at: future(hour),
		});
		const list = await query_role_grant_offer_list(deps, recipient.account_id);
		assert.deepStrictEqual(
			list.map((o) => o.id),
			[soon.id, middle.id, late.id],
		);
	});

	test('sweep_expired orders by expires_at ASC (oldest expiry first)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_sweep_order');
		const recipient = await make_account(db, 'recipient_sweep_order');
		const newer = await create_pending_offer(db, grantor, recipient, {
			role: 'a',
			scope_id: create_uuid(),
			expires_at: future(-5 * 60_000),
		});
		const oldest = await create_pending_offer(db, grantor, recipient, {
			role: 'b',
			scope_id: create_uuid(),
			expires_at: future(-hour * 3),
		});
		const middle = await create_pending_offer(db, grantor, recipient, {
			role: 'c',
			scope_id: create_uuid(),
			expires_at: future(-hour),
		});
		const swept = await query_role_grant_offer_sweep_expired(deps);
		const ids = swept.map((o) => o.id);
		assert.deepStrictEqual(ids, [oldest.id, middle.id, newer.id]);
	});
});
