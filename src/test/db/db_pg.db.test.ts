/**
 * `create_pg_pool`'s checkout bound against the installed pg-pool, on real
 * Postgres — skipped unless `TEST_DATABASE_URL` is set.
 *
 * Every case holds the pool's one client so a checkout must wait, then reads
 * what the wait answers: a `DbCheckoutError` once the bound passes (on a
 * per-statement `query` and a transaction's `connect` alike), a statement under
 * a longer per-call bound (`Db.with_checkout_timeout`) running once the client
 * comes back, and a failed query on a checked-out client staying the driver's
 * error.
 *
 * A transaction whose statement failed with the error swallowed has nothing to
 * commit: Postgres answers its `COMMIT` with `ROLLBACK`, and the transaction
 * must throw rather than report success. A transaction whose connection dies
 * mid-statement throws that statement's error, not the failed `ROLLBACK`'s,
 * and a connection lost there or while idle in the pool ends no process.
 *
 * @module
 */

import { describe, assert, test, afterEach } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_pg_db,
	create_pg_pool,
	register_pg_type_parsers,
	type DbCheckoutPool
} from '#lib/db/db_pg.ts';
import { is_db_checkout_error } from '#lib/db/db_checkout_error.ts';
import { pg_error_code } from '#lib/db/pg_error.ts';

const url = process.env.TEST_DATABASE_URL;

/** A pool of one client whose checkouts give up after `checkout_timeout_ms`. */
const create_one_client_pool = async (
	checkout_timeout_ms: number,
	log?: Pick<Logger, 'warn'>
): Promise<DbCheckoutPool> => {
	const { default: pg } = await import('pg');
	await register_pg_type_parsers();
	const pool = create_pg_pool(pg, { connection_string: url!, checkout_timeout_ms, log });
	// one client, so a held checkout leaves the next one waiting (test-only:
	// production keeps pg-pool's default size)
	pool.options.max = 1;
	return pool;
};

const pools: Array<DbCheckoutPool> = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.end();
});

describe.skipIf(!url)('create_pg_pool — the checkout bound', () => {
	test('a statement waiting past the bound throws DbCheckoutError', async () => {
		const pool = await create_one_client_pool(50);
		pools.push(pool);
		const { db } = create_pg_db(pool);
		const held = await pool.connect();
		try {
			const started = Date.now();
			const err = await assert_rejects(() => db.query('SELECT 1'));
			assert.ok(is_db_checkout_error(err), String(err));
			assert.isBelow(Date.now() - started, 2_000, 'it gave up at the bound');
			// a transaction checks out through the same `connect`
			const tx_err = await assert_rejects(() => db.transaction(async () => undefined));
			assert.ok(is_db_checkout_error(tx_err), String(tx_err));
		} finally {
			held.release();
		}
		// the pool still serves once the client is back
		assert.deepStrictEqual(await db.query<{ n: number }>('SELECT 1 AS n'), [{ n: 1 }]);
	});

	test('with_checkout_timeout lends one statement a longer wait on the same pool', async () => {
		const pool = await create_one_client_pool(50);
		pools.push(pool);
		const { db } = create_pg_db(pool);
		const held = await pool.connect();
		const waiting = db.with_checkout_timeout(5_000).query<{ n: number }>('SELECT 2 AS n');
		await new Promise((resolve) => setTimeout(resolve, 300));
		held.release();
		assert.deepStrictEqual(await waiting, [{ n: 2 }], 'it outlasted the pool bound');
		// the pool's own bound is back for everyone else
		const again = await pool.connect();
		try {
			const err = await assert_rejects(() => db.query('SELECT 1'));
			assert.ok(is_db_checkout_error(err), 'the lent bound did not stick');
		} finally {
			again.release();
		}
	});

	test('a failed query on a checked-out client is the driver error, not a checkout failure', async () => {
		const pool = await create_one_client_pool(5_000);
		pools.push(pool);
		const { db } = create_pg_db(pool);
		const err = await assert_rejects(() => db.query('SELECT * FROM no_such_table_here'));
		assert.ok(!is_db_checkout_error(err), String(err));
	});
});

describe.skipIf(!url)('create_pg_db — transactions', () => {
	test('a swallowed statement failure throws at COMMIT', async () => {
		const pool = await create_one_client_pool(5_000);
		pools.push(pool);
		const { db } = create_pg_db(pool);
		const err = await assert_rejects(() =>
			db.transaction(async (tx_db) => {
				// the failure aborts the transaction; the swallowed error hides it
				await tx_db.query('SELECT 1 / 0').catch(() => undefined);
				return 'done';
			})
		);
		assert.include(err.message, 'transaction aborted before COMMIT');
		// the client went back to the pool clean
		assert.deepStrictEqual(await db.query<{ n: number }>('SELECT 1 AS n'), [{ n: 1 }]);
	});

	test('a connection killed mid-transaction surfaces its own error, not the failed ROLLBACK', async () => {
		const pool = await create_one_client_pool(5_000);
		pools.push(pool);
		// no listener of the test's own: an unheard `error` would fail the run
		const removed = new Promise((resolve) => pool.once('remove', resolve));
		const { db } = create_pg_db(pool);
		const { default: pg } = await import('pg');
		const killer = new pg.Client({ connectionString: url });
		await killer.connect();
		try {
			const err = await assert_rejects(() =>
				db.transaction(async (tx_db) => {
					const [row] = await tx_db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
					const sleeping = tx_db.query('SELECT pg_sleep(30)');
					// handled now: the kill may reject it before the killer's own answer arrives
					sleeping.catch(() => {});
					await killer.query('SELECT pg_terminate_backend($1)', [row!.pid]);
					await sleeping;
				})
			);
			// 57P01 admin_shutdown — the statement's own error, not pg's "not queryable"
			assert.strictEqual(pg_error_code(err), '57P01', String(err));
			await removed;
		} finally {
			await killer.end();
		}
		// the dead client was discarded: the pool's next checkout is a live one
		assert.deepStrictEqual(await db.query<{ n: number }>('SELECT 1 AS n'), [{ n: 1 }]);
	});

	test('an idle client losing its connection is reported, and the next query connects afresh', async () => {
		const warnings: Array<string> = [];
		const pool = await create_one_client_pool(5_000, {
			warn: (...args: Array<unknown>) => warnings.push(args.join(' '))
		});
		pools.push(pool);
		const { db } = create_pg_db(pool);
		const [row] = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
		const removed = new Promise((resolve) => pool.once('remove', resolve));
		const { default: pg } = await import('pg');
		const killer = new pg.Client({ connectionString: url });
		await killer.connect();
		try {
			// the client sits idle in the pool; no listener of the test's own
			await killer.query('SELECT pg_terminate_backend($1)', [row!.pid]);
			await removed;
		} finally {
			await killer.end();
		}
		assert.strictEqual(warnings.length, 1, 'the lost connection was reported once');
		assert.include(warnings[0], 'lost its connection while idle');
		const [next] = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
		assert.notStrictEqual(next!.pid, row!.pid, 'a fresh connection');
	});
});
