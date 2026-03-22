/**
 * Database wrapper with duck-typed interface.
 *
 * Accepts any client with a query(text, values) method.
 * Both `pg.Pool` and `@electric-sql/pglite` satisfy this interface.
 *
 * Transaction safety is provided by an injected `transaction` callback —
 * the driver adapters (`db_pg.ts`, `db_pglite.ts`) supply the driver-appropriate
 * implementation. Close is handled externally (returned alongside the Db
 * as `DbDriverResult`), not as a method on this class.
 *
 * @module
 */

/**
 * Minimal interface that both pg and pglite satisfy.
 */
export interface DbClient {
	query: <T = unknown>(text: string, values?: Array<unknown>) => Promise<{rows: Array<T>}>;
}

/**
 * Configuration for constructing a `Db` with transaction support.
 *
 * `transaction` is injected by `create_db` which knows the driver.
 * For pg: acquires a dedicated pool client per transaction.
 * For PGlite: delegates to `pglite.transaction()`.
 */
export interface DbDeps {
	client: DbClient;
	transaction: <T>(fn: (tx_db: Db) => Promise<T>) => Promise<T>;
}

/**
 * Result of constructing a driver-specific `Db`.
 *
 * Returned by `create_pg_db()` and `create_pglite_db()`.
 * The `close` callback is bound to the actual driver — callers
 * never need to know which driver is in use.
 */
export interface DbDriverResult {
	db: Db;
	/** Close the database connection. Bound to the actual driver at construction. */
	close: () => Promise<void>;
}

/** Database driver type. */
export type DbType = 'postgres' | 'pglite-file' | 'pglite-memory';

/**
 * Sentinel transaction function for transaction-scoped `Db` instances.
 *
 * Throws immediately — nested transactions are not supported.
 * Used by driver adapters when constructing the inner `Db` passed
 * to transaction callbacks.
 */
export const no_nested_transaction: DbDeps['transaction'] = () => {
	throw new Error('Nested transactions are not supported');
};

/**
 * Database wrapper providing a consistent query and transaction interface.
 *
 * Construct via `create_pg_db()` from `db_pg.ts` or `create_pglite_db()` from
 * `db_pglite.ts` for proper transaction support, or via `create_db()` for
 * URL-based auto-detection.
 *
 * @example
 * ```ts
 * const {db, close} = await create_db('postgres://...');
 * const users = await db.query<User>('SELECT * FROM users WHERE active = $1', [true]);
 * await db.transaction(async (tx) => {
 *   await tx.query('INSERT INTO users ...');
 *   await tx.query('INSERT INTO audit_log ...');
 * });
 * await close();
 * ```
 */
export class Db {
	readonly client: DbClient;

	readonly #transaction: <T>(fn: (tx_db: Db) => Promise<T>) => Promise<T>;

	constructor(options: DbDeps) {
		this.client = options.client;
		this.#transaction = options.transaction;
	}

	/**
	 * Execute a query and return all rows.
	 */
	async query<T>(text: string, values?: Array<unknown>): Promise<Array<T>> {
		const result = await this.client.query<T>(text, values);
		return result.rows;
	}

	/**
	 * Execute a query and return the first row, or undefined if no rows.
	 */
	async query_one<T>(text: string, values?: Array<unknown>): Promise<T | undefined> {
		const rows = await this.query<T>(text, values);
		return rows[0];
	}

	/**
	 * Run a function inside a database transaction.
	 *
	 * The callback receives a transaction-scoped `Db`. Queries inside the callback
	 * go through the transaction connection; queries outside use the pool normally.
	 * Commits on success, rolls back on error.
	 *
	 * @param fn - async function receiving a transaction-scoped `Db`
	 * @returns the value returned by `fn`
	 */
	async transaction<T>(fn: (tx_db: Db) => Promise<T>): Promise<T> {
		return this.#transaction(fn);
	}
}
