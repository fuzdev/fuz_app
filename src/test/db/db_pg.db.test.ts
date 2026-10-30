/**
 * `create_pg_db` against real Postgres — skipped unless `TEST_DATABASE_URL` is
 * set.
 *
 * A transaction whose statement failed with the error swallowed has nothing to
 * commit: Postgres answers its `COMMIT` with `ROLLBACK`, and the transaction
 * must throw rather than report success.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_pg_db, register_pg_type_parsers } from '#lib/db/db_pg.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('create_pg_db — transactions', () => {
	test('a swallowed statement failure throws at COMMIT', async () => {
		const { default: pg } = await import('pg');
		await register_pg_type_parsers();
		const pool = new pg.Pool({ connectionString: url, max: 1 });
		try {
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
		} finally {
			await pool.end();
		}
	});
});
