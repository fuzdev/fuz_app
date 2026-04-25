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

import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
import {query_permit_offer_create, query_accept_offer} from '$lib/auth/permit_offer_queries.js';
import {create_describe_db, AUTH_INTEGRATION_TRUNCATE_TABLES} from '$lib/testing/db.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import type {Db} from '$lib/db/db.js';

import {pg_factory} from '../db_fixture.js';

interface TestAccount {
	account_id: Uuid;
	actor_id: Uuid;
}

const make_account = async (db: Db, username: string): Promise<TestAccount> => {
	const deps = {db};
	const {account, actor} = await query_create_account_with_actor(deps, {
		username,
		password_hash: 'hash',
	});
	return {account_id: account.id, actor_id: actor.id};
};

const future = (ms_from_now: number): Date => new Date(Date.now() + ms_from_now);
const hour = 60 * 60 * 1000;

const describe_pg = create_describe_db(pg_factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

describe_pg('PermitOfferQueries concurrent accept', (get_db) => {
	test('two concurrent accepts serialize — one inserts, one returns existing', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_concurrent');
		const recipient = await make_account(db, 'recipient_concurrent');

		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});

		// Launch both transactions before awaiting either — each `db.transaction`
		// acquires a dedicated pool client, so the two run on separate connections.
		// The first to pass `SELECT ... FOR UPDATE` holds the row lock; the second
		// blocks until commit, then reads the already-accepted state.
		const [first, second] = await Promise.all([
			db.transaction((tx) =>
				query_accept_offer({db: tx}, {offer_id: offer.id, to_account_id: recipient.account_id}),
			),
			db.transaction((tx) =>
				query_accept_offer({db: tx}, {offer_id: offer.id, to_account_id: recipient.account_id}),
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
		assert.strictEqual(winner.audit_events.length, 2);
		assert.strictEqual(loser.audit_events.length, 0);
	});
});
