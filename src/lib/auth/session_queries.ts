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
import { columns_sql, qualify_columns } from '../db/sql_columns.ts';
import type { AuthSession, SessionId } from './account_schema.ts';

/**
 * Session lifetime in milliseconds (30 days).
 *
 * An **absolute** cap: `expires_at` is set once at mint and never extended —
 * there is deliberately no touch/renewal query on either spine (a sliding
 * window renews a leaked cookie forever; see `docs/security.md` §Session
 * Security). The cookie's `SESSION_AGE_MAX` mirrors this value.
 */
export const AUTH_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Create a new auth session.
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token (use `hash_session_token`)
 * @param account_id - the account this session belongs to
 * @param expires_at - when the session expires
 * @mutates `auth_session` table - inserts a row keyed by `token_hash`
 */
export const query_create_session = async (
	deps: QueryDeps,
	token_hash: string,
	account_id: string,
	expires_at: Date
): Promise<void> => {
	await deps.db.query(`INSERT INTO auth_session (id, account_id, expires_at) VALUES ($1, $2, $3)`, [
		token_hash,
		account_id,
		expires_at.toISOString()
	]);
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

/**
 * Get a session if it exists, is not expired, and has not been revoked.
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token
 */
export const query_session_get_valid = async (
	deps: QueryDeps,
	token_hash: string
): Promise<AuthSession | undefined> => {
	return deps.db.query_one<AuthSession>(
		`SELECT ${columns_sql(AUTH_SESSION_COLUMNS)} FROM auth_session WHERE id = $1 AND expires_at > NOW()`,
		[token_hash]
	);
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
 * @returns the number of sessions revoked
 * @mutates `auth_session` table - deletes every row for `account_id`
 */
export const query_session_revoke_all_for_account = async (
	deps: QueryDeps,
	account_id: string
): Promise<number> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM auth_session WHERE account_id = $1 RETURNING id`,
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
		`SELECT ${columns_sql(AUTH_SESSION_COLUMNS)} FROM auth_session WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
		[account_id, limit]
	);
};

/**
 * Enforce a per-account session limit by evicting the oldest sessions.
 *
 * Keeps the newest `max_sessions` sessions and deletes the rest.
 *
 * Race safety: this function must run inside a transaction alongside the
 * INSERT that created the new session. All callers satisfy this requirement:
 * - `POST /login` uses the default `transaction: true` (framework-managed
 *   transaction wrapping in `apply_route_specs`)
 * - The `account_token_create` RPC handler runs under the dispatcher's
 *   transaction path because its spec declares `side_effects: true`
 * - `POST /bootstrap` and `POST /signup` manage their own transactions
 *   and pass the transaction-scoped `deps` to `create_session_and_set_cookie`
 *
 * The transaction makes one creator's INSERT + enforce_limit pair atomic, but it
 * does **not** serialize concurrent creators. Under Read Committed, two
 * transactions can't see each other's uncommitted session row, so each computes
 * its `OFFSET` eviction against a stale count, each preserves its own row, and
 * both commit above `max_sessions`. A transaction is necessary here but not
 * sufficient. Closing this needs one serialization point per
 * `(account_id, credential_kind)` — a locked parent row or a transaction-scoped
 * advisory lock — taken before count/evict/insert.
 *
 * Ordering is `created_at DESC, id DESC`. The `id` leg is a **stability**
 * tie-breaker, not a recency one: `created_at` defaults to `NOW()`, the
 * *transaction* timestamp, so two sessions born in one transaction — or in two
 * transactions that started in the same microsecond — tie, and an untied
 * `OFFSET` may keep a different set on two evaluations of the same rows. `id` is
 * the blake3 token hash, so the tie-break is arbitrary but deterministic; it
 * makes the survivors reproducible, it does not make the row just inserted a
 * guaranteed survivor. Only the serialization point above does that.
 *
 * Expired-but-unreaped rows count toward the cap (the predicate is `account_id`
 * alone). Matches the Rust twin `query_session_enforce_limit`.
 *
 * @param deps - query dependencies (must be transaction-scoped)
 * @param account_id - the account to enforce the limit for
 * @param max_sessions - maximum number of sessions to keep
 * @returns the number of sessions evicted
 * @mutates `auth_session` table - deletes the oldest rows past the cap
 */
export const query_session_enforce_limit = async (
	deps: QueryDeps,
	account_id: string,
	max_sessions: number
): Promise<number> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM auth_session
		 WHERE id IN (
		   SELECT id FROM auth_session
		   WHERE account_id = $1
		   ORDER BY created_at DESC, id DESC
		   OFFSET $2
		 ) RETURNING id`,
		[account_id, max_sessions]
	);
	return rows.length;
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
		`SELECT ${qualify_columns(AUTH_SESSION_COLUMNS, 's')}, a.username
		 FROM auth_session s
		 JOIN account a ON a.id = s.account_id
		 WHERE s.expires_at > NOW()
		 ORDER BY s.created_at DESC, s.id DESC LIMIT $1`,
		[limit]
	);
};

/**
 * Delete expired sessions.
 *
 * @returns the number of sessions cleaned up
 * @mutates `auth_session` table - deletes every row past `expires_at`
 */
export const query_session_cleanup_expired = async (deps: QueryDeps): Promise<number> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM auth_session WHERE expires_at <= NOW() RETURNING id`
	);
	return rows.length;
};
