/**
 * Role grant database queries.
 *
 * Role grants are time-bounded, revocable grants of a role to an actor.
 * The system is safe by default — no role_grant, no capability.
 *
 * @module
 */

import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {QueryDeps} from '../db/query_deps.js';
import type {RoleGrant, CreateRoleGrantInput} from './account_schema.js';
import {assert_row} from '../db/assert_row.js';
import {
	ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN,
	ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID,
} from './role_grant_offer_ddl.js';
import type {SupersededOffer} from './role_grant_offer_schema.js';

/**
 * Grant a role_grant to an actor.
 * Idempotent — if an active role_grant already exists for this actor, role, and
 * scope, returns the existing role_grant instead of creating a duplicate.
 *
 * The `ON CONFLICT` target and the fallback `SELECT` both collapse `NULL`
 * scopes via the same sentinel + index-side `'GLOBAL'` token used by the
 * partial unique index (`role_grant_actor_role_scope_active_unique`). The
 * `IS NOT DISTINCT FROM` form on the fallback is deliberate — plain `=`
 * would miss the NULL-scope case where the conflict fired.
 *
 * `scope_kind` is paired-null with `scope_id` per the
 * `role_grant_scope_kind_paired` CHECK; mismatched pairs raise at the DB
 * layer rather than producing silent rows.
 *
 * @param deps - query dependencies
 * @param input - the role_grant fields
 * @returns the created or existing active role_grant
 * @mutates `role_grant` table - inserts a row when no active role_grant matches `(actor_id, role, scope_kind, scope_id)`
 */
export const query_create_role_grant = async (
	deps: QueryDeps,
	input: CreateRoleGrantInput,
): Promise<RoleGrant> => {
	const inserted = await deps.db.query_one<RoleGrant>(
		`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id, expires_at, granted_by, source_offer_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (
		   actor_id,
		   role,
		   COALESCE(scope_kind, '${ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN}'),
		   COALESCE(scope_id, '${ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID}'::uuid)
		 )
		   WHERE revoked_at IS NULL
		 DO NOTHING
		 RETURNING *`,
		[
			input.actor_id,
			input.role,
			input.scope_kind ?? null,
			input.scope_id ?? null,
			input.expires_at?.toISOString() ?? null,
			input.granted_by ?? null,
			input.source_offer_id ?? null,
		],
	);
	if (inserted) return inserted;
	// Active role_grant already exists — return it (idempotent grant).
	const existing = await deps.db.query_one<RoleGrant>(
		`SELECT * FROM role_grant
		 WHERE actor_id = $1
		   AND role = $2
		   AND scope_kind IS NOT DISTINCT FROM $3
		   AND scope_id IS NOT DISTINCT FROM $4
		   AND revoked_at IS NULL`,
		[input.actor_id, input.role, input.scope_kind ?? null, input.scope_id ?? null],
	);
	return assert_row(existing, 'idempotent role_grant grant');
};

/**
 * Look up the role of an active role_grant (constrained to a specific
 * actor) plus the actor's `account_id`.
 *
 * Used by admin routes to inspect the role_grant's role before acting
 * (e.g., enforcing the admin-grant-path gate on revoke). The actor constraint
 * mirrors `query_revoke_role_grant` so IDOR protection is consistent:
 * a caller can only see role_grants belonging to the target actor.
 *
 * The JOIN to `actor` collapses what used to be a second
 * `query_actor_by_id` round-trip in the revoke handler into one read,
 * which closes the small TOCTOU window where the actor row could be
 * deleted between the IDOR check and the actor lookup. The `account_id`
 * is needed by the audit envelope's `target_account_id` field and the
 * SSE/WS socket-close fan-out targeting.
 *
 * Returns `null` if the role_grant is not found, already revoked, or
 * belongs to a different actor.
 *
 * @param deps - query dependencies
 * @param role_grant_id - the role_grant id to look up
 * @param actor_id - the actor that must own the role_grant
 * @returns `{role, account_id}` on a match, or `null`
 */
export const query_role_grant_find_active_role_for_actor = async (
	deps: QueryDeps,
	role_grant_id: string,
	actor_id: string,
): Promise<{role: string; account_id: Uuid} | null> => {
	const row = await deps.db.query_one<{role: string; account_id: Uuid}>(
		`SELECT role_grant.role, actor.account_id
		   FROM role_grant
		   JOIN actor ON actor.id = role_grant.actor_id
		  WHERE role_grant.id = $1 AND role_grant.actor_id = $2 AND role_grant.revoked_at IS NULL`,
		[role_grant_id, actor_id],
	);
	return row ?? null;
};

/** Result of `query_revoke_role_grant` — the revoked role_grant plus any pending offers superseded by the revoke. */
export interface RevokeRoleGrantResult {
	id: Uuid;
	role: string;
	scope_kind: string | null;
	scope_id: Uuid | null;
	/**
	 * Pending offers for the revoked role_grant's `(account, role, scope)` that
	 * were marked superseded as a side effect. Each entry carries its
	 * grantor's `from_account_id` so callers can fan out
	 * `role_grant_offer_supersede` notifications without a second round-trip.
	 * The caller is responsible for emitting a `role_grant_offer_supersede`
	 * audit event per entry (with `reason: 'role_grant_revoked'` and
	 * `cause_id: <revoked role_grant id>`).
	 */
	superseded_offers: Array<SupersededOffer>;
}

/**
 * Revoke a role_grant by id, constrained to a specific actor.
 *
 * Requires `actor_id` to prevent cross-account revocation (IDOR guard).
 * Returns `null` if the role_grant is not found, already revoked, or belongs
 * to a different actor.
 *
 * Supersedes any pending offers for the revoked role_grant's
 * `(to_account, role, scope)` in the same transaction. Prevents the
 * "accept a pre-revoke offer to bypass the revoke" path — any stale
 * offer becomes terminal at revoke time. A fresh post-revoke grant
 * requires the grantor to call `query_role_grant_offer_create` again.
 *
 * @param deps - query dependencies
 * @param role_grant_id - the role_grant to revoke
 * @param actor_id - the actor that must own the role_grant
 * @param revoked_by - the actor who revoked it (for audit trail)
 * @param reason - optional free-form reason, stamped on `role_grant.revoked_reason` and surfaced to the revokee notification.
 * @mutates `role_grant` row - sets `revoked_at`, `revoked_by`, and `revoked_reason`
 * @mutates `role_grant_offer` rows - stamps `superseded_at` on every pending sibling for the same `(account, role, scope)`
 */
export const query_revoke_role_grant = async (
	deps: QueryDeps,
	role_grant_id: Uuid,
	actor_id: Uuid,
	revoked_by: Uuid | null,
	reason?: string | null,
): Promise<RevokeRoleGrantResult | null> => {
	const rows = await deps.db.query<{
		id: Uuid;
		role: string;
		scope_kind: string | null;
		scope_id: Uuid | null;
	}>(
		`UPDATE role_grant SET revoked_at = NOW(), revoked_by = $3, revoked_reason = $4
		 WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL
		 RETURNING id, role, scope_kind, scope_id`,
		[role_grant_id, actor_id, revoked_by ?? null, reason ?? null],
	);
	const revoked = rows[0];
	if (!revoked) return null;
	// CTE joins `actor` after the UPDATE so each superseded row carries the
	// grantor's `account_id` — callers fan out `role_grant_offer_supersede`
	// notifications to that account without a second round-trip. The match
	// keys on `scope_id` only because the (scope_kind, scope_id) pair-CHECK
	// makes scope_kind a function of scope_id; matching on both adds no
	// new selectivity in v1.
	const superseded_offers = await deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer o
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
			RETURNING o.*
		)
		SELECT u.*, grantor.account_id AS from_account_id
		FROM updated u
		JOIN actor grantor ON grantor.id = u.from_actor_id`,
		[actor_id, revoked.role, revoked.scope_id],
	);
	return {
		id: revoked.id,
		role: revoked.role,
		scope_kind: revoked.scope_kind,
		scope_id: revoked.scope_id,
		superseded_offers,
	};
};

/**
 * Find all active (non-revoked, non-expired) role_grants for an actor.
 */
export const query_role_grant_find_active_for_actor = async (
	deps: QueryDeps,
	actor_id: string,
): Promise<Array<RoleGrant>> => {
	return deps.db.query<RoleGrant>(
		`SELECT * FROM role_grant
		 WHERE actor_id = $1
		   AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > NOW())
		 ORDER BY created_at`,
		[actor_id],
	);
};

/**
 * Check if an actor has an active role_grant for a given role.
 *
 * The `scope_id` parameter selects between global and scoped checks:
 * - Omitted or `null` — matches a global role_grant (`scope_id IS NULL`).
 *   Pre-scope callers keep their existing semantics.
 * - A scope uuid — matches a role_grant bound to that exact scope.
 *
 * The `IS NOT DISTINCT FROM` comparison handles the NULL case uniformly.
 */
export const query_role_grant_has_role = async (
	deps: QueryDeps,
	actor_id: string,
	role: string,
	scope_id?: string | null,
): Promise<boolean> => {
	const row = await deps.db.query_one<{exists: boolean}>(
		`SELECT EXISTS(
			SELECT 1 FROM role_grant
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
 * Account-grain check: does any actor on `account_id` hold an active
 * global role_grant for `role`?
 *
 * Symmetric with `query_role_grant_has_role` but keyed on the account
 * instead of a single actor — for surfaces with `auth: actor: 'none'`
 * that don't load `auth.role_grants` and can't use the in-memory
 * `has_scoped_role` predicate. Joins `role_grant` → `actor`; matches
 * only global role_grants (`scope_id IS NULL`) since the use case is
 * "is the caller's account broadly admin", not scope-aware.
 *
 * Fast under the existing `idx_role_grant_actor` index — the inner
 * `actor_id IN (...)` subquery is index-scan, and the outer EXISTS
 * stops at the first match.
 *
 * @param deps - query dependencies
 * @param account_id - the account to check
 * @param role - the role to check for (e.g. `ROLE_ADMIN`)
 * @returns `true` if any actor on the account has an active global role_grant for `role`
 */
export const query_account_has_global_role = async (
	deps: QueryDeps,
	account_id: string,
	role: string,
): Promise<boolean> => {
	const row = await deps.db.query_one<{exists: boolean}>(
		`SELECT EXISTS(
			SELECT 1 FROM role_grant
			WHERE actor_id IN (SELECT id FROM actor WHERE account_id = $1)
			  AND role = $2
			  AND scope_id IS NULL
			  AND revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > NOW())
		 ) AS exists`,
		[account_id, role],
	);
	return row?.exists ?? false;
};

/**
 * List all role_grants for an actor (including revoked/expired).
 */
export const query_role_grant_list_for_actor = async (
	deps: QueryDeps,
	actor_id: string,
): Promise<Array<RoleGrant>> => {
	return deps.db.query<RoleGrant>(
		`SELECT * FROM role_grant WHERE actor_id = $1 ORDER BY created_at DESC`,
		[actor_id],
	);
};

/**
 * Find the account ID of an account that holds an active role_grant for a given role.
 *
 * Joins role_grant → actor → account. Returns the first match, or `null` if none.
 *
 * @param deps - query dependencies
 * @param role - the role to search for
 * @returns the account ID, or `null`
 */
export const query_role_grant_find_account_id_for_role = async (
	deps: QueryDeps,
	role: string,
): Promise<string | null> => {
	const row = await deps.db.query_one<{account_id: string}>(
		`SELECT a.id AS account_id
		 FROM role_grant p
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

/** Result of `query_role_grant_revoke_for_scope` — every role_grant revoked plus every pending offer superseded by the scope-wide cascade. */
export interface RevokeForScopeResult {
	/**
	 * One entry per role_grant revoked by this call. Carries both the revokee's
	 * `actor_id` (the role_grant's grantee — drives `target_actor_id` audit
	 * envelopes) and `account_id` (the actor's account — drives
	 * `target_account_id` for SSE/WS socket-close fan-out). Empty array
	 * means no active role_grant was bound to the scope. `scope_kind` is
	 * surfaced for forensic completeness; the cascade itself keys on
	 * `scope_id` regardless of kind.
	 */
	revoked: Array<{
		role_grant_id: Uuid;
		role: string;
		scope_kind: string | null;
		scope_id: Uuid;
		actor_id: Uuid;
		account_id: Uuid;
	}>;
	/**
	 * Every pending offer at the scope — tuple-matched and orphan, undifferentiated
	 * — superseded in the same cascade. Each entry carries its grantor's
	 * `from_account_id` for `role_grant_offer_supersede` notification fan-out.
	 *
	 * The caller is responsible for emitting `role_grant_offer_supersede` audit
	 * events with `reason: 'scope_destroyed'` and `cause_id: <destroyed scope row id>`
	 * per entry — the cause of every supersede here is the scope deletion,
	 * not any individual role_grant revoke (the revokes are themselves
	 * consequences of the scope going away).
	 */
	superseded_offers: Array<SupersededOffer>;
}

/**
 * Revoke every active role_grant bound to a scope and supersede every pending
 * offer at the scope, in one cascade.
 *
 * Use this from a consumer's parent-scope delete handler (e.g., classroom
 * deletion) — `role_grant.scope_id` and `role_grant_offer.scope_id` are polymorphic
 * with no FK constraint by design, so a parent row deletion would otherwise
 * orphan role_grants and offers. The cascade is **role-agnostic**: anything
 * attached to the destroyed scope is cleaned up.
 *
 * Both updates run as separate statements inside the caller's transaction
 * (mirrors `query_role_grant_revoke_role`'s shape). The two halves are
 * independent — orphan pending offers can exist at a scope with no active
 * role_grants, so the supersede half always runs even when no role_grant was
 * revoked.
 *
 * @param deps - query dependencies
 * @param scope_id - the scope whose role_grants and offers to terminate
 * @param revoked_by - the actor performing the cascade (audit trail)
 * @param reason - optional free-form reason, stamped on `role_grant.revoked_reason`.
 * @returns the revoked role_grants (with `account_id` for fan-out) and superseded offers (with `from_account_id` for fan-out)
 * @mutates `role_grant` table - sets `revoked_at`/`revoked_by`/`revoked_reason` on every active row at `scope_id`
 * @mutates `role_grant_offer` table - stamps `superseded_at` on every pending row at `scope_id`
 */
export const query_role_grant_revoke_for_scope = async (
	deps: QueryDeps,
	scope_id: Uuid,
	revoked_by: Uuid | null,
	reason?: string | null,
): Promise<RevokeForScopeResult> => {
	// Revoke every active role_grant at the scope. CTE returns `actor_id` directly
	// from the role_grant row (drives `target_actor_id` audit envelopes); a join
	// against `actor` resolves `account_id` for `target_account_id`
	// + WS/SSE socket-close fan-out, all in one round-trip.
	const revoked = await deps.db.query<{
		role_grant_id: Uuid;
		role: string;
		scope_kind: string | null;
		scope_id: Uuid;
		actor_id: Uuid;
		account_id: Uuid;
	}>(
		`WITH updated AS (
			UPDATE role_grant
			SET revoked_at = NOW(), revoked_by = $2, revoked_reason = $3
			WHERE scope_id = $1 AND revoked_at IS NULL
			RETURNING id, role, scope_kind, scope_id, actor_id
		)
		SELECT u.id AS role_grant_id, u.role, u.scope_kind, u.scope_id, u.actor_id, a.account_id
		FROM updated u
		JOIN actor a ON a.id = u.actor_id`,
		[scope_id, revoked_by ?? null, reason ?? null],
	);
	// Supersede every pending offer at the scope — tuple-matched or orphan,
	// no distinction. The cause of every supersede in this cascade is the
	// scope deletion; offers tuple-matched to a revoked role_grant are not
	// tagged separately because the revoke is itself a consequence of the
	// scope going away.
	const superseded_offers = await deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer o
			SET superseded_at = NOW()
			WHERE o.scope_id = $1
			  AND o.accepted_at IS NULL
			  AND o.declined_at IS NULL
			  AND o.retracted_at IS NULL
			  AND o.superseded_at IS NULL
			RETURNING o.*
		)
		SELECT u.*, grantor.account_id AS from_account_id
		FROM updated u
		JOIN actor grantor ON grantor.id = u.from_actor_id`,
		[scope_id],
	);
	return {revoked, superseded_offers};
};

/** Result of `query_role_grant_revoke_role` — every role_grant revoked plus the pending offers superseded by the bulk revoke. */
export interface RevokeRoleResult {
	/**
	 * One entry per role_grant revoked by this call. Carries the revokee's
	 * `account_id` so callers can fan out a `role_grant_revoke` notification per
	 * scope-instance. Empty array means nothing was active for `(actor, role)`.
	 */
	revoked: Array<{
		role_grant_id: string;
		role: string;
		scope_kind: string | null;
		scope_id: string | null;
		account_id: string;
	}>;
	/**
	 * Pending offers for the actor's account+role (all scopes) superseded by
	 * the bulk revoke. Each entry carries its grantor's `from_account_id` so
	 * callers can fan out `role_grant_offer_supersede` notifications without a
	 * second round-trip.
	 */
	superseded_offers: Array<SupersededOffer>;
}

/**
 * Revoke every active role_grant an actor holds for a given role.
 *
 * With scoped role_grants a single actor+role tuple can hold several active
 * role_grants (one per scope), so this revokes all of them. Pass
 * `query_revoke_role_grant(role_grant_id, ...)` when a single scoped role_grant
 * is the target.
 *
 * Also supersedes pending offers for the actor's account across every
 * scope of this role (the actor can no longer hold the role, so any
 * pending offer of the same role is a bypass vector).
 *
 * @param deps - query dependencies
 * @param actor_id - the actor whose role_grants to revoke
 * @param role - the role to revoke
 * @param revoked_by - the actor who revoked it (for audit trail)
 * @param reason - optional free-form reason, stamped on `role_grant.revoked_reason`.
 * @returns the list of revoked role_grants (empty if none were active) and superseded pending offers
 * @mutates `role_grant` table - sets `revoked_at`/`revoked_by`/`revoked_reason` on every active row for `(actor, role)`
 * @mutates `role_grant_offer` table - stamps `superseded_at` on every matching pending offer
 */
export const query_role_grant_revoke_role = async (
	deps: QueryDeps,
	actor_id: string,
	role: string,
	revoked_by: string | null,
	reason?: string | null,
): Promise<RevokeRoleResult> => {
	// CTE pulls the revokee's `account_id` via a join on `actor` so callers
	// can address the revokee without an extra round-trip.
	const revoked = await deps.db.query<{
		role_grant_id: string;
		role: string;
		scope_kind: string | null;
		scope_id: string | null;
		account_id: string;
	}>(
		`WITH updated AS (
			UPDATE role_grant
			SET revoked_at = NOW(), revoked_by = $3, revoked_reason = $4
			WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL
			RETURNING id, role, scope_kind, scope_id, actor_id
		)
		SELECT u.id AS role_grant_id, u.role, u.scope_kind, u.scope_id, a.account_id
		FROM updated u
		JOIN actor a ON a.id = u.actor_id`,
		[actor_id, role, revoked_by ?? null, reason ?? null],
	);
	if (revoked.length === 0) {
		return {revoked: [], superseded_offers: []};
	}
	const superseded_offers = await deps.db.query<SupersededOffer>(
		`WITH updated AS (
			UPDATE role_grant_offer o
			SET superseded_at = NOW()
			FROM actor a
			WHERE a.id = $1
			  AND o.to_account_id = a.account_id
			  AND o.role = $2
			  AND o.accepted_at IS NULL
			  AND o.declined_at IS NULL
			  AND o.retracted_at IS NULL
			  AND o.superseded_at IS NULL
			RETURNING o.*
		)
		SELECT u.*, grantor.account_id AS from_account_id
		FROM updated u
		JOIN actor grantor ON grantor.id = u.from_actor_id`,
		[actor_id, role],
	);
	return {revoked, superseded_offers};
};
