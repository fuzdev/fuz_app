/**
 * Database wrapper with duck-typed interface.
 *
 * Accepts any client with a query(text, values) method.
 * `pg.Pool`, `@electric-sql/pglite` and `@fuzdev/pglet-wasm` all satisfy this interface.
 *
 * Transaction safety is provided by an injected `transaction` callback —
 * the driver adapters (`db/db_pg.ts`, `db/db_pglite.ts`, `db/db_pglet.ts`) supply the driver-appropriate
 * implementation. Close is handled externally (returned alongside the `Db`
 * as `DbDriverResult`), not as a method on this class.
 *
 * @module
 */

/**
 * Minimal interface that pg, pglite and pglet satisfy.
 */
export interface DbClient {
	query: <T = unknown>(text: string, values?: Array<unknown>) => Promise<{ rows: Array<T> }>;
}

/**
 * Configuration for constructing a `Db` with transaction support.
 *
 * `transaction` is injected by `create_db` which knows the driver.
 * For `pg`: acquires a dedicated pool client per transaction.
 * For PGlite: delegates to `pglite.transaction()`.
 * For pglet: delegates to the adapter's `transaction()`.
 */
export interface DbDeps {
	client: DbClient;
	transaction: <T>(fn: (tx_db: Db) => Promise<T>) => Promise<T>;
	/**
	 * A `Db` over the same pool whose checkouts are bounded by `timeout_ms` —
	 * supplied by the pg adapter (`create_pg_db`). Omitted where there is no
	 * pool (PGlite, pglet), so `Db.with_checkout_timeout` returns the `Db`
	 * itself.
	 */
	with_checkout_timeout?: (timeout_ms: number) => Db;
}

/**
 * Result of constructing a driver-specific `Db`.
 *
 * Returned by `create_pg_db()`, `create_pglite_db()` and `create_pglet_db_driver()`.
 * The `close` callback is bound to the actual driver — callers
 * never need to know which driver is in use.
 */
export interface DbDriverResult {
	db: Db;
	/** Close the database connection. Bound to the actual driver at construction. */
	close: () => Promise<void>;
}

/** Database driver type. */
export type DbType = 'postgres' | 'pglite-file' | 'pglet-memory';

/**
 * Sentinel transaction function for transaction-scoped `Db` instances.
 *
 * Used by driver adapters when constructing the inner `Db` passed
 * to transaction callbacks.
 *
 * @throws Error always — nested transactions are not supported
 */
export const no_nested_transaction: DbDeps['transaction'] = () => {
	throw new Error('Nested transactions are not supported');
};

/**
 * Database wrapper providing a consistent query and transaction interface.
 *
 * Construct via `create_pg_db()` from `db/db_pg.ts`, `create_pglite_db()` from
 * `db/db_pglite.ts` or `create_pglet_db_driver()` from `db/db_pglet.ts` for proper
 * transaction support, or via `create_db()` for
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
	readonly #with_checkout_timeout: ((timeout_ms: number) => Db) | undefined;

	constructor(options: DbDeps) {
		this.client = options.client;
		this.#transaction = options.transaction;
		this.#with_checkout_timeout = options.with_checkout_timeout;
	}

	/**
	 * A `Db` over the same pool whose statements check out under `timeout_ms`
	 * instead of the pool's own bound — the audit emitter's longer wait
	 * (`db/db_pg.ts`, "Checkout timeout"). With no pool (PGlite, pglet, a
	 * transaction-scoped `Db`) there is no checkout to bound, and the `Db`
	 * itself is returned.
	 *
	 * @param timeout_ms - the checkout bound, in ms
	 * @returns a `Db` sharing this one's pool
	 */
	with_checkout_timeout(timeout_ms: number): Db {
		return this.#with_checkout_timeout?.(timeout_ms) ?? this;
	}

	/**
	 * Whether this `Db` is scoped to an open transaction — the `Db` a driver
	 * adapter hands a `transaction` callback, which it builds with
	 * `no_nested_transaction`. A pool-level `Db` answers `false`.
	 *
	 * The audit emitter reads it to write a success row inside the request's
	 * transaction when one is open (`auth/audit_emitter.ts`).
	 */
	get in_transaction(): boolean {
		return this.#transaction === no_nested_transaction;
	}

	/**
	 * Execute a query and return all rows.
	 *
	 * @param text - SQL text with `$1`, `$2`, ... parameter placeholders
	 * @param values - parameter values bound to the placeholders in `text`
	 * @returns the result rows, typed as `T`
	 */
	async query<T>(text: string, values?: Array<unknown>): Promise<Array<T>> {
		const result = await this.client.query<T>(text, values);
		return result.rows;
	}

	/**
	 * Execute a query and return the first row, or `undefined` if no rows.
	 *
	 * @param text - SQL text with `$1`, `$2`, ... parameter placeholders
	 * @param values - parameter values bound to the placeholders in `text`
	 * @returns the first row, or `undefined` when the result set is empty
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
	 * @throws Error propagated from `fn` after `ROLLBACK`, or from the driver
	 *   if `BEGIN` / `COMMIT` / `ROLLBACK` itself fails
	 */
	async transaction<T>(fn: (tx_db: Db) => Promise<T>): Promise<T> {
		return this.#transaction(fn);
	}
}
