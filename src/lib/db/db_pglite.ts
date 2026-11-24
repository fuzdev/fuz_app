/**
 * PGlite driver adapter for `Db`.
 *
 * Provides `create_pglite_db()` to construct a `Db` backed by `@electric-sql/pglite`.
 * Only imports PGlite types — the actual package is dynamically imported
 * by callers (e.g., `create_db`) that construct the `PGlite` instance.
 *
 * @module
 */

import type { PGlite } from '@electric-sql/pglite';

import { Db, no_nested_transaction, type DbDriverResult } from './db.ts';

/**
 * Create a transaction implementation for PGlite.
 *
 * Delegates to PGlite's native `transaction()` method, keeping the error `fn`
 * threw: PGlite's own `ROLLBACK` on throw, when it fails too (an instance
 * closed or aborted mid-transaction), would replace it with its own.
 */
const create_pglite_transaction =
	(pglite: PGlite) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> => {
		let thrown: { err: unknown } | undefined;
		try {
			return await pglite.transaction(async (tx) => {
				try {
					return await fn(new Db({ client: tx, transaction: no_nested_transaction }));
				} catch (err) {
					thrown = { err };
					throw err;
				}
			});
		} catch (err) {
			throw thrown ? thrown.err : err;
		}
	};

/**
 * Create a `Db` backed by a `PGlite` instance.
 *
 * Delegates transactions to PGlite's native `transaction()` method.
 *
 * @param pglite - an already-constructed `PGlite` instance
 * @returns the `Db` instance and a `close` callback bound to `pglite.close()`
 */
export const create_pglite_db = (pglite: PGlite): DbDriverResult => ({
	db: new Db({ client: pglite, transaction: create_pglite_transaction(pglite) }),
	close: () => pglite.close()
});
