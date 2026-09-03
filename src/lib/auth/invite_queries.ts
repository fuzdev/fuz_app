/**
 * Invite database queries.
 *
 * CRUD operations for the invite table — creating invites,
 * finding unclaimed matches, claiming, and cleanup.
 *
 * @module
 */

import type { QueryDeps } from '../db/query_deps.ts';
import { assert_row } from '../db/assert_row.ts';
import { columns_sql, iso8601_timestamp_expr, qualify_columns } from '../db/sql_columns.ts';
import type { Invite, CreateInviteInput, InviteWithUsernamesJson } from './invite_schema.ts';

/**
 * The full `invite` column set, named explicitly so a row read fails loud on
 * schema drift — invite rows ride the `invite_create` / `invite_list` RPC
 * responses raw, so a `SELECT *` would silently carry a dropped or leftover
 * column into the strict-validated wire shapes (see `ACCOUNT_COLUMNS` in
 * `auth/account_queries.ts` for the outage class; the Rust twin names
 * columns at every invite site). Keep in sync with `Invite` and the
 * migration chain's end state.
 */
export const INVITE_COLUMNS = [
	'id',
	'email',
	'username',
	'claimed_by',
	'claimed_at',
	'created_at',
	'created_by'
] as const satisfies ReadonlyArray<keyof Invite>;

/** The `invite` timestamp override, by row qualifier (`''` bare, `i` for the username JOIN). */
const invite_expr = iso8601_timestamp_expr(INVITE_COLUMNS, ['claimed_at', 'created_at']);

/**
 * Create a new invite.
 *
 * @param deps - query dependencies
 * @param input - the invite fields
 * @returns the created invite
 * @mutates `invite` table - inserts the new row
 */
export const query_create_invite = async (
	deps: QueryDeps,
	input: CreateInviteInput
): Promise<Invite> => {
	const row = await deps.db.query_one<Invite>(
		`INSERT INTO invite (email, username, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING ${columns_sql(INVITE_COLUMNS, invite_expr(''))}`,
		[input.email ?? null, input.username ?? null, input.created_by]
	);
	return assert_row(row, 'INSERT INTO invite');
};

/**
 * Find an unclaimed invite by email (case-insensitive).
 */
export const query_invite_find_unclaimed_by_email = async (
	deps: QueryDeps,
	email: string
): Promise<Invite | undefined> => {
	return deps.db.query_one<Invite>(
		`SELECT ${columns_sql(INVITE_COLUMNS, invite_expr(''))} FROM invite WHERE LOWER(email) = LOWER($1) AND claimed_at IS NULL`,
		[email]
	);
};

/**
 * Find an unclaimed invite by username (case-insensitive).
 */
export const query_invite_find_unclaimed_by_username = async (
	deps: QueryDeps,
	username: string
): Promise<Invite | undefined> => {
	return deps.db.query_one<Invite>(
		`SELECT ${columns_sql(INVITE_COLUMNS, invite_expr(''))} FROM invite WHERE LOWER(username) = LOWER($1) AND claimed_at IS NULL`,
		[username]
	);
};

/**
 * Find an unclaimed invite matching email and/or username, taking a
 * row-level write lock on the matched row.
 *
 * Three scoping modes:
 *
 * - **Email-only invite** (email set, username NULL) → matches only if signup provides matching email.
 * - **Username-only invite** (username set, email NULL) → matches only if signup provides matching username.
 * - **Both-field invite** (both set) → requires BOTH email and username to match.
 *
 * Must run inside the same transaction as `query_invite_claim_unscoped`:
 * `FOR UPDATE` makes find + claim atomic, so a concurrent signup that
 * matched the same invite blocks on the lock until this transaction
 * commits/rolls back. After commit, the loser's `find_for_update`
 * returns no row (the winner flipped `claimed_at`) and falls through to
 * `ERROR_NO_MATCHING_INVITE` — no race window between find and claim.
 *
 * @param deps - query dependencies — `deps.db` MUST be a transaction
 * @param email - email to match (or null if signup provides none)
 * @param username - username to match
 * @returns the matching invite (locked), or `undefined`
 */
export const query_invite_find_unclaimed_match_for_update = async (
	deps: QueryDeps,
	email: string | null,
	username: string
): Promise<Invite | undefined> => {
	return deps.db.query_one<Invite>(
		`SELECT ${columns_sql(INVITE_COLUMNS, invite_expr(''))} FROM invite WHERE claimed_at IS NULL AND (
			(email IS NOT NULL AND username IS NULL
			 AND $1::text IS NOT NULL AND LOWER(email) = LOWER($1::text))
			OR
			(username IS NOT NULL AND email IS NULL
			 AND LOWER(username) = LOWER($2))
			OR
			(email IS NOT NULL AND username IS NOT NULL
			 AND $1::text IS NOT NULL AND LOWER(email) = LOWER($1::text)
			 AND LOWER(username) = LOWER($2))
		) ORDER BY invite.created_at ASC, invite.id ASC LIMIT 1
		FOR UPDATE`,
		[email, username]
	);
};

/**
 * Claim an invite by setting the claimed_by and claimed_at fields.
 *
 * The `_unscoped` suffix is the safety signal — the SQL only checks the
 * row state (`claimed_at IS NULL`), not whether the claiming account's
 * email or username matches the invite. Callers must scope the lookup
 * upstream via one of the `_find_unclaimed_match*` siblings (production
 * uses `_for_update` to make find + claim atomic). Skipping the find
 * step lets a caller claim any unclaimed invite by id.
 *
 * Mirrors the `query_session_revoke_by_hash_unscoped` precedent — there
 * is no scoped sibling because the scoping is provided by a separate
 * find query, not by an alternate variant of this query.
 *
 * @param deps - query dependencies
 * @param invite_id - the invite to claim
 * @param account_id - the account claiming the invite
 * @returns true if the invite was claimed, false if already claimed or not found
 * @mutates `invite` row - sets `claimed_by` and `claimed_at` when still unclaimed
 */
export const query_invite_claim_unscoped = async (
	deps: QueryDeps,
	invite_id: string,
	account_id: string
): Promise<boolean> => {
	const rows = await deps.db.query<{ id: string }>(
		`UPDATE invite SET claimed_by = $1, claimed_at = NOW()
		 WHERE id = $2 AND claimed_at IS NULL
		 RETURNING id`,
		[account_id, invite_id]
	);
	return rows.length > 0;
};

/**
 * List all invites, newest first.
 */
export const query_invite_list_all = async (deps: QueryDeps): Promise<Array<Invite>> => {
	return deps.db.query<Invite>(
		`SELECT ${columns_sql(INVITE_COLUMNS, invite_expr(''))} FROM invite ORDER BY invite.created_at DESC`
	);
};

/**
 * List all invites with resolved creator/claimer usernames, newest first.
 *
 * @param deps - query dependencies
 * @returns invites with `created_by_username` and `claimed_by_username`
 */
export const query_invite_list_all_with_usernames = async (
	deps: QueryDeps
): Promise<Array<InviteWithUsernamesJson>> => {
	return deps.db.query<InviteWithUsernamesJson>(
		`SELECT ${qualify_columns(INVITE_COLUMNS, 'i', invite_expr('i'))},
			act.name AS created_by_username,
			a.username AS claimed_by_username
		 FROM invite i
		 LEFT JOIN actor act ON act.id = i.created_by
		 LEFT JOIN account a ON a.id = i.claimed_by
		 ORDER BY i.created_at DESC`
	);
};

/**
 * Delete an unclaimed invite.
 *
 * @param deps - query dependencies
 * @param id - the invite id
 * @returns true if deleted, false if not found or already claimed
 * @mutates `invite` table - deletes the row when still unclaimed
 */
export const query_invite_delete_unclaimed = async (
	deps: QueryDeps,
	id: string
): Promise<boolean> => {
	const rows = await deps.db.query<{ id: string }>(
		`DELETE FROM invite WHERE id = $1 AND claimed_at IS NULL RETURNING id`,
		[id]
	);
	return rows.length > 0;
};
