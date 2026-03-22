/**
 * PostgreSQL driver adapter for `Db`.
 *
 * Provides `create_pg_db()` to construct a `Db` backed by a `pg.Pool`.
 * Only imports `pg` types — the actual `pg` package is dynamically imported
 * by callers (e.g., `create_db`) that construct the `Pool`.
 *
 * @module
 */

import type {Pool} from 'pg';

import {Db, no_nested_transaction, type DbDriverResult} from './db.js';

/**
 * Create a transaction implementation for a pg Pool.
 *
 * Acquires a dedicated client from the pool for each transaction,
 * ensuring BEGIN/COMMIT/ROLLBACK all hit the same connection.
 */
const create_pg_transaction =
	(pool: Pool) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> => {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const tx_db = new Db({client, transaction: no_nested_transaction});
			const result = await fn(tx_db);
			await client.query('COMMIT');
			return result;
		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
	};

/**
 * Create a `Db` backed by a pg `Pool`.
 *
 * Owns the transaction implementation (acquires a dedicated pool client
 * per transaction) and returns a `close` callback bound to `pool.end()`.
 *
 * @param pool - an already-constructed `pg.Pool`
 */
export const create_pg_db = (pool: Pool): DbDriverResult => ({
	db: new Db({client: pool, transaction: create_pg_transaction(pool)}),
	close: () => pool.end(),
});
