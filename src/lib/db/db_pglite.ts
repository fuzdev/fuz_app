/**
 * PGlite driver adapter for `Db`.
 *
 * Provides `create_pglite_db()` to construct a `Db` backed by `@electric-sql/pglite`.
 * Only imports PGlite types — the actual package is dynamically imported
 * by callers (e.g., `create_db`) that construct the `PGlite` instance.
 *
 * @module
 */

import type {PGlite} from '@electric-sql/pglite';

import {Db, no_nested_transaction, type DbDriverResult} from './db.js';

/**
 * Create a transaction implementation for PGlite.
 *
 * Delegates to PGlite's native `transaction()` method.
 */
const create_pglite_transaction =
	(pglite: PGlite) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> =>
		pglite.transaction(async (tx) => fn(new Db({client: tx, transaction: no_nested_transaction})));

/**
 * Create a `Db` backed by a PGlite instance.
 *
 * Delegates transactions to PGlite's native `transaction()` method
 * and returns a `close` callback bound to `pglite.close()`.
 *
 * @param pglite - an already-constructed PGlite instance
 */
export const create_pglite_db = (pglite: PGlite): DbDriverResult => ({
	db: new Db({client: pglite, transaction: create_pglite_transaction(pglite)}),
	close: () => pglite.close(),
});
