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
 * without auto-detection, use `db/db_pg.ts` or `db/db_pglite.ts`.
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
 * The `close` callback is bound to the actual driver — callers never need to
 * know which driver is in use.
 *
 * For direct driver construction without URL routing, import
 * `create_pg_db` from `db/db_pg.ts` or `create_pglite_db` from `db/db_pglite.ts`.
 *
 * @param database_url - connection URL (`postgres://`, `postgresql://`, `file://`, or `memory://`)
 * @returns database instance, close callback, type, and display name
 * @throws Error if `database_url` uses an unsupported scheme. Driver
 *   construction (`pg.Pool` or `PGlite`) may also throw on bad connection
 *   parameters or missing peer-dependency packages.
 */
export const create_db = async (database_url: string): Promise<CreateDbResult> => {
	if (database_url.startsWith('postgres://') || database_url.startsWith('postgresql://')) {
		const {default: pg} = await import('pg');
		// Parse int8 (BIGINT) as a JS number. pg defaults to returning int8
		// as a string to avoid 2^53 precision loss; our only int8 column
		// today (`audit_log.seq`) stays well under that bound, and reading
		// as number keeps the wire shape uniform across the SERIAL→BIGSERIAL
		// widening.
		//
		// CAVEAT: pg.types.setTypeParser mutates pg.types globally — every
		// pg.Pool in the process inherits the coercion, including pools the
		// consumer constructs against unrelated databases. Any future int8
		// column that could legitimately exceed 2^53 (file sizes, byte
		// offsets) will silently round; if one lands, localize via a
		// per-pool `types` override instead of widening this global parser.
		pg.types.setTypeParser(20, (val) => Number(val));
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
