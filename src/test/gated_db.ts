/**
 * A `Db` wrapper that can hold one chosen query in flight, or one
 * transaction open just before it commits — the stall seams for tests that
 * need something to happen *between* two of a request's database steps (a
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

import { Db } from '$lib/db/db.ts';

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

	let armed_commit: { reached: () => void; held: Promise<void> } | null = null;
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
			open_transactions++;
			try {
				return await inner.transaction(async (tx) => {
					const result = await fn(tx);
					const hold = armed_commit;
					if (hold) {
						armed_commit = null;
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
			armed_commit = { reached: reached.resolve, held: held.promise };
			return { reached: reached.promise, release: held.resolve };
		},
		open_transactions: () => open_transactions
	};
};

/** Matches the session read both the auth middleware and the admission re-read run. */
export const is_session_read = (sql: string): boolean =>
	sql.includes('FROM auth_session WHERE id = $1');

/** Matches the by-id API token read only the admission re-read runs. */
export const is_api_token_live_read = (sql: string): boolean =>
	sql.includes('SELECT account_id FROM api_token WHERE id = $1');
