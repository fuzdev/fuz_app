/**
 * Permit database queries.
 *
 * Permits are time-bounded, revocable grants of a role to an actor.
 * The system is safe by default — no permit, no capability.
 *
 * @module
 */

import type {QueryDeps} from '../db/query_deps.js';
import type {Permit, GrantPermitInput} from './account_schema.js';
import {assert_row} from '../db/assert_row.js';

/**
 * Grant a permit to an actor.
 * Idempotent — if an active permit already exists for this actor and role,
 * returns the existing permit instead of creating a duplicate.
 *
 * @param deps - query dependencies
 * @param input - the permit fields
 * @returns the created or existing active permit
 */
export const query_grant_permit = async (
	deps: QueryDeps,
	input: GrantPermitInput,
): Promise<Permit> => {
	const inserted = await deps.db.query_one<Permit>(
		`INSERT INTO permit (actor_id, role, expires_at, granted_by)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (actor_id, role) WHERE revoked_at IS NULL
		 DO NOTHING
		 RETURNING *`,
		[input.actor_id, input.role, input.expires_at?.toISOString() ?? null, input.granted_by ?? null],
	);
	if (inserted) return inserted;
	// Active permit already exists — return it (idempotent grant).
	const existing = await deps.db.query_one<Permit>(
		`SELECT * FROM permit
		 WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
		[input.actor_id, input.role],
	);
	return assert_row(existing, 'idempotent permit grant');
};

/**
 * Revoke a permit by id, constrained to a specific actor.
 *
 * Requires `actor_id` to prevent cross-account revocation (IDOR guard).
 * Returns `null` if the permit is not found, already revoked, or belongs
 * to a different actor. Returns `{id, role}` on success for audit logging.
 *
 * @param deps - query dependencies
 * @param permit_id - the permit to revoke
 * @param actor_id - the actor that must own the permit
 * @param revoked_by - the actor who revoked it (for audit trail)
 */
export const query_revoke_permit = async (
	deps: QueryDeps,
	permit_id: string,
	actor_id: string,
	revoked_by: string | null,
): Promise<{id: string; role: string} | null> => {
	const rows = await deps.db.query<{id: string; role: string}>(
		`UPDATE permit SET revoked_at = NOW(), revoked_by = $3
		 WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL
		 RETURNING id, role`,
		[permit_id, actor_id, revoked_by ?? null],
	);
	return rows[0] ?? null;
};

/**
 * Find all active (non-revoked, non-expired) permits for an actor.
 */
export const query_permit_find_active_for_actor = async (
	deps: QueryDeps,
	actor_id: string,
): Promise<Array<Permit>> => {
	return deps.db.query<Permit>(
		`SELECT * FROM permit
		 WHERE actor_id = $1
		   AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > NOW())
		 ORDER BY created_at`,
		[actor_id],
	);
};

/**
 * Check if an actor has an active permit for a given role.
 */
export const query_permit_has_role = async (
	deps: QueryDeps,
	actor_id: string,
	role: string,
): Promise<boolean> => {
	const row = await deps.db.query_one<{exists: boolean}>(
		`SELECT EXISTS(
			SELECT 1 FROM permit
			WHERE actor_id = $1
			  AND role = $2
			  AND revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > NOW())
		 ) AS exists`,
		[actor_id, role],
	);
	return row?.exists ?? false;
};

/**
 * List all permits for an actor (including revoked/expired).
 */
export const query_permit_list_for_actor = async (
	deps: QueryDeps,
	actor_id: string,
): Promise<Array<Permit>> => {
	return deps.db.query<Permit>(
		`SELECT * FROM permit WHERE actor_id = $1 ORDER BY created_at DESC`,
		[actor_id],
	);
};

/**
 * Find the account ID of an account that holds an active permit for a given role.
 *
 * Joins permit → actor → account. Returns the first match, or `null` if none.
 *
 * @param deps - query dependencies
 * @param role - the role to search for
 * @returns the account ID, or `null`
 */
export const query_permit_find_account_id_for_role = async (
	deps: QueryDeps,
	role: string,
): Promise<string | null> => {
	const row = await deps.db.query_one<{account_id: string}>(
		`SELECT a.id AS account_id
		 FROM permit p
		 JOIN actor act ON act.id = p.actor_id
		 JOIN account a ON a.id = act.account_id
		 WHERE p.role = $1
		   AND p.revoked_at IS NULL
		   AND (p.expires_at IS NULL OR p.expires_at > NOW())
		 LIMIT 1`,
		[role],
	);
	return row?.account_id ?? null;
};

/**
 * Revoke the active permit for an actor with a given role.
 *
 * Due to the unique partial index on `(actor_id, role) WHERE revoked_at IS NULL`,
 * at most one active permit exists per actor+role combination.
 *
 * @param deps - query dependencies
 * @param actor_id - the actor whose permit to revoke
 * @param role - the role to revoke
 * @param revoked_by - the actor who revoked it (for audit trail)
 * @returns `true` if a permit was revoked, `false` if none was active
 */
export const query_permit_revoke_role = async (
	deps: QueryDeps,
	actor_id: string,
	role: string,
	revoked_by: string | null,
): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(
		`UPDATE permit SET revoked_at = NOW(), revoked_by = $3
		 WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL
		 RETURNING id`,
		[actor_id, role, revoked_by ?? null],
	);
	return rows.length > 0;
};
