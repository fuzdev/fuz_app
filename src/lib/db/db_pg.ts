/**
 * PostgreSQL driver adapter for `Db`.
 *
 * Provides `create_pg_db()` to construct a `Db` backed by a `pg.Pool`.
 * Statically imports only `pg` types; the `pg` runtime is dynamically
 * imported where needed — by callers (e.g., `create_db`) that construct the
 * `Pool`, and by `register_pg_type_parsers` to reach `pg.types`. pglite-only
 * consumers never reach either path, so `pg` stays an optional peer dep.
 *
 * @module
 */

import type { Pool } from 'pg';

import { Db, no_nested_transaction, type DbDriverResult } from './db.ts';

/**
 * Register the shared pg type-parser overrides on the module-global `pg.types`.
 *
 * Dynamically imports the `pg` runtime (so pglite-only consumers, who never
 * call this, don't need `pg` installed) and coerces int8 (`BIGINT`, OID 20)
 * to a JS number. pg defaults to returning
 * int8 as a string to avoid 2^53 precision loss; our int8 columns today
 * (`audit_log.seq`, `cell_history.id`, `fact.size`) stay well under that
 * bound, and reading as a number keeps the wire shape uniform with PGlite —
 * which returns int8 as a number — so `AuditLogEvent.seq` and friends
 * validate identically across both drivers.
 *
 * Both `create_db` (production) and the test pg factory (`testing/db.ts`)
 * register through this single site so test and prod read the same shape; a
 * divergence here is exactly the test/prod write-semantics gap the parser
 * exists to close.
 *
 * CAVEAT: `setTypeParser` mutates `pg.types` globally — every `pg.Pool` in
 * the process inherits the coercion, including pools the consumer constructs
 * against unrelated databases. Any future int8 column that could legitimately
 * exceed 2^53 (byte offsets, counters) will silently round; if one lands,
 * localize via a per-pool `types` override instead of widening this global.
 *
 * @mutates `pg.types` - registers the int8 parser on the global pg type registry
 */
export const register_pg_type_parsers = async (): Promise<void> => {
	const { types } = await import('pg');
	types.setTypeParser(20, (val) => Number(val));
};

/**
 * Create a transaction implementation for a `pg.Pool`.
 *
 * Acquires a dedicated client from the pool for each transaction,
 * ensuring `BEGIN` / `COMMIT` / `ROLLBACK` all hit the same connection.
 * Releases the client in `finally` regardless of outcome.
 */
const create_pg_transaction =
	(pool: Pool) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> => {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const tx_db = new Db({ client, transaction: no_nested_transaction });
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
 * Create a `Db` backed by a `pg.Pool`.
 *
 * Owns the transaction implementation, acquiring a dedicated pool client
 * per transaction.
 *
 * @param pool - an already-constructed `pg.Pool`
 * @returns the `Db` instance and a `close` callback bound to `pool.end()`
 */
export const create_pg_db = (pool: Pool): DbDriverResult => ({
	db: new Db({ client: pool, transaction: create_pg_transaction(pool) }),
	close: () => pool.end()
});
