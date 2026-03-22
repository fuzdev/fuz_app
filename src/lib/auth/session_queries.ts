/**
 * Auth session database queries.
 *
 * Server-side sessions keyed by blake3 hash of the session token.
 * The cookie contains the raw token; the database stores only the hash.
 *
 * @module
 */

import {hash_blake3} from '@fuzdev/fuz_util/hash_blake3.js';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {generate_random_base64url} from '../crypto.js';
import type {QueryDeps} from '../db/query_deps.js';
import type {AuthSession} from './account_schema.js';

/** Session lifetime in milliseconds (30 days). */
export const AUTH_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Extend session when it has less than this remaining (1 day in ms). */
export const AUTH_SESSION_EXTEND_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Hash a session token to its storage key using blake3.
 *
 * @param token - the raw session token
 * @returns hex-encoded blake3 hash
 */
export const hash_session_token = (token: string): string => {
	return hash_blake3(token);
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
 */
export const query_create_session = async (
	deps: QueryDeps,
	token_hash: string,
	account_id: string,
	expires_at: Date,
): Promise<void> => {
	await deps.db.query(`INSERT INTO auth_session (id, account_id, expires_at) VALUES ($1, $2, $3)`, [
		token_hash,
		account_id,
		expires_at.toISOString(),
	]);
};

/**
 * Get a session if it exists, is not expired, and has not been revoked.
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token
 */
export const query_session_get_valid = async (
	deps: QueryDeps,
	token_hash: string,
): Promise<AuthSession | undefined> => {
	return deps.db.query_one<AuthSession>(
		`SELECT * FROM auth_session WHERE id = $1 AND expires_at > NOW()`,
		[token_hash],
	);
};

/**
 * Update `last_seen_at` and optionally extend expiry for a session.
 *
 * Extends if less than `AUTH_SESSION_EXTEND_THRESHOLD_MS` remaining.
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token
 */
export const query_session_touch = async (deps: QueryDeps, token_hash: string): Promise<void> => {
	const new_expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
	await deps.db.query(
		`UPDATE auth_session
		 SET last_seen_at = NOW(),
		     expires_at = CASE
		       WHEN expires_at - NOW() < INTERVAL '1 day' THEN $2::timestamptz
		       ELSE expires_at
		     END
		 WHERE id = $1`,
		[token_hash, new_expires.toISOString()],
	);
};

/**
 * Revoke (delete) a session by its token hash.
 *
 * No account_id constraint — caller must ensure the hash comes from a
 * trusted source (e.g. the authenticated session cookie). For user-facing
 * revocation of a specific session by ID, prefer `query_session_revoke_for_account`
 * which includes an IDOR guard.
 */
export const query_session_revoke_by_hash = async (
	deps: QueryDeps,
	token_hash: string,
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
 */
export const query_session_revoke_for_account = async (
	deps: QueryDeps,
	token_hash: string,
	account_id: string,
): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM auth_session WHERE id = $1 AND account_id = $2 RETURNING id`,
		[token_hash, account_id],
	);
	return rows.length > 0;
};

/**
 * Revoke all sessions for an account.
 *
 * @returns the number of sessions revoked
 */
export const query_session_revoke_all_for_account = async (
	deps: QueryDeps,
	account_id: string,
): Promise<number> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM auth_session WHERE account_id = $1 RETURNING id`,
		[account_id],
	);
	return rows.length;
};

/**
 * List sessions for an account, newest first.
 */
export const query_session_list_for_account = async (
	deps: QueryDeps,
	account_id: string,
	limit = 50,
): Promise<Array<AuthSession>> => {
	return deps.db.query<AuthSession>(
		`SELECT * FROM auth_session WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
		[account_id, limit],
	);
};

/**
 * Enforce a per-account session limit by evicting the oldest sessions.
 *
 * Keeps the newest `max_sessions` sessions and deletes the rest.
 *
 * Race safety: this function must run inside a transaction alongside the
 * INSERT that created the new session. All callers satisfy this requirement:
 * - `POST /login` and `POST /tokens/create` use the default `transaction: true`
 *   (framework-managed transaction wrapping in `apply_route_specs`)
 * - `POST /bootstrap` and `POST /signup` manage their own transactions
 *   and pass the transaction-scoped `deps` to `create_session_and_set_cookie`
 *
 * The transaction ensures the INSERT + enforce_limit pair is atomic —
 * concurrent session creation cannot interleave between the two statements.
 *
 * @param deps - query dependencies (must be transaction-scoped)
 * @param account_id - the account to enforce the limit for
 * @param max_sessions - maximum number of sessions to keep
 * @returns the number of sessions evicted
 */
export const query_session_enforce_limit = async (
	deps: QueryDeps,
	account_id: string,
	max_sessions: number,
): Promise<number> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM auth_session
		 WHERE id IN (
		   SELECT id FROM auth_session
		   WHERE account_id = $1
		   ORDER BY created_at DESC
		   OFFSET $2
		 ) RETURNING id`,
		[account_id, max_sessions],
	);
	return rows.length;
};

/**
 * List all active sessions across all accounts with usernames.
 *
 * @param deps - query dependencies
 * @param limit - maximum entries to return
 * @returns active sessions joined with account usernames, newest activity first
 */
export const query_session_list_all_active = async (
	deps: QueryDeps,
	limit = 200,
): Promise<Array<AuthSession & {username: string}>> => {
	return deps.db.query<AuthSession & {username: string}>(
		`SELECT s.id, s.account_id, s.created_at, s.expires_at, s.last_seen_at, a.username
		 FROM auth_session s
		 JOIN account a ON a.id = s.account_id
		 WHERE s.expires_at > NOW()
		 ORDER BY s.last_seen_at DESC LIMIT $1`,
		[limit],
	);
};

/**
 * Delete expired sessions.
 *
 * @returns the number of sessions cleaned up
 */
export const query_session_cleanup_expired = async (deps: QueryDeps): Promise<number> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM auth_session WHERE expires_at <= NOW() RETURNING id`,
	);
	return rows.length;
};

/**
 * Touch a session without blocking the caller.
 *
 * Errors are logged to console — session touching never breaks request flows.
 * Pass `pending_effects` (from `c.var.pending_effects`) to register
 * the promise for test flushing.
 *
 * @param deps - query dependencies
 * @param token_hash - blake3 hash of the session token
 * @param pending_effects - optional array to register the effect for later awaiting
 * @param log - the logger instance
 * @returns the settled promise (callers may ignore it — fire-and-forget semantics preserved)
 */
export const session_touch_fire_and_forget = (
	deps: QueryDeps,
	token_hash: string,
	pending_effects: Array<Promise<void>> | undefined,
	log: Logger,
): Promise<void> => {
	const p = query_session_touch(deps, token_hash).catch((err) => {
		log.error('Session touch failed:', err);
	});
	pending_effects?.push(p);
	return p;
};
