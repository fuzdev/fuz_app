/**
 * The expiry sweep takes the sessions it deletes in id order, as every
 * multi-row credential delete does, so it never holds one row while waiting on
 * another a revoke or an eviction took first.
 *
 * The order is pinned by seeding the heap order against it: the highest id
 * inserted first and expiring first, so a plan walking the rows as stored or
 * by expiry reaches it first. A transaction holds the lowest row, the sweep
 * runs, then the holder takes the highest: an id-ordered sweep waits on the
 * lowest holding neither, and both commit; any other order holds the highest
 * and deadlocks.
 *
 * Real `pg` only (`TEST_DATABASE_URL`): the in-memory drivers have one
 * connection, so the sweep would queue behind the holder whatever it locks.
 * The spines serve no sweep over the wire, so this is its pin where the other
 * credential deletes have theirs in `cross_backend/lock_pins.cross.test.ts`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import { query_session_cleanup_expired } from '#lib/auth/session_queries.ts';
import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';
import type { Db } from '#lib/db/db.ts';

import { pg_factory } from '../db_fixture.ts';

const LOW = '0'.repeat(64);
const HIGH = 'f'.repeat(64);

/** How long the sweep may take to show it waits, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const lock_waiters = async (db: Db): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM pg_stat_activity
				 WHERE wait_event_type = 'Lock' AND datname = current_database()`
			)
		)[0]!.n
	);

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg('the expiry sweep takes its rows in id order', (get_db) => {
	test('a sweep across a holder of its lowest row, which then takes its highest: both commit', async () => {
		const db = get_db();
		const { account } = await query_create_account_with_actor(
			{ db },
			{ username: 'sweep_order', password_hash: 'hash' }
		);
		for (const [id, minutes] of [
			[HIGH, 20],
			[LOW, 10]
		] as const) {
			await db.query(
				`INSERT INTO auth_session (id, account_id, expires_at)
				 VALUES ($1, $2, NOW() - make_interval(mins => $3))`,
				[id, account.id, minutes]
			);
		}
		const take_high = Promise.withResolvers<void>();
		const holder = db.transaction(async (tx) => {
			await tx.query(`SELECT id FROM auth_session WHERE id = $1 FOR UPDATE`, [LOW]);
			await take_high.promise;
			await tx.query(`SELECT id FROM auth_session WHERE id = $1 FOR UPDATE`, [HIGH]);
		});
		const swept = db.transaction((tx) => query_session_cleanup_expired({ db: tx }));
		const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
		while ((await lock_waiters(db)) < 1) {
			assert.ok(Date.now() < deadline, 'the sweep waits on the lowest row');
			await wait(5);
		}
		take_high.resolve();
		await holder;
		assert.deepStrictEqual((await swept).toSorted(), [LOW, HIGH]);
	});
});
