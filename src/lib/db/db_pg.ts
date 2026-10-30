/**
 * PostgreSQL driver adapter for `Db`.
 *
 * Provides `create_pg_pool()` to build the pool with a bounded checkout, and
 * `create_pg_db()` to construct a `Db` backed by it.
 *
 * ## Checkout timeout
 *
 * Every checkout from a `create_pg_pool` pool — the wait for a free client,
 * or a new client's connect — gives up after `checkout_timeout_ms`
 * (`connectionTimeoutMillis`; default `DEFAULT_DB_CHECKOUT_TIMEOUT_MS`, 5 s)
 * and throws a `DbCheckoutError` (`db/db_checkout_error.ts`), which every
 * request surface answers with a 503. A query that fails on a client already
 * checked out throws the driver's error as before (a 500). Per-statement
 * `pool.query` and each transaction's `pool.connect()` both check out through
 * the pool's `connect`, so both are bounded. The wait and the connect are
 * bounded one by one, so a checkout that waits and is then handed a slot to
 * connect in can take about twice the bound. `Db.with_checkout_timeout` gives
 * a caller its own bound on the same pool — the audit emitter's pool writes
 * wait `DEFAULT_DB_AUDIT_CHECKOUT_TIMEOUT_MS` (30 s), so a pool saturated
 * enough to shed requests does not also drop the failure rows recording them.
 * A request that awaits its audit row — a failed login does — can therefore
 * wait up to that bound, not the request's. Twin of the Rust
 * `fuz_db::create_pool` / `PoolOptions`.
 *
 * Statically imports only `pg` types; the `pg` runtime is dynamically
 * imported where needed — by callers (e.g., `create_db`) that construct the
 * `Pool`, and by `register_pg_type_parsers` to reach `pg.types`. pglite-only
 * consumers never reach either path, so `pg` stays an optional peer dep.
 *
 * @module
 */

import type { Pool, PoolClient, PoolConfig } from 'pg';

import { Db, no_nested_transaction, type DbDriverResult } from './db.ts';
import { DbCheckoutError } from './db_checkout_error.ts';

/** Default bound on one request's pool checkout — Rust `fuz_db::DEFAULT_CHECKOUT_TIMEOUT`. */
export const DEFAULT_DB_CHECKOUT_TIMEOUT_MS = 5_000;

/**
 * Default bound on the checkout behind one audit pool write — Rust
 * `fuz_db::DEFAULT_AUDIT_CHECKOUT_TIMEOUT`.
 */
export const DEFAULT_DB_AUDIT_CHECKOUT_TIMEOUT_MS = 30_000;

/** The largest checkout bound either env var admits (10 minutes) — Rust `DB_CHECKOUT_TIMEOUT_MAX_MS`. */
export const DB_CHECKOUT_TIMEOUT_MAX_MS = 600_000;

/**
 * A `pg.Pool` from `create_pg_pool`: a failed checkout throws `DbCheckoutError`,
 * and `query_with_checkout_timeout` runs one statement under its own bound.
 */
export interface DbCheckoutPool extends Pool {
	/**
	 * `pool.query` with the checkout bounded by `timeout_ms` in place of the
	 * pool's own.
	 */
	query_with_checkout_timeout: <T>(
		timeout_ms: number,
		text: string,
		values?: Array<unknown>
	) => Promise<{ rows: Array<T> }>;
}

/** Options for `create_pg_pool`. */
export interface CreatePgPoolOptions {
	/** The `postgres://` URL. */
	connection_string: string;
	/** Bound on every checkout, in ms — `DEFAULT_DB_CHECKOUT_TIMEOUT_MS` in production. */
	checkout_timeout_ms: number;
}

/**
 * Build a `pg.Pool` whose every checkout is bounded by
 * `options.checkout_timeout_ms` and throws `DbCheckoutError` when it fails
 * (module doc, "Checkout timeout").
 *
 * The pool wraps every error of its `connect` — the wait timing out, a new
 * client's connect timing out or failing, a closed pool — and nothing a query
 * on a checked-out client throws. `pool.query` checks out through the same
 * `connect` (pg-pool's `query` calls `this.connect`), so per-statement queries
 * keep pg-pool's own error-listener handling.
 *
 * `query_with_checkout_timeout` lends one statement its own bound by setting
 * `options.connectionTimeoutMillis` for the synchronous span of `query` →
 * `connect`: pg-pool reads it there, to arm the queue wait's timer or a new
 * client's connect timer, and nowhere later on that checkout's path but one —
 * a waiter that a freed slot later hands a brand-new client connects under the
 * pool's own bound. Pinned against the installed pg-pool by
 * `src/test/db/db_pg.db.test.ts`.
 *
 * @param pg - the `pg` module (dynamically imported by the caller)
 * @param options - the URL and the checkout bound
 * @returns the pool
 */
export const create_pg_pool = (
	pg: { Pool: typeof Pool },
	options: CreatePgPoolOptions
): DbCheckoutPool => {
	const config: PoolConfig = {
		connectionString: options.connection_string,
		connectionTimeoutMillis: options.checkout_timeout_ms
	};
	const to_checkout_error = (err: unknown): DbCheckoutError => new DbCheckoutError({ cause: err });
	class CheckoutPool extends pg.Pool implements DbCheckoutPool {
		// both forms: pg-pool's `query` passes a callback, a transaction awaits
		override connect(): Promise<PoolClient>;
		override connect(
			callback: (
				err: Error | undefined,
				client: PoolClient | undefined,
				done: (release?: any) => void
			) => void
		): void;
		override connect(
			callback?: (
				err: Error | undefined,
				client: PoolClient | undefined,
				done: (release?: any) => void
			) => void
		): Promise<PoolClient> | void {
			if (callback) {
				super.connect((err, client, done) => {
					callback(err ? to_checkout_error(err) : undefined, client, done);
				});
				return;
			}
			return super.connect().catch((err: unknown) => {
				throw to_checkout_error(err);
			});
		}

		query_with_checkout_timeout = <T>(
			timeout_ms: number,
			text: string,
			values?: Array<unknown>
		): Promise<{ rows: Array<T> }> => {
			const previous = this.options.connectionTimeoutMillis;
			this.options.connectionTimeoutMillis = timeout_ms;
			try {
				const result: Promise<unknown> = this.query(text, values);
				return result as Promise<{ rows: Array<T> }>;
			} finally {
				this.options.connectionTimeoutMillis = previous;
			}
		};
	}
	return new CheckoutPool(config);
};

/**
 * Register the shared pg type-parser overrides on the module-global `pg.types`.
 *
 * Dynamically imports the `pg` runtime (so pglite-only consumers, who never
 * call this, don't need `pg` installed) and coerces int8 (`BIGINT`, OID 20)
 * to a JS number. pg defaults to returning
 * int8 as a string to avoid 2^53 precision loss; our int8 columns today
 * (`audit_log.seq`, `fact.size`) stay well under that
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
	types.setTypeParser(types.builtins.INT8, (val) => Number(val));
};

/**
 * Create a transaction implementation for a `pg.Pool`.
 *
 * Acquires a dedicated client from the pool for each transaction,
 * ensuring `BEGIN` / `COMMIT` / `ROLLBACK` all hit the same connection.
 * Releases the client in `finally` regardless of outcome.
 *
 * Throws when PostgreSQL answers the `COMMIT` with `ROLLBACK` — a statement in
 * the transaction failed and its error was swallowed (an un-awaited promise, a
 * `catch` that never rethrew), so nothing committed. Without the check the
 * caller would read the rolled-back transaction as a success. A handler that
 * answers normally from a failed statement runs it under a savepoint and rolls
 * back to it (`http/db_routes.ts`'s row delete does).
 */
const create_pg_transaction =
	(pool: Pool) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> => {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const tx_db = new Db({ client, transaction: no_nested_transaction });
			const result = await fn(tx_db);
			const commit = await client.query('COMMIT');
			if (commit.command === 'ROLLBACK') {
				throw new Error('transaction aborted before COMMIT: PostgreSQL rolled it back');
			}
			return result;
		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
	};

/**
 * Create a `Db` backed by a `create_pg_pool` pool.
 *
 * Owns the transaction implementation, acquiring a dedicated pool client
 * per transaction. `db.with_checkout_timeout(ms)` returns a `Db` over the
 * same pool whose statements check out under `ms` instead (its transactions
 * keep the pool's own bound).
 *
 * @param pool - a pool from `create_pg_pool`
 * @returns the `Db` instance and a `close` callback bound to `pool.end()`
 */
export const create_pg_db = (pool: DbCheckoutPool): DbDriverResult => {
	const transaction = create_pg_transaction(pool);
	return {
		db: new Db({
			client: pool,
			transaction,
			with_checkout_timeout: (timeout_ms) =>
				new Db({
					client: {
						query: <T>(text: string, values?: Array<unknown>) =>
							pool.query_with_checkout_timeout<T>(timeout_ms, text, values)
					},
					transaction
				})
		}),
		close: () => pool.end()
	};
};
