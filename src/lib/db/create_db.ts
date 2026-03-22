/**
 * Database initialization with driver auto-detection.
 *
 * Selects the appropriate database driver based on `database_url`:
 * - `postgres://` or `postgresql://` — uses `pg` (PostgreSQL)
 * - `file://` — uses `@electric-sql/pglite` (file-based)
 * - `memory://` — uses `@electric-sql/pglite` (in-memory)
 *
 * Both `pg` and `@electric-sql/pglite` are optional peer dependencies,
 * dynamically imported only when needed. For direct driver construction
 * without auto-detection, use `db_pg.ts` or `db_pglite.ts`.
 *
 * @module
 */

import type {Db, DbType} from './db.js';
import {create_pg_db} from './db_pg.js';
import {create_pglite_db} from './db_pglite.js';

/** Result of database initialization. */
export interface CreateDbResult {
	db: Db;
	/** Close the database connection. Bound to the actual driver at construction. */
	close: () => Promise<void>;
	db_type: DbType;
	db_name: string;
}

/**
 * Create a database connection based on a URL.
 *
 * Returns the `Db` instance, a typed `close` callback, driver type, and display name.
 * The `close` callback is bound to the actual driver — callers never need to
 * know which driver is in use.
 *
 * For direct driver construction without URL routing, import
 * `create_pg_db` from `db_pg.ts` or `create_pglite_db` from `db_pglite.ts`.
 *
 * @param database_url - connection URL (`postgres://`, `postgresql://`, `file://`, or `memory://`)
 * @returns database instance, close callback, type, and display name
 */
export const create_db = async (database_url: string): Promise<CreateDbResult> => {
	if (database_url.startsWith('postgres://') || database_url.startsWith('postgresql://')) {
		const {default: pg} = await import('pg');
		const pool = new pg.Pool({connectionString: database_url});
		const {db, close} = create_pg_db(pool);
		return {
			db,
			close,
			db_type: 'postgres',
			db_name: new URL(database_url).pathname.slice(1) || 'postgres',
		};
	}

	if (database_url.startsWith('memory://')) {
		const {PGlite} = await import('@electric-sql/pglite');
		const pglite = new PGlite(database_url);
		const {db, close} = create_pglite_db(pglite);
		return {db, close, db_type: 'pglite-memory', db_name: '(memory)'};
	}

	if (database_url.startsWith('file://')) {
		const path = new URL(database_url).pathname;
		const {PGlite} = await import('@electric-sql/pglite');
		const pglite = new PGlite(path);
		const {db, close} = create_pglite_db(pglite);
		return {db, close, db_type: 'pglite-file', db_name: path};
	}

	const scheme = database_url.split('://')[0] ?? database_url;
	throw new Error(
		`Unsupported database URL scheme: ${scheme}://. Expected postgres://, postgresql://, file://, or memory://`,
	);
};
