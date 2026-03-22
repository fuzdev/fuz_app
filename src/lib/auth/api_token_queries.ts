/**
 * API token query functions for token CRUD and validation.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {QueryDeps} from '../db/query_deps.js';
import {assert_row} from '../db/assert_row.js';
import type {ApiToken} from './account_schema.js';
import {hash_api_token} from './api_token.js';

/** Extended deps for `query_validate_api_token` which needs a logger. */
export interface ApiTokenQueryDeps extends QueryDeps {
	log: Logger;
}

/**
 * Store a new API token (the hash, not the raw token).
 *
 * @param deps - query dependencies
 * @param id - the public token id (e.g. `tok_abc123`)
 * @param account_id - the owning account
 * @param name - human-readable name
 * @param token_hash - blake3 hash of the raw token
 * @param expires_at - optional expiration
 * @returns the stored token record
 */
export const query_create_api_token = async (
	deps: QueryDeps,
	id: string,
	account_id: string,
	name: string,
	token_hash: string,
	expires_at?: Date | null,
): Promise<ApiToken> => {
	const row = await deps.db.query_one<ApiToken>(
		`INSERT INTO api_token (id, account_id, name, token_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING *`,
		[id, account_id, name, token_hash, expires_at?.toISOString() ?? null],
	);
	return assert_row(row, 'INSERT INTO api_token');
};

/**
 * Validate a raw API token and return the token record.
 *
 * Hashes the token with blake3, looks up the hash, and checks
 * expiration. Updates `last_used_at` and `last_used_ip` on success
 * (fire-and-forget — errors logged, never thrown).
 *
 * @param deps - query dependencies with logger
 * @param raw_token - the raw API token from the Authorization header
 * @param ip - the client IP address (for audit)
 * @param pending_effects - optional array to register the usage-tracking effect for later awaiting
 * @returns the token record if valid, or `undefined`
 */
export const query_validate_api_token = async (
	deps: ApiTokenQueryDeps,
	raw_token: string,
	ip: string | undefined,
	pending_effects: Array<Promise<void>> | undefined,
): Promise<ApiToken | undefined> => {
	const token_hash = hash_api_token(raw_token);
	const row = await deps.db.query_one<ApiToken>(
		`SELECT * FROM api_token
		 WHERE token_hash = $1
		   AND (expires_at IS NULL OR expires_at > NOW())`,
		[token_hash],
	);
	if (!row) return undefined;

	// Fire-and-forget usage tracking
	const p: Promise<void> = deps.db
		.query(`UPDATE api_token SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2`, [
			ip ?? null,
			row.id,
		])
		.then(() => {}) // eslint-disable-line @typescript-eslint/no-empty-function
		.catch((err) => {
			deps.log.error('Failed to update last_used_at:', err);
		});
	pending_effects?.push(p);

	return row;
};

/**
 * Revoke all tokens for an account.
 *
 * @param deps - query dependencies
 * @param account_id - the account whose tokens to revoke
 * @returns the number of tokens revoked
 */
export const query_revoke_all_api_tokens_for_account = async (
	deps: QueryDeps,
	account_id: string,
): Promise<number> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM api_token WHERE account_id = $1 RETURNING id`,
		[account_id],
	);
	return rows.length;
};

/**
 * Revoke a token only if it belongs to the specified account.
 *
 * Prevents cross-account token revocation.
 *
 * @param deps - query dependencies
 * @param id - the public token id
 * @param account_id - the account that must own the token
 * @returns `true` if a token was revoked, `false` if not found or wrong account
 */
export const query_revoke_api_token_for_account = async (
	deps: QueryDeps,
	id: string,
	account_id: string,
): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM api_token WHERE id = $1 AND account_id = $2 RETURNING id`,
		[id, account_id],
	);
	return rows.length > 0;
};

/**
 * List all tokens for an account (does not include hashes).
 *
 * Columns are enumerated explicitly to exclude `token_hash`.
 * Must be updated if the `api_token` table gains new columns.
 */
export const query_api_token_list_for_account = async (
	deps: QueryDeps,
	account_id: string,
): Promise<Array<Omit<ApiToken, 'token_hash'>>> => {
	return deps.db.query<Omit<ApiToken, 'token_hash'>>(
		`SELECT id, account_id, name, expires_at, last_used_at, last_used_ip, created_at
		 FROM api_token WHERE account_id = $1 ORDER BY created_at DESC`,
		[account_id],
	);
};

/**
 * Enforce a per-account token limit by evicting the oldest tokens.
 *
 * Race safety: this function must run inside a transaction alongside the
 * INSERT that created the new token. The caller (`POST /tokens/create`)
 * uses the default `transaction: true` (framework-managed transaction
 * wrapping in `apply_route_specs`), ensuring the INSERT + enforce_limit
 * pair is atomic — concurrent token creation cannot interleave.
 *
 * @param deps - query dependencies (must be transaction-scoped)
 * @param account_id - the account to enforce the limit for
 * @param max_tokens - maximum number of tokens to keep
 * @returns the number of tokens evicted
 */
export const query_api_token_enforce_limit = async (
	deps: QueryDeps,
	account_id: string,
	max_tokens: number,
): Promise<number> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM api_token
		 WHERE id IN (
		   SELECT id FROM api_token
		   WHERE account_id = $1
		   ORDER BY created_at DESC
		   OFFSET $2
		 ) RETURNING id`,
		[account_id, max_tokens],
	);
	return rows.length;
};
