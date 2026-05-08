/**
 * Concurrent-accept race test for `query_accept_offer`.
 *
 * True `SELECT FOR UPDATE` serialization requires two concurrent transactions
 * against a real `pg` pool — PGlite runs transactions serially so the
 * idempotent-loser branch that matters here (`locked.accepted_at` already set)
 * is only reachable with real connection-level concurrency. Runs against
 * `pg_factory` only; skipped when `TEST_DATABASE_URL` is unset.
 *
 * @module
 */

import {assert, test} from 'vitest';

import {query_accept_offer} from '$lib/auth/permit_offer_queries.js';
import {create_describe_db, AUTH_INTEGRATION_TRUNCATE_TABLES} from '$lib/testing/db.js';

import {pg_factory} from '../db_fixture.js';
import {make_account, create_pending_offer} from './permit_offer_queries.fixtures.js';

const describe_pg = create_describe_db(pg_factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

describe_pg('permit_offer_queries.concurrent', (get_db) => {
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

		// Exactly one side inserted the permit.
		const created_count = [first, second].filter((r) => r.created).length;
		assert.strictEqual(created_count, 1);
		// Both sides see the same permit id.
		assert.strictEqual(first.permit.id, second.permit.id);
		// Loser emitted no audit events; winner emitted two.
		const winner = first.created ? first : second;
		const loser = first.created ? second : first;
		assert.strictEqual(winner.created, true);
		assert.strictEqual(loser.created, false);
		assert.strictEqual(winner.audit_events.length, 2);
		assert.strictEqual(loser.audit_events.length, 0);
		// Loser must observe the same actor on the permit it returns —
		// same-actor idempotent path through `locked.accepted_at` (the
		// multi-actor mismatch guard at `permit_offer_queries.ts:501-503`
		// would throw if it bound to a different actor).
		assert.strictEqual(winner.permit.actor_id, recipient.actor_id);
		assert.strictEqual(loser.permit.actor_id, recipient.actor_id);
		// Loser path must not double-emit supersede side effects.
		assert.strictEqual(loser.superseded_offers.length, 0);
	});
});
