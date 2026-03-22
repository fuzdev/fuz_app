/**
 * Invite database queries.
 *
 * CRUD operations for the invite table — creating invites,
 * finding unclaimed matches, claiming, and cleanup.
 *
 * @module
 */

import type {QueryDeps} from '../db/query_deps.js';
import {assert_row} from '../db/assert_row.js';
import type {Invite, CreateInviteInput, InviteWithUsernamesJson} from './invite_schema.js';

/**
 * Create a new invite.
 *
 * @param deps - query dependencies
 * @param input - the invite fields
 * @returns the created invite
 */
export const query_create_invite = async (
	deps: QueryDeps,
	input: CreateInviteInput,
): Promise<Invite> => {
	const row = await deps.db.query_one<Invite>(
		`INSERT INTO invite (email, username, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING *`,
		[input.email ?? null, input.username ?? null, input.created_by],
	);
	return assert_row(row, 'INSERT INTO invite');
};

/**
 * Find an unclaimed invite by email (case-insensitive).
 */
export const query_invite_find_unclaimed_by_email = async (
	deps: QueryDeps,
	email: string,
): Promise<Invite | undefined> => {
	return deps.db.query_one<Invite>(
		`SELECT * FROM invite WHERE LOWER(email) = LOWER($1) AND claimed_at IS NULL`,
		[email],
	);
};

/**
 * Find an unclaimed invite by username (case-insensitive).
 */
export const query_invite_find_unclaimed_by_username = async (
	deps: QueryDeps,
	username: string,
): Promise<Invite | undefined> => {
	return deps.db.query_one<Invite>(
		`SELECT * FROM invite WHERE LOWER(username) = LOWER($1) AND claimed_at IS NULL`,
		[username],
	);
};

/**
 * Find an unclaimed invite matching email and/or username using three scoping modes:
 *
 * - **Email-only invite** (email set, username NULL) → matches only if signup provides matching email.
 * - **Username-only invite** (username set, email NULL) → matches only if signup provides matching username.
 * - **Both-field invite** (both set) → requires BOTH email and username to match.
 *
 * @param deps - query dependencies
 * @param email - email to match (or null if signup provides none)
 * @param username - username to match
 * @returns the matching invite, or `undefined`
 */
export const query_invite_find_unclaimed_match = async (
	deps: QueryDeps,
	email: string | null,
	username: string,
): Promise<Invite | undefined> => {
	return deps.db.query_one<Invite>(
		`SELECT * FROM invite WHERE claimed_at IS NULL AND (
			(email IS NOT NULL AND username IS NULL
			 AND $1::text IS NOT NULL AND LOWER(email) = LOWER($1::text))
			OR
			(username IS NOT NULL AND email IS NULL
			 AND LOWER(username) = LOWER($2))
			OR
			(email IS NOT NULL AND username IS NOT NULL
			 AND $1::text IS NOT NULL AND LOWER(email) = LOWER($1::text)
			 AND LOWER(username) = LOWER($2))
		) ORDER BY created_at ASC, id ASC LIMIT 1`,
		[email, username],
	);
};

/**
 * Claim an invite by setting the claimed_by and claimed_at fields.
 *
 * @param deps - query dependencies
 * @param invite_id - the invite to claim
 * @param account_id - the account claiming the invite
 * @returns true if the invite was claimed, false if already claimed or not found
 */
export const query_invite_claim = async (
	deps: QueryDeps,
	invite_id: string,
	account_id: string,
): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(
		`UPDATE invite SET claimed_by = $1, claimed_at = NOW()
		 WHERE id = $2 AND claimed_at IS NULL
		 RETURNING id`,
		[account_id, invite_id],
	);
	return rows.length > 0;
};

/**
 * List all invites, newest first.
 */
export const query_invite_list_all = async (deps: QueryDeps): Promise<Array<Invite>> => {
	return deps.db.query<Invite>(`SELECT * FROM invite ORDER BY created_at DESC`);
};

/**
 * List all invites with resolved creator/claimer usernames, newest first.
 *
 * @param deps - query dependencies
 * @returns invites with `created_by_username` and `claimed_by_username`
 */
export const query_invite_list_all_with_usernames = async (
	deps: QueryDeps,
): Promise<Array<InviteWithUsernamesJson>> => {
	return deps.db.query<InviteWithUsernamesJson>(
		`SELECT i.*,
			act.name AS created_by_username,
			a.username AS claimed_by_username
		 FROM invite i
		 LEFT JOIN actor act ON act.id = i.created_by
		 LEFT JOIN account a ON a.id = i.claimed_by
		 ORDER BY i.created_at DESC`,
	);
};

/**
 * Delete an unclaimed invite.
 *
 * @param deps - query dependencies
 * @param id - the invite id
 * @returns true if deleted, false if not found or already claimed
 */
export const query_invite_delete_unclaimed = async (
	deps: QueryDeps,
	id: string,
): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(
		`DELETE FROM invite WHERE id = $1 AND claimed_at IS NULL RETURNING id`,
		[id],
	);
	return rows.length > 0;
};
