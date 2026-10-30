/**
 * Database initialization with driver auto-detection.
 *
 * Selects the appropriate database driver based on `database_url`:
 * - `postgres://` or `postgresql://` — uses `pg` (PostgreSQL)
 * - `file://` — uses `@electric-sql/pglite` (file-based)
 * - `memory://` — uses `@fuzdev/pglet-wasm` (in-memory)
 *
 * `pg`, `@electric-sql/pglite` and `@fuzdev/pglet-wasm` are optional peer
 * dependencies, dynamically imported only when needed. For direct driver
 * construction without auto-detection, use `db/db_pg.ts`, `db/db_pglite.ts`
 * or `db/db_pglet.ts` — an in-memory PGlite is `create_pglite_db(new PGlite())`.
 *
 * @module
 */

import type { Db, DbType } from './db.ts';
import {
	create_pg_db,
	create_pg_pool,
	DEFAULT_DB_CHECKOUT_TIMEOUT_MS,
	register_pg_type_parsers
} from './db_pg.ts';
import { create_pglite_db } from './db_pglite.ts';
import { create_pglet_db_driver, create_pglet_instance } from './db_pglet.ts';

/** Options for `create_db`. */
export interface CreateDbOptions {
	/**
	 * Bound on every pool checkout, in ms (`db/db_pg.ts`, "Checkout timeout").
	 * Default `DEFAULT_DB_CHECKOUT_TIMEOUT_MS`. Postgres only: PGlite and pglet
	 * have no pool, so it has no effect there.
	 */
	checkout_timeout_ms?: number;
}

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
 * `create_pg_db` from `db/db_pg.ts`, `create_pglite_db` from `db/db_pglite.ts`
 * or `create_pglet_db_driver` from `db/db_pglet.ts`.
 *
 * @param database_url - connection URL (`postgres://`, `postgresql://`, `file://`, or `memory://`)
 * @param options - the pool's checkout bound (Postgres only)
 * @returns database instance, close callback, type, and display name
 * @throws Error if `database_url` uses an unsupported scheme. Driver
 *   construction (`pg.Pool`, `PGlite` or pglet) may also throw on bad connection
 *   parameters or missing peer-dependency packages.
 */
export const create_db = async (
	database_url: string,
	options?: CreateDbOptions
): Promise<CreateDbResult> => {
	if (is_pg_database_url(database_url)) {
		const { default: pg } = await import('pg');
		await register_pg_type_parsers();
		const pool = create_pg_pool(pg, {
			connection_string: database_url,
			checkout_timeout_ms: options?.checkout_timeout_ms ?? DEFAULT_DB_CHECKOUT_TIMEOUT_MS
		});
		const { db, close } = create_pg_db(pool);
		return {
			db,
			close,
			db_type: 'postgres',
			db_name: new URL(database_url).pathname.slice(1) || 'postgres'
		};
	}

	if (database_url.startsWith('memory://')) {
		const { db, close } = create_pglet_db_driver(await create_pglet_instance());
		return { db, close, db_type: 'pglet-memory', db_name: '(memory)' };
	}

	if (database_url.startsWith('file://')) {
		const path = new URL(database_url).pathname;
		const { PGlite } = await import('@electric-sql/pglite');
		const pglite = new PGlite(path);
		const { db, close } = create_pglite_db(pglite);
		return { db, close, db_type: 'pglite-file', db_name: path };
	}

	const scheme = database_url.split('://')[0] ?? database_url;
	throw new Error(
		`Unsupported database URL scheme: ${
			scheme
		}://. Expected postgres://, postgresql://, file://, or memory://`
	);
};

/**
 * Whether `database_url` names a Postgres server — the one driver with a pool.
 *
 * @param database_url - a database URL
 * @returns `true` for `postgres://` and `postgresql://`
 */
export const is_pg_database_url = (database_url: string): boolean =>
	database_url.startsWith('postgres://') || database_url.startsWith('postgresql://');
