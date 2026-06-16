/**
 * Concurrent-race tests for the offer surface.
 *
 * True `SELECT FOR UPDATE` / row-lock serialization requires two concurrent
 * transactions against a real `pg` pool — PGlite runs transactions serially,
 * so the cross-tx interleavings that matter here are only reachable with
 * real connection-level concurrency. Runs against `pg_factory` only;
 * skipped when `TEST_DATABASE_URL` is unset.
 *
 * @module
 */

import {assert, test} from 'vitest';

import {query_accept_offer} from '$lib/auth/role_grant_offer_queries.ts';
import {query_create_role_grant, query_revoke_role_grant} from '$lib/auth/role_grant_queries.ts';
import type {Db} from '$lib/db/db.ts';
import {create_describe_db, auth_integration_truncate_tables} from '$lib/testing/db.ts';

import {pg_factory} from '../db_fixture.ts';
import {make_account, create_pending_offer} from './role_grant_offer_queries.fixtures.ts';

/**
 * Run a transactional op, retrying once on Postgres deadlock_detected
 * (`SQLSTATE 40P01`). The `revoke_role_grant` × `accept_offer` race deadlocks
 * deterministically when ordering interleaves: accept holds the offer
 * row-lock and waits on the active-role_grant partial-unique-index conflict
 * with revoke; revoke holds the role_grant row-lock and its supersede CTE
 * waits on the offer row-lock. Postgres aborts a victim; the user-facing
 * contract is "after retry, the SQL invariants still hold."
 */
const run_with_deadlock_retry = async <T>(
	db: Db,
	op: (tx: Db) => Promise<T>,
): Promise<{status: 'fulfilled'; value: T} | {status: 'rejected'; reason: unknown}> => {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const value = await db.transaction(op);
			return {status: 'fulfilled', value};
		} catch (e) {
			const code = (e as {code?: string} | null)?.code;
			if (code === '40P01' && attempt < 2) continue;
			return {status: 'rejected', reason: e};
		}
	}
	throw new Error('unreachable');
};

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg('role_grant_offer_queries.concurrent', (get_db) => {
	test('two concurrent accepts serialize — one inserts, one returns existing', async () => {
		const db = get_db();
		const grantor = await make_account(db, 'grantor_concurrent');
		const recipient = await make_account(db, 'recipient_concurrent');

		const offer = await create_pending_offer(db, grantor, recipient);

		// Launch both transactions before awaiting either — each `db.transaction`
		// acquires a dedicated pool client, so the two run on separate connections.
		// The first to pass `SELECT ... FOR UPDATE` holds the row lock; the second
		// blocks until commit, then reads the already-accepted state.
		const [first, second] = await Promise.all([
			db.transaction((tx) =>
				query_accept_offer(
					{db: tx},
					{offer_id: offer.id, to_account_id: recipient.account_id, actor_id: recipient.actor_id},
				),
			),
			db.transaction((tx) =>
				query_accept_offer(
					{db: tx},
					{offer_id: offer.id, to_account_id: recipient.account_id, actor_id: recipient.actor_id},
				),
			),
		]);

		// Exactly one side inserted the role_grant.
		const created_count = [first, second].filter((r) => r.created).length;
		assert.strictEqual(created_count, 1);
		// Both sides see the same role_grant id.
		assert.strictEqual(first.role_grant.id, second.role_grant.id);
		// Loser emitted no audit events; winner emitted two.
		const winner = first.created ? first : second;
		const loser = first.created ? second : first;
		assert.strictEqual(winner.created, true);
		assert.strictEqual(loser.created, false);
		assert.strictEqual(winner.audit_events.length, 2);
		assert.strictEqual(loser.audit_events.length, 0);
		// Loser must observe the same actor on the role_grant it returns —
		// same-actor idempotent path through `locked.accepted_at` (the
		// multi-actor mismatch guard at `role_grant_offer_queries.ts:501-503`
		// would throw if it bound to a different actor).
		assert.strictEqual(winner.role_grant.actor_id, recipient.actor_id);
		assert.strictEqual(loser.role_grant.actor_id, recipient.actor_id);
		// Loser path must not double-emit supersede side effects.
		assert.strictEqual(loser.superseded_offers.length, 0);
	});

	test('concurrent role_grant_revoke + offer_accept never leaves an active role_grant at the tuple', async () => {
		// Setup: role_grant P active at (recipient.actor, 'teacher', null); pending
		// sibling offer O at the same tuple from the same grantor (the partial
		// pending-unique index keys on `from_actor_id` so an active role_grant
		// from a prior grant doesn't block a fresh pending offer).
		const db = get_db();
		const grantor = await make_account(db, 'race_revoke_grantor');
		const recipient = await make_account(db, 'race_revoke_recipient');

		const role_grant = await query_create_role_grant(
			{db},
			{actor_id: recipient.actor_id, role: 'teacher', granted_by: grantor.actor_id},
		);
		const offer = await create_pending_offer(db, grantor, recipient);

		// Launch both transactions before awaiting either — `db.transaction`
		// acquires a dedicated pool client, so they run on separate connections
		// and the cross-tx row-lock contention is real.
		const [revoke_result, accept_result] = await Promise.all([
			run_with_deadlock_retry(db, (tx) =>
				query_revoke_role_grant(
					{db: tx},
					role_grant.id,
					recipient.actor_id,
					grantor.actor_id,
					'race-test',
				),
			),
			run_with_deadlock_retry(db, (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: offer.id,
						to_account_id: recipient.account_id,
						actor_id: recipient.actor_id,
					},
				),
			),
		]);

		// Contract: across every interleaving the user must NOT end with an
		// active role_grant at the tuple. `query_revoke_role_grant`'s sibling-supersede
		// CTE forecloses the "accept a pre-revoke offer to bypass the revoke"
		// path in one direction; `query_accept_offer`'s `INSERT ... ON CONFLICT`
		// against the partial unique index forecloses it in the other (the
		// only role_grant it can resolve at the tuple is the one being revoked).
		const active_at_tuple = await db.query<{id: string}>(
			`SELECT id FROM role_grant
			 WHERE actor_id = $1
			   AND role = $2
			   AND scope_id IS NULL
			   AND revoked_at IS NULL`,
			[recipient.actor_id, 'teacher'],
		);
		assert.strictEqual(
			active_at_tuple.length,
			0,
			'no active role_grant should remain at (recipient.actor, teacher, null)',
		);

		// Revoke must eventually land — every interleaving on retry ends with
		// the role_grant revoked.
		assert.strictEqual(revoke_result.status, 'fulfilled', 'revoke must succeed (with retry)');

		// Accept either succeeds (offer points to the now-revoked role_grant) or
		// surfaces `RoleGrantOfferAlreadyTerminalError` (revoke's supersede won).
		if (accept_result.status === 'rejected') {
			const name = (accept_result.reason as {name?: string} | null)?.name;
			assert.strictEqual(
				name,
				'RoleGrantOfferAlreadyTerminalError',
				'accept failure must be the AlreadyTerminal supersede path',
			);
			// Offer row should carry `superseded_at`.
			const row = await db.query_one<{superseded_at: string | null}>(
				`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
				[offer.id],
			);
			assert.ok(row?.superseded_at, 'superseded_at should be stamped');
		} else {
			// Accept succeeded — but only because it resolved to the (about-to-be
			// or already-revoked) role_grant P, not a fresh role_grant at the tuple.
			assert.strictEqual(
				accept_result.value.role_grant.id,
				role_grant.id,
				'accept must resolve to the existing role_grant P (no fresh role_grant can land at the tuple)',
			);
			// Offer is accepted, resulting_role_grant_id points to P.
			const row = await db.query_one<{
				accepted_at: string | null;
				resulting_role_grant_id: string | null;
			}>(`SELECT accepted_at, resulting_role_grant_id FROM role_grant_offer WHERE id = $1`, [
				offer.id,
			]);
			assert.ok(row, 'offer row should exist');
			assert.ok(row.accepted_at, 'accepted_at should be stamped');
			assert.strictEqual(row.resulting_role_grant_id, role_grant.id);
		}
	});
});
