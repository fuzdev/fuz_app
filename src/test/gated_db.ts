/**
 * A `Db` wrapper that can hold one chosen query in flight, one transaction
 * before it begins, or one transaction open just before it commits — the
 * stall seams for tests that need something to happen *between* two of a
 * request's database steps (a
 * revocation landing between a credential's first read and its admission
 * re-read, say, or a connection opening while a revocation's transaction is
 * still uncommitted).
 *
 * The wrapped `Db` answers everything normally until a stall is armed; the
 * armed query or commit then waits until the test releases it, fails it, or
 * lets it through. It also counts the transactions currently open, so a test
 * can ask whether something ran before or after a commit. Nothing in
 * production takes a seam for this — the wrapper sits where the pool-level
 * `Db` is injected.
 *
 * @module
 */

import { Db, no_nested_transaction } from '#lib/db/db.ts';

/** One armed stall — see `GatedDb.stall`. */
export interface StalledQuery {
	/** Resolves once the matching query has arrived and is being held. */
	reached: Promise<void>;
	/** Let the held query run against the real database. */
	release: () => void;
	/** Fail the held query with `error` instead of running it. */
	fail: (error: Error) => void;
}

/** Options for `GatedDb.stall`. */
export interface StallOptions {
	/** Let this many matching queries through before holding one. Default `0`. */
	skip?: number;
}

/** One armed commit hold — see `GatedDb.hold_commit`. */
export interface HeldCommit {
	/**
	 * Resolves once a transaction's callback has returned and its commit is
	 * being held: everything the callback wrote is still uncommitted.
	 */
	reached: Promise<void>;
	/** Let the held transaction commit. */
	release: () => void;
	/**
	 * The held transaction, for a statement run inside it while it is held —
	 * its backend's `pg_backend_pid()`, say. Resolves with `reached`.
	 */
	transaction: Promise<Db>;
	/**
	 * Fail the held transaction with `error` instead of committing it: the
	 * callback has returned, its writes roll back, and the transaction call
	 * rejects — what its caller sees when a `COMMIT` fails.
	 */
	fail: (error: Error) => void;
}

/** One armed begin hold — see `GatedDb.hold_begin`. */
export interface HeldBegin {
	/** Resolves once a transaction is waiting to begin. */
	reached: Promise<void>;
	/** Let the held transaction begin. */
	release: () => void;
	/**
	 * Fail the held transaction with `error` instead of beginning it: its
	 * callback never runs and the transaction call rejects — what its caller
	 * sees when a `BEGIN` (or the checkout before it) fails. Twin of
	 * `HeldCommit.fail`.
	 */
	fail: (error: Error) => void;
}

/** A pass-through `Db` plus the controls to stall one query or one commit. */
export interface GatedDb {
	/** The wrapper to inject in place of the pool-level `Db`. */
	db: Db;
	/**
	 * Hold the next query whose SQL text satisfies `match` (after `skip`
	 * earlier matches). One stall is armed at a time; it disarms once it holds
	 * a query.
	 */
	stall: (match: (sql: string) => boolean, options?: StallOptions) => StalledQuery;
	/**
	 * Hold the next transaction open after its callback returns, before it
	 * commits. One hold is armed at a time; it disarms once it holds a
	 * transaction. A callback that throws rolls back without being held.
	 */
	hold_commit: () => HeldCommit;
	/**
	 * Hold the next transaction before it begins — nothing of it has run, and
	 * no connection is taken for it. One hold is armed at a time; it disarms
	 * once it holds a transaction.
	 */
	hold_begin: () => HeldBegin;
	/**
	 * Refuse the next statement run inside a transaction whose SQL text
	 * satisfies `match`: it throws `error` without reaching the database, as a
	 * statement the database refused does, so the transaction rolls back. One
	 * refusal is armed at a time; it disarms once it refuses a statement.
	 */
	refuse_in_transaction: (match: (sql: string) => boolean, error: Error) => void;
	/**
	 * How many transactions are open right now — begun through `db` and
	 * neither committed nor rolled back. Zero means whatever is running, runs
	 * outside every transaction of this `Db`.
	 */
	open_transactions: () => number;
}

/**
 * Wrap `inner` so a test can stall one of its queries or hold one of its
 * commits.
 *
 * Only pool-level queries are gated by `stall` — a transaction runs against
 * `inner` directly, so its statements never wait on one.
 */
export const create_gated_db = (inner: Db): GatedDb => {
	let armed: {
		match: (sql: string) => boolean;
		skip: number;
		reached: () => void;
		held: Promise<void>;
	} | null = null;

	let armed_commit: {
		reached: () => void;
		transaction: (tx: Db) => void;
		held: Promise<void>;
	} | null = null;
	let armed_begin: { reached: () => void; held: Promise<void> } | null = null;
	let armed_refusal: { match: (sql: string) => boolean; error: Error } | null = null;
	let open_transactions = 0;

	const db = new Db({
		client: {
			query: async <T>(text: string, values?: Array<unknown>) => {
				const stall = armed;
				if (stall?.match(text)) {
					if (stall.skip > 0) {
						stall.skip--;
					} else {
						armed = null;
						stall.reached();
						await stall.held;
					}
				}
				return inner.client.query<T>(text, values);
			}
		},
		transaction: async (fn) => {
			const begin = armed_begin;
			if (begin) {
				armed_begin = null;
				begin.reached();
				await begin.held;
			}
			open_transactions++;
			try {
				return await inner.transaction(async (inner_tx) => {
					// the callback's statements reach `inner_tx` through a refusal
					// check; `no_nested_transaction` keeps it reading as in-transaction
					const tx = new Db({
						client: {
							query: async <T>(text: string, values?: Array<unknown>) => {
								const refusal = armed_refusal;
								if (refusal?.match(text)) {
									armed_refusal = null;
									throw refusal.error;
								}
								return inner_tx.client.query<T>(text, values);
							}
						},
						transaction: no_nested_transaction
					});
					const result = await fn(tx);
					const hold = armed_commit;
					if (hold) {
						armed_commit = null;
						hold.transaction(inner_tx);
						hold.reached();
						await hold.held;
					}
					return result;
				});
			} finally {
				// the inner promise settles only once the commit or rollback has
				// landed, so the count drops after it
				open_transactions--;
			}
		}
	});

	return {
		db,
		stall: (match, options) => {
			const reached = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			// a stall failed after its test stopped waiting must not surface as an
			// unhandled rejection
			held.promise.catch(() => {});
			armed = {
				match,
				skip: options?.skip ?? 0,
				reached: reached.resolve,
				held: held.promise
			};
			return { reached: reached.promise, release: held.resolve, fail: held.reject };
		},
		hold_commit: () => {
			const reached = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			// a hold failed after its test stopped waiting must not surface as an
			// unhandled rejection
			held.promise.catch(() => {});
			const transaction = Promise.withResolvers<Db>();
			armed_commit = {
				reached: reached.resolve,
				transaction: transaction.resolve,
				held: held.promise
			};
			return {
				reached: reached.promise,
				release: held.resolve,
				transaction: transaction.promise,
				fail: held.reject
			};
		},
		hold_begin: () => {
			const reached = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			// a hold failed after its test stopped waiting must not surface as an
			// unhandled rejection
			held.promise.catch(() => {});
			armed_begin = { reached: reached.resolve, held: held.promise };
			return { reached: reached.promise, release: held.resolve, fail: held.reject };
		},
		refuse_in_transaction: (match, error) => {
			armed_refusal = { match, error };
		},
		open_transactions: () => open_transactions
	};
};

/** Matches the session read both the auth middleware and the admission re-read run. */
export const is_session_read = (sql: string): boolean =>
	sql.includes('FROM auth_session WHERE id = $1');

/** Matches the audit emitter's pool write. */
export const is_audit_insert = (sql: string): boolean => sql.includes('INSERT INTO audit_log');

/** Matches the by-id API token read only the admission re-read runs. */
export const is_api_token_live_read = (sql: string): boolean =>
	sql.includes('SELECT account_id FROM api_token WHERE id = $1');
