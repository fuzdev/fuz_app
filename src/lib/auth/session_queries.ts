/**
 * Auth session database queries.
 *
 * Server-side sessions keyed by blake3 hash of the session token.
 * The cookie contains the raw token; the database stores only the hash.
 *
 * @module
 */

import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';

import { generate_random_base64url } from '../crypto.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { columns_sql, iso8601_timestamp_expr, qualify_columns } from '../db/sql_columns.ts';
import type { AuthSession, SessionId } from './account_schema.ts';
import { EXPIRES_IN_MS_SQL } from './credential_deadline.ts';

/** The session lifetime in whole seconds, which the insert's interval spells. */
const AUTH_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * Session lifetime in milliseconds (30 days).
 *
 * An **absolute** cap: `expires_at` is set once at mint and never extended —
 * there is deliberately no touch/renewal query on either spine (a sliding
 * window renews a leaked cookie forever; see `docs/security.md` §Session
 * Security). The cookie's `SESSION_AGE_MAX` mirrors this value.
 */
export const AUTH_SESSION_LIFETIME_MS = AUTH_SESSION_LIFETIME_SECONDS * 1000;

/**
 * Hash a session token to its storage key using blake3.
 *
 * The sole minting point for `SessionId` — `hash_blake3` returns bare hex, so
 * the brand is applied here, where the value gains its meaning.
 *
 * @param token - the raw session token
 * @returns hex-encoded blake3 hash
 */
export const hash_session_token = (token: string): SessionId => {
	return hash_blake3(token) as SessionId;
};

/**
 * Generate a cryptographically random session token.
 *
 * @returns a 32-byte base64url-encoded token
 */
export const generate_session_token = (): string => {
	return generate_random_base64url();
};

/**
 * `AUTH_SESSION_LIFETIME_MS` as the SQL interval the session insert adds to
 * `NOW()` — `INTERVAL '2592000 seconds'`, the Rust spine's literal. Elapsed
 * seconds, not `'30 days'`: a day interval is calendar time in the session's
 * time zone, so a session crossing a DST change would live an hour more or
 * less.
 */
const AUTH_SESSION_LIFETIME_SQL = `INTERVAL '${AUTH_SESSION_LIFETIME_SECONDS} seconds'`;

/**
 * Create a new auth session, expiring `AUTH_SESSION_LIFETIME_MS` after the
 * database's `NOW()` — the clock the validity check (`expires_at > NOW()`)
 * reads, and the one `created_at` takes, so the expiry sits a whole lifetime
 * past the row's creation and every session one transaction creates shares
 * it. Twin of the Rust `query_create_session`, same statement.
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token (use `hash_session_token`)
 * @param account_id - the account this session belongs to
 * @mutates `auth_session` table - inserts a row keyed by `token_hash`
 */
export const query_create_session = async (
	deps: QueryDeps,
	token_hash: string,
	account_id: string
): Promise<void> => {
	await deps.db.query(
		`INSERT INTO auth_session (id, account_id, expires_at)
		 VALUES ($1, $2, NOW() + ${AUTH_SESSION_LIFETIME_SQL})`,
		[token_hash, account_id]
	);
};

/**
 * The full `auth_session` column set, named explicitly so a row read fails
 * loud on schema drift — `SELECT *` would silently carry a dropped or
 * leftover column into the strict-validated wire shapes (see
 * `ACCOUNT_COLUMNS` in `auth/account_queries.ts` for the outage class this
 * discipline exists to prevent; the Rust twin already names columns at every
 * session site). Keep in sync with `AuthSession` and the migration chain's
 * end state — not the frozen v0 DDL in `auth/auth_ddl.ts`, which still
 * creates `last_seen_at` for the appended drop migration to remove.
 */
export const AUTH_SESSION_COLUMNS = [
	'id',
	'account_id',
	'created_at',
	'expires_at'
] as const satisfies ReadonlyArray<keyof AuthSession>;

/** The `auth_session` timestamp override, by row qualifier (`''` bare, `s` for the admin listing's JOIN). */
const auth_session_expr = iso8601_timestamp_expr(AUTH_SESSION_COLUMNS, [
	'created_at',
	'expires_at'
]);

/**
 * A live `auth_session` row as `query_session_get_valid` returns it, with how
 * long it has left.
 */
export interface ValidAuthSession extends AuthSession {
	/**
	 * Milliseconds until the session expires — `expires_at - NOW()`, measured on
	 * the database clock in the statement that found it unexpired
	 * (`EXPIRES_IN_MS_SQL`).
	 */
	expires_in_ms: number;
}

/**
 * Get a session if it exists, is not expired, and has not been revoked, with
 * how long it has left.
 *
 * The remaining lifetime is read in the same statement that checks the
 * expiry, on the database clock, so it agrees with the check whatever the
 * server's clock says (`auth/credential_deadline.ts`).
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token
 */
export const query_session_get_valid = async (
	deps: QueryDeps,
	token_hash: string
): Promise<ValidAuthSession | undefined> => {
	return deps.db.query_one<ValidAuthSession>(
		`SELECT ${columns_sql(AUTH_SESSION_COLUMNS, auth_session_expr(''))}, ${EXPIRES_IN_MS_SQL} AS expires_in_ms FROM auth_session WHERE id = $1 AND expires_at > NOW()`,
		[token_hash]
	);
};

/**
 * Whether the session that authorized a credential mint still lives, read in
 * the mint's transaction after `query_account_lock_live`.
 *
 * The session was resolved before the transaction, so a password change can
 * commit in between and revoke it. The account lock orders the two — the
 * change writes the account row before it revokes — so this read either sees
 * the change's revoke (it committed before the lock was granted) or runs
 * ahead of it (the change then waits on the lock, and its revoke takes what
 * the mint wrote). The row is not locked: a plain revoke of one session
 * touches no account row, and a token minted just before a logout outlives it
 * anyway, so ordering against one buys nothing. Twin of the Rust
 * `fuz_auth::query_session_is_live`.
 *
 * @param deps - query dependencies (must be the mint's transaction)
 * @param id - the session's id, its token hash
 * @param account_id - the account the session must belong to
 * @returns `true` when the session exists, belongs to the account, and has not expired
 */
export const query_session_is_live = async (
	deps: QueryDeps,
	id: string,
	account_id: string
): Promise<boolean> => {
	const row = await deps.db.query_one<{ id: string }>(
		`SELECT id FROM auth_session WHERE id = $1 AND account_id = $2 AND expires_at > NOW()`,
		[id, account_id]
	);
	return row !== undefined;
};

/**
 * The password hash of the account a live session belongs to — the hash a
 * password change verifies `current_password` against.
 *
 * The change's credential was resolved before this read, and its account row
 * with it in a separate statement, so a change, a delete or a purge can commit
 * between the two reads or after them. Each revokes the account's sessions in
 * the transaction of its write, so while the session lives, the stored hash is
 * the one the session was resolved under; once it is gone, the credential died
 * mid-request and there is no hash to verify. Bound to the session in one
 * statement, the read answers one or the other, never a later change's hash
 * beside a dead session. The read is no lock: a session that dies after it is
 * caught by the change's transaction, which takes the account row and then
 * reads the session again (`query_session_is_live`). No tombstone filter: a
 * delete revokes the sessions, and the change's transaction refuses a
 * tombstone itself. Twin of the Rust
 * `fuz_auth::query_session_live_password_hash`.
 *
 * @param deps - query dependencies
 * @param id - the session's id, its token hash
 * @param account_id - the account the session must belong to
 * @returns the account's password hash, or `undefined` when the session is no longer live
 */
export const query_session_live_password_hash = async (
	deps: QueryDeps,
	id: string,
	account_id: string
): Promise<string | undefined> => {
	const row = await deps.db.query_one<{ password_hash: string }>(
		`SELECT a.password_hash FROM auth_session s JOIN account a ON a.id = s.account_id
		 WHERE s.id = $1 AND s.account_id = $2 AND s.expires_at > NOW()`,
		[id, account_id]
	);
	return row?.password_hash;
};

/**
 * Revoke (delete) a session by its token hash, with no account scoping.
 *
 * The `_unscoped` suffix is the safety signal — there is no `account_id`
 * constraint, so callers must guarantee the hash came from a trusted
 * source (the authenticated session cookie path is the only safe production
 * caller — see `auth/account_routes.ts` `/logout`). For user-facing revocation
 * of a specific session by ID, use `query_session_revoke_for_account`
 * (IDOR-guarded).
 *
 * @mutates `auth_session` table - deletes the row keyed by `token_hash`
 */
export const query_session_revoke_by_hash_unscoped = async (
	deps: QueryDeps,
	token_hash: string
): Promise<void> => {
	await deps.db.query(`DELETE FROM auth_session WHERE id = $1`, [token_hash]);
};

/**
 * Revoke a session only if it belongs to the specified account.
 *
 * Prevents cross-account session revocation.
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token
 * @param account_id - the account that must own the session
 * @returns `true` if a session was revoked, `false` if not found or wrong account
 * @mutates `auth_session` table - deletes the row when account ownership matches
 */
export const query_session_revoke_for_account = async (
	deps: QueryDeps,
	token_hash: string,
	account_id: string
): Promise<boolean> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM auth_session WHERE id = $1 AND account_id = $2 RETURNING id`,
		[token_hash, account_id]
	);
	return rows.length > 0;
};

/**
 * Revoke all sessions for an account.
 *
 * Locks its rows in id order before it deletes them (`ORDER BY id FOR
 * UPDATE`), as every multi-row delete of `auth_session` rows does — the cap's
 * eviction, the expiry sweep, the revoke-all — so two of them reaching the
 * same rows wait one on the other instead of deadlocking in the opposite
 * orders their plans would otherwise walk. Twin of the Rust
 * `fuz_auth::query_session_revoke_all_for_account`.
 *
 * @returns the number of sessions revoked
 * @mutates `auth_session` table - deletes every row for `account_id`
 */
export const query_session_revoke_all_for_account = async (
	deps: QueryDeps,
	account_id: string
): Promise<number> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM auth_session
		 WHERE id IN (SELECT id FROM auth_session WHERE account_id = $1 ORDER BY id FOR UPDATE)
		 RETURNING id`,
		[account_id]
	);
	return rows.length;
};

/**
 * List sessions for an account, newest first.
 */
export const query_session_list_for_account = async (
	deps: QueryDeps,
	account_id: string,
	limit = 50
): Promise<Array<AuthSession>> => {
	return deps.db.query<AuthSession>(
		`SELECT ${columns_sql(AUTH_SESSION_COLUMNS, auth_session_expr(''))} FROM auth_session WHERE account_id = $1 ORDER BY auth_session.created_at DESC LIMIT $2`,
		[account_id, limit]
	);
};

/**
 * Enforce a per-account session limit by evicting the oldest sessions.
 *
 * Keeps the newest `max_sessions` sessions and deletes the rest.
 *
 * Race safety: this function must run inside a transaction alongside the
 * INSERT that created the new session. Its one caller is
 * `create_capped_session`, which `POST /login`, `POST /bootstrap` and
 * `POST /signup` each run in a transaction of their own.
 *
 * The transaction makes one creator's INSERT + enforce_limit pair atomic, but it
 * does **not** serialize concurrent creators. Under Read Committed, two
 * transactions can't see each other's uncommitted session row, so each computes
 * its `OFFSET` eviction against a stale count, each preserves its own row, and
 * both commit above `max_sessions` — and their two `DELETE`s lock the same old
 * rows in orders the plan picks, so they can deadlock. A transaction is
 * necessary here but not sufficient: a creator for an existing account first
 * takes its account row `FOR NO KEY UPDATE` (`query_account_lock_verified`),
 * which makes the creators of one account take turns, each counting the rows
 * the one before committed. A creator for an account its own transaction just
 * made needs none — no other can reach the account.
 *
 * Ordering is `created_at DESC, id DESC`. The `id` leg is a **stability**
 * tie-breaker, not a recency one: `created_at` defaults to `NOW()`, the
 * *transaction* timestamp, so two sessions born in one transaction — or in two
 * transactions that started in the same microsecond — tie, and an untied
 * `OFFSET` may keep a different set on two evaluations of the same rows. `id` is
 * the blake3 token hash, so the tie-break is arbitrary but deterministic; it
 * makes the survivors reproducible, it does not make the row just inserted a
 * guaranteed survivor. Only the account lock above does that.
 *
 * Expired-but-unreaped rows count toward the cap (the predicate is `account_id`
 * alone). Matches the Rust twin `query_session_enforce_limit`.
 *
 * The victims are locked in id order before the delete (`ORDER BY id FOR
 * UPDATE`), as every multi-row delete of `auth_session` rows locks them: a
 * revoke-all or the expiry sweep reaching the same rows waits on the eviction,
 * or the eviction on it, instead of the two deadlocking in whatever orders
 * their plans walk (`query_session_revoke_all_for_account`).
 *
 * Deleting a session row does not end the connections it opened: a WebSocket
 * keeps the authority it resolved at upgrade and an SSE stream never rechecks.
 * The returned ids are the token hashes those connections are registered
 * under, so the caller closes them once the transaction commits
 * (`queue_connection_close`) — `POST /login` does.
 *
 * @param deps - query dependencies (must be transaction-scoped)
 * @param account_id - the account to enforce the limit for
 * @param max_sessions - maximum number of sessions to keep
 * @returns the evicted sessions' ids (their token hashes), empty when nothing was evicted
 * @mutates `auth_session` table - deletes the oldest rows past the cap
 */
export const query_session_enforce_limit = async (
	deps: QueryDeps,
	account_id: string,
	max_sessions: number
): Promise<Array<string>> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM auth_session
		 WHERE id IN (
		   SELECT id FROM auth_session
		   WHERE id IN (
		     SELECT id FROM auth_session
		     WHERE account_id = $1
		     ORDER BY created_at DESC, id DESC
		     OFFSET $2
		   )
		   ORDER BY id
		   FOR UPDATE
		 ) RETURNING id`,
		[account_id, max_sessions]
	);
	return rows.map((row) => row.id);
};

/**
 * List all active sessions across all accounts with usernames.
 *
 * Ordered by `created_at DESC` (newest session first), matching the
 * per-account listing.
 *
 * @param deps - query dependencies
 * @param limit - maximum entries to return
 * @returns active sessions joined with account usernames, newest first
 */
export const query_session_list_all_active = async (
	deps: QueryDeps,
	limit = 200
): Promise<Array<AuthSession & { username: string }>> => {
	return deps.db.query<AuthSession & { username: string }>(
		`SELECT ${qualify_columns(AUTH_SESSION_COLUMNS, 's', auth_session_expr('s'))}, a.username
		 FROM auth_session s
		 JOIN account a ON a.id = s.account_id
		 WHERE s.expires_at > NOW()
		 ORDER BY s.created_at DESC, s.id DESC LIMIT $1`,
		[limit]
	);
};

/**
 * Delete every expired session, returning the ids (token hashes) of the rows
 * it deleted.
 *
 * The ids are the `session_hash` of the `session` close target
 * (`ConnectionCloser.close_connections`).
 * A row past `expires_at` already fails `query_session_get_valid`, but
 * deleting it does not end the connections it opened: a WebSocket keeps the
 * authority it resolved at upgrade and an SSE stream never rechecks. The row
 * was also the only per-session handle on those connections —
 * `account_session_revoke` closes only for a row it deleted — so the caller
 * closes each returned session's connections once the delete has committed.
 * `cleanup_expired_sessions` (`auth/cleanup.ts`) is that caller; reach for it
 * rather than this query.
 *
 * One statement, so the returned ids are exactly the rows this call removed:
 * a concurrent pass gets a disjoint set. Run it in a transaction, as the
 * caller above does, so the ids are in hand before the delete commits — on a
 * pool-level `Db` a connection lost on the response leaves the rows deleted
 * and their ids unread. Served by `idx_auth_session_expires`. The rows are
 * locked in id order before the delete, as every multi-row delete of
 * `auth_session` rows locks them (`query_session_revoke_all_for_account`). Twin
 * of the Rust `query_session_cleanup_expired`.
 *
 * @param deps - query dependencies (transaction-scoped, see above)
 * @returns the deleted sessions' ids (their token hashes), empty when nothing had expired
 * @mutates `auth_session` table - deletes every row past `expires_at`
 */
export const query_session_cleanup_expired = async (deps: QueryDeps): Promise<Array<string>> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM auth_session
		 WHERE id IN (SELECT id FROM auth_session WHERE expires_at <= NOW() ORDER BY id FOR UPDATE)
		 RETURNING id`
	);
	return rows.map((row) => row.id);
};

/**
 * Options for `create_capped_session`.
 */
export interface CreateCappedSessionOptions {
	/** Query deps (needs db for session creation). */
	deps: QueryDeps;
	/** The account to create a session for. */
	account_id: string;
	/** Per-account session cap (`null` to skip enforcement). */
	max_sessions?: number | null;
}

/** What `create_capped_session` minted. Twin of the Rust `CappedSession`. */
export interface CappedSession {
	/** The raw session token, for `sign_session_cookie` — a live credential. */
	token: string;
	/** The token hashes of the sessions the cap evicted, empty without a cap. */
	evicted: Array<string>;
}

/**
 * Mint an auth session: generate a token, persist its hashed row, and enforce
 * the per-account cap when given one — without touching a response. The
 * caller signs the token into its `Set-Cookie` line (`sign_session_cookie`)
 * and sets it on its success, so a session minted inside a transaction gets
 * its cookie only once that transaction has succeeded. Twin of the Rust
 * `fuz_auth::create_capped_session`.
 *
 * The cap deletes the sessions it evicts, but not the connections they
 * opened. A caller that passes `max_sessions` closes the returned sessions'
 * connections once its transaction commits — `queue_connection_close` with a
 * `session` target, as `POST /login` does. A caller that mints for an account
 * created in the same transaction (signup, bootstrap) evicts nothing.
 *
 * A caller minting for an existing account first takes its row lock in the
 * same transaction (`query_account_lock_verified`) and refuses on `false`: a
 * password change or a delete in flight is ordered against the mint, and the
 * account's mints take turns, which the cap counts on
 * (`query_session_enforce_limit`).
 *
 * @returns the raw session token and the evicted sessions' token hashes
 * @mutates `auth_session` table - inserts the new session row (and evicts older rows when `max_sessions` is set)
 */
export const create_capped_session = async (
	options: CreateCappedSessionOptions
): Promise<CappedSession> => {
	const { deps, account_id, max_sessions } = options;
	const session_token = generate_session_token();
	const token_hash = hash_session_token(session_token);
	await query_create_session(deps, token_hash, account_id);

	const evicted =
		max_sessions != null ? await query_session_enforce_limit(deps, account_id, max_sessions) : [];

	return { token: session_token, evicted };
};
