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
import {PERMIT_OFFER_SCOPE_SENTINEL_UUID, type PermitOffer} from './permit_offer_schema.js';

/**
 * Grant a permit to an actor.
 * Idempotent — if an active permit already exists for this actor, role, and
 * scope, returns the existing permit instead of creating a duplicate.
 *
 * The `ON CONFLICT` target and the fallback `SELECT` both collapse `NULL`
 * scopes via the same sentinel used by the partial unique index
 * (`permit_actor_role_scope_active_unique`). The `IS NOT DISTINCT FROM`
 * form on the fallback is deliberate — plain `=` would miss the
 * NULL-scope case where the conflict fired.
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
		`INSERT INTO permit (actor_id, role, scope_id, expires_at, granted_by, source_offer_id)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (actor_id, role, COALESCE(scope_id, '${PERMIT_OFFER_SCOPE_SENTINEL_UUID}'::uuid))
		   WHERE revoked_at IS NULL
		 DO NOTHING
		 RETURNING *`,
		[
			input.actor_id,
			input.role,
			input.scope_id ?? null,
			input.expires_at?.toISOString() ?? null,
			input.granted_by ?? null,
			input.source_offer_id ?? null,
		],
	);
	if (inserted) return inserted;
	// Active permit already exists — return it (idempotent grant).
	const existing = await deps.db.query_one<Permit>(
		`SELECT * FROM permit
		 WHERE actor_id = $1
		   AND role = $2
		   AND scope_id IS NOT DISTINCT FROM $3
		   AND revoked_at IS NULL`,
		[input.actor_id, input.role, input.scope_id ?? null],
	);
	return assert_row(existing, 'idempotent permit grant');
};

/**
 * Look up the role of an active permit, constrained to a specific actor.
 *
 * Used by admin routes to inspect the permit's role before acting
 * (e.g., enforcing `web_grantable` on revoke). The actor constraint
 * mirrors `query_revoke_permit` so IDOR protection is consistent:
 * a caller can only see permits belonging to the target actor.
 *
 * Returns `null` if the permit is not found, already revoked, or
 * belongs to a different actor.
 *
 * @param deps - query dependencies
 * @param permit_id - the permit id to look up
 * @param actor_id - the actor that must own the permit
 * @returns `{role}` on a match, or `null`
 */
export const query_permit_find_active_role_for_actor = async (
	deps: QueryDeps,
	permit_id: string,
	actor_id: string,
): Promise<{role: string} | null> => {
	const row = await deps.db.query_one<{role: string}>(
		`SELECT role FROM permit
		 WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
		[permit_id, actor_id],
	);
	return row ?? null;
};

/** Result of {@link query_revoke_permit} — the revoked permit plus any pending offers superseded by the revoke. */
export interface RevokePermitResult {
	id: string;
	role: string;
	scope_id: string | null;
	/**
	 * Pending offers for the revoked permit's `(account, role, scope)` that
	 * were marked superseded as a side effect. The caller is responsible for
	 * emitting a `permit_offer_supersede` audit event per entry (with
	 * `reason: 'permit_revoked'` and `cause_id: <revoked permit id>`).
	 */
	superseded_offers: Array<PermitOffer>;
}

/**
 * Revoke a permit by id, constrained to a specific actor.
 *
 * Requires `actor_id` to prevent cross-account revocation (IDOR guard).
 * Returns `null` if the permit is not found, already revoked, or belongs
 * to a different actor.
 *
 * Supersedes any pending offers for the revoked permit's
 * `(to_account, role, scope)` in the same transaction. Prevents the
 * "accept a pre-revoke offer to bypass the revoke" path — any stale
 * offer becomes terminal at revoke time. A fresh post-revoke grant
 * requires the grantor to call `query_permit_offer_create` again.
 *
 * @param deps - query dependencies
 * @param permit_id - the permit to revoke
 * @param actor_id - the actor that must own the permit
 * @param revoked_by - the actor who revoked it (for audit trail)
 * @param reason - optional free-form reason, stamped on `permit.revoked_reason` and surfaced to the revokee notification.
 */
export const query_revoke_permit = async (
	deps: QueryDeps,
	permit_id: string,
	actor_id: string,
	revoked_by: string | null,
	reason?: string | null,
): Promise<RevokePermitResult | null> => {
	const rows = await deps.db.query<{id: string; role: string; scope_id: string | null}>(
		`UPDATE permit SET revoked_at = NOW(), revoked_by = $3, revoked_reason = $4
		 WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL
		 RETURNING id, role, scope_id`,
		[permit_id, actor_id, revoked_by ?? null, reason ?? null],
	);
	const revoked = rows[0];
	if (!revoked) return null;
	const superseded_offers = await deps.db.query<PermitOffer>(
		`UPDATE permit_offer o
		 SET superseded_at = NOW()
		 FROM actor a
		 WHERE a.id = $1
		   AND o.to_account_id = a.account_id
		   AND o.role = $2
		   AND o.scope_id IS NOT DISTINCT FROM $3
		   AND o.accepted_at IS NULL
		   AND o.declined_at IS NULL
		   AND o.retracted_at IS NULL
		   AND o.superseded_at IS NULL
		 RETURNING o.*`,
		[actor_id, revoked.role, revoked.scope_id],
	);
	return {
		id: revoked.id,
		role: revoked.role,
		scope_id: revoked.scope_id,
		superseded_offers,
	};
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
 *
 * The `scope_id` parameter selects between global and scoped checks:
 * - Omitted or `null` — matches a global permit (`scope_id IS NULL`).
 *   Pre-scope callers keep their existing semantics.
 * - A scope uuid — matches a permit bound to that exact scope.
 *
 * The `IS NOT DISTINCT FROM` comparison handles the NULL case uniformly.
 */
export const query_permit_has_role = async (
	deps: QueryDeps,
	actor_id: string,
	role: string,
	scope_id?: string | null,
): Promise<boolean> => {
	const row = await deps.db.query_one<{exists: boolean}>(
		`SELECT EXISTS(
			SELECT 1 FROM permit
			WHERE actor_id = $1
			  AND role = $2
			  AND scope_id IS NOT DISTINCT FROM $3
			  AND revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > NOW())
		 ) AS exists`,
		[actor_id, role, scope_id ?? null],
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
 * Revoke every active permit an actor holds for a given role.
 *
 * With scoped permits a single actor+role tuple can hold several active
 * permits (one per scope), so this revokes all of them. Pass
 * `query_revoke_permit(permit_id, ...)` when a single scoped permit
 * is the target.
 *
 * Also supersedes pending offers for the actor's account across every
 * scope of this role (the actor can no longer hold the role, so any
 * pending offer of the same role is a bypass vector).
 *
 * @param deps - query dependencies
 * @param actor_id - the actor whose permits to revoke
 * @param role - the role to revoke
 * @param revoked_by - the actor who revoked it (for audit trail)
 * @param reason - optional free-form reason, stamped on `permit.revoked_reason`.
 * @returns `true` if at least one permit was revoked, `false` if none was active
 */
export const query_permit_revoke_role = async (
	deps: QueryDeps,
	actor_id: string,
	role: string,
	revoked_by: string | null,
	reason?: string | null,
): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(
		`UPDATE permit SET revoked_at = NOW(), revoked_by = $3, revoked_reason = $4
		 WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL
		 RETURNING id`,
		[actor_id, role, revoked_by ?? null, reason ?? null],
	);
	if (rows.length === 0) return false;
	await deps.db.query(
		`UPDATE permit_offer o
		 SET superseded_at = NOW()
		 FROM actor a
		 WHERE a.id = $1
		   AND o.to_account_id = a.account_id
		   AND o.role = $2
		   AND o.accepted_at IS NULL
		   AND o.declined_at IS NULL
		   AND o.retracted_at IS NULL
		   AND o.superseded_at IS NULL`,
		[actor_id, role],
	);
	return true;
};
