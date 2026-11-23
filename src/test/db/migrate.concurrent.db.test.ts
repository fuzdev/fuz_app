/**
 * Concurrent migration runs over one Postgres database: the namespace's
 * advisory lock serializes them, so two boots both succeed, and a boot waits
 * on the lock the Rust spine's runner holds — a session `pg_advisory_lock` on
 * the same `bigint` key.
 *
 * Real `pg` only (`TEST_DATABASE_URL`): the in-memory drivers have one
 * connection and run one transaction at a time, so nothing there races.
 *
 * @module
 */

import { assert, test } from 'vitest';

import type { Db } from '#lib/db/db.ts';
import { run_migrations, type Migration } from '#lib/db/migrate.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';

import { pg_factory } from '../db_fixture.ts';

/** How long a waiting runner may take to show it waits, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const describe_pg = create_describe_db(pg_factory, []);

const drop_namespace = async (db: Db, namespace: string, table: string): Promise<void> => {
	await db.query(`DROP TABLE IF EXISTS ${table}`);
	await db.query('DELETE FROM schema_version WHERE namespace = $1', [namespace]);
};

/** Ungranted advisory locks on `key` — a session waiting for it. */
const advisory_waiters = async (db: Db, key: number): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM pg_locks
				 WHERE locktype = 'advisory' AND NOT granted
				   AND classid = (($1::bigint >> 32) & 4294967295)::oid
				   AND objid = ($1::bigint & 4294967295)::oid
				   AND objsubid = 1`,
				[key]
			)
		)[0]!.n
	);

describe_pg('concurrent migration runs', (get_db) => {
	test('two runners on one namespace at once both succeed, and one applies', async () => {
		const db = get_db();
		const namespace = 'migrate_concurrent_ns';
		await drop_namespace(db, namespace, 'migrate_concurrent_t');
		// the sleep holds each chain open after its DDL, so the two overlap: unlocked,
		// both would run the CREATE TABLE and the loser fail on the catalog's index
		const migrations: Array<Migration> = [
			{
				name: 'create_concurrent',
				up: async (tx) => {
					await tx.query('CREATE TABLE migrate_concurrent_t (id INT)');
					await tx.query('SELECT pg_sleep(0.3)');
				}
			}
		];

		const results = await Promise.all([
			run_migrations(db, [{ namespace, migrations }]),
			run_migrations(db, [{ namespace, migrations }])
		]);

		assert.deepStrictEqual(
			results.flat().flatMap((r) => r.applied_names),
			['create_concurrent']
		);
		await drop_namespace(db, namespace, 'migrate_concurrent_t');
	});

	test("a runner waits on the Rust runner's session lock on the same key", async () => {
		const db = get_db();
		const namespace = 'migrate_lock_wait_ns';
		// djb2 of the namespace, negative, so the key's sign extension is pinned too
		const key = -708_565_142;
		await drop_namespace(db, namespace, 'migrate_lock_wait_t');
		const migrations: Array<Migration> = [
			{
				name: 'create_lock_wait',
				up: async (tx) => {
					await tx.query('CREATE TABLE migrate_lock_wait_t (id INT)');
				}
			}
		];

		let runner_done = false;
		let runner: Promise<unknown> | undefined;
		// the holder runs on one client, as the Rust runner does: lock, wait, unlock
		await db.transaction(async (holder) => {
			await holder.query('SELECT pg_advisory_lock($1::bigint)', [key]);
			runner = run_migrations(db, [{ namespace, migrations }]).finally(() => {
				runner_done = true;
			});
			try {
				const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
				while ((await advisory_waiters(db, key)) === 0) {
					assert.ok(!runner_done, 'the runner finished while the lock was held');
					assert.ok(Date.now() < deadline, 'the runner never waited on the lock');
					await new Promise((r) => setTimeout(r, 25));
				}
				assert.ok(!runner_done);
			} finally {
				// a session lock outlives the transaction, so release it however the wait ended
				await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
			}
		});

		assert.deepStrictEqual(await runner, [{ namespace, applied_names: ['create_lock_wait'] }]);
		await drop_namespace(db, namespace, 'migrate_lock_wait_t');
	});
});
