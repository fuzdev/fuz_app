/**
 * `DbCheckoutError` — a failed pool checkout, kept apart from a failed query.
 *
 * A request that cannot check a connection out of the pool (the wait timed
 * out, a new connection's connect timed out or was refused, the pool is
 * closed) finds the database unavailable; every request surface answers it
 * with a 503 (`service_unavailable`), where a query that fails on a connection
 * already checked out keeps its 500. The pool built by `create_pg_pool`
 * (`db/db_pg.ts`) throws one from its `connect`, which per-statement
 * `pool.query` and each transaction's `pool.connect()` both run through.
 * `to_thrown_jsonrpc_error` (`http/jsonrpc_errors.ts`) maps it, so the
 * dispatcher, the route catch, and the server's `onError` all answer it the
 * same way. Twin of the Rust spine's `pool.get()` failures, which answer
 * `fuz_http::db_unavailable` / `db_unavailable_response`.
 *
 * PGlite and pglet have no pool, so neither ever throws one.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';

/**
 * Realm-global brand on `DbCheckoutError.prototype`. `Symbol.for` makes every
 * copy of this module one process resolves mint the same key, so
 * `is_db_checkout_error` recognizes an error from any copy of fuz_app, where
 * `instanceof` sees only its own class.
 */
const DB_CHECKOUT_ERROR_BRAND: unique symbol = Symbol.for('@fuzdev/fuz_app/DbCheckoutError');

/**
 * A pool checkout failed; `cause` carries the driver's error, and the message
 * repeats it for the server's log (`database checkout failed: <cause>`). The
 * wire never carries it — the answer is the fixed `database unavailable`.
 */
export class DbCheckoutError extends Error {
	constructor(options: ErrorOptions) {
		super(`database checkout failed: ${to_error_message(options.cause)}`, options);
		this.name = 'DbCheckoutError';
	}
}

Object.defineProperty(DbCheckoutError.prototype, DB_CHECKOUT_ERROR_BRAND, { value: true });

/**
 * Whether `err` is a `DbCheckoutError` from any copy of fuz_app, recognized by
 * its realm-global brand.
 *
 * @param err - the thrown value
 * @returns `true` for a failed pool checkout
 */
export const is_db_checkout_error = (err: unknown): boolean =>
	err instanceof Error &&
	(err as { [DB_CHECKOUT_ERROR_BRAND]?: unknown })[DB_CHECKOUT_ERROR_BRAND] === true;
