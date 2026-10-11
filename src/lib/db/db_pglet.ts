/**
 * pglet driver adapter for `Db`.
 *
 * Provides `create_pglet_instance()`, which loads `@fuzdev/pglet-wasm` on
 * demand and creates an in-memory instance with `PGLET_COERCION`, the value
 * coercion every fuz_app pglet instance is created with, and
 * `create_pglet_db_driver()` to construct a `Db` backed by one. The package is
 * imported dynamically, so it stays an optional peer.
 *
 * @module
 */

import type { CoercionOptions, PgletDb } from '@fuzdev/pglet-wasm';

import { Db, no_nested_transaction, type DbDriverResult } from './db.ts';

/**
 * The value coercion fuz_app creates every pglet instance with.
 *
 * The adapter defaults int8 to `bigint`; fuz_app reads int8 as a JS number on
 * every driver (`register_pg_type_parsers` for `pg`, PGlite's own default), so
 * `AuditLogEvent.seq` and friends validate identically across drivers.
 */
export const PGLET_COERCION: CoercionOptions = { int8: 'number' };

/**
 * Create an in-memory pglet instance with `PGLET_COERCION`.
 *
 * Loads `@fuzdev/pglet-wasm` on demand and awaits its `init()` — a no-op on the
 * package's Node entry, where the wasm loads at import; the browser entry loads
 * it here.
 *
 * @returns a fresh, empty instance; wrap it with `create_pglet_db_driver`
 */
export const create_pglet_instance = async (): Promise<PgletDb> => {
	const pglet_wasm = await import('@fuzdev/pglet-wasm');
	await pglet_wasm.init();
	return pglet_wasm.create_pglet_db({ coercion: PGLET_COERCION });
};

/**
 * Create a transaction implementation for pglet.
 *
 * Delegates to the adapter's single-flight `transaction()` (`BEGIN` / `COMMIT`,
 * `ROLLBACK` on throw).
 */
const create_pglet_transaction =
	(pglet: PgletDb) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> =>
		pglet.transaction(async (tx) => fn(new Db({ client: tx, transaction: no_nested_transaction })));

/**
 * Create a `Db` backed by a pglet instance.
 *
 Named `_driver` to stay clear of `@fuzdev/pglet-wasm`'s own `create_pglet_db`,
 * which creates the instance this wraps. Create it with `create_pglet_instance`
 * (or with `PGLET_COERCION`) so it reads values as the other drivers do.
 *
 * @param pglet - a `@fuzdev/pglet-wasm` instance
 * @returns the `Db` instance and a `close` callback bound to `pglet.close()`
 */
export const create_pglet_db_driver = (pglet: PgletDb): DbDriverResult => ({
	db: new Db({ client: pglet, transaction: create_pglet_transaction(pglet) }),
	close: () => pglet.close()
});
