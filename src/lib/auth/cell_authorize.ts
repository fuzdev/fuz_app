/**
 * Cell view + edit + manage authorization helpers.
 *
 * Pure functions over `(auth, cell, grants)`. No DB I/O; the caller is
 * responsible for loading the cell row and the cell's grant list out-of-
 * band, then handing both to the predicate.
 *
 * Unauthenticated callers pass `null` for `auth` — public pages can
 * resolve `cell.visibility === 'public'` cells without a session, and
 * that branch is the only path that admits them. Callers may pass `null`
 * for `grants` in that case (and any case where they know they don't
 * need to consider grants); `grant_admits` short-circuits on null.
 *
 * Three tiers:
 *
 * - `can_view_cell` — admin / public / owner / any `viewer`+ grant.
 * - `can_edit_cell` — admin / owner / `editor` grant. NULL `created_by`
 *   is admin-only (system-origin defense-in-depth).
 * - `can_manage_cell` — admin / owner only. Not delegable, not a grant
 *   level. Gates the manage tier: `visibility` writes and all grant
 *   management (`cell_grant_create` / `_list` / `_revoke`).
 *
 * Grant-admit branches: per-`actor_id` grants admit the matching
 * actor; `(role, scope_id?)` grants admit any holder of an active
 * role_grant matching those literals (`scope_id IS NULL` admits any-scope
 * role_grant). The grant's `level` (`viewer` / `editor`) gates which
 * predicate it satisfies.
 *
 * @module
 */

import { has_role, type RequestContext } from './request_context.ts';
import { is_role_grant_active } from './account_schema.ts';
import { ROLE_ADMIN } from './role_schema.ts';

import type { CellRow } from '../db/cell_queries.ts';
import type { CellGrantRow } from '../db/cell_grant_queries.ts';

const cell_is_public = (cell: CellRow): boolean => cell.visibility === 'public';

/**
 * Whether any grant admits `auth` at the given level.
 *
 * `null` grants short-circuits to false — callers who skipped the load
 * (e.g. unauthenticated requests, where no grant could admit anyway)
 * pass null instead of allocating an empty array. Authenticated
 * callers that loaded a list pass it as-is; an empty array is
 * semantically distinct ("loaded, no grants exist") and walks to false
 * via the empty `for...of`.
 *
 * Actor-shaped grants match `auth.actor.id`. Role-shaped grants walk
 * `auth.role_grants` for an active role_grant with matching role and either a
 * matching `scope_id` or `g.scope_id IS NULL` (any scope). The active-
 * role_grant recheck via `is_role_grant_active` is belt-and-suspenders for
 * long-lived requests crossing an expiration boundary; middleware
 * already filtered to active role_grants at request entry.
 */
const grant_admits = (
	auth: RequestContext,
	grants: ReadonlyArray<CellGrantRow> | null,
	required_level: 'viewer' | 'editor'
): boolean => {
	if (grants === null) return false;
	const now = new Date();
	for (const g of grants) {
		// Editor-required filters out viewer-level grants up front.
		if (required_level === 'editor' && g.level !== 'editor') continue;
		if (g.actor_id !== null) {
			// Actor-shaped grants only match a resolved acting actor. Account-
			// grain auth (no `acting` declared on input → `actor: null`) cannot
			// match an actor-id grant by definition.
			if (auth.actor !== null && g.actor_id === auth.actor.id) return true;
			continue;
		}
		// Role-shaped principal. The CHECK constraint on cell_grant
		// guarantees `role IS NOT NULL` here (actor_id xor role).
		const matched = auth.role_grants.some(
			(p) =>
				p.role === g.role &&
				(g.scope_id === null || p.scope_id === g.scope_id) &&
				is_role_grant_active(p, now)
		);
		if (matched) return true;
	}
	return false;
};

/**
 * Whether `auth` owns `cell` (the implicit manage tier below admin).
 *
 * Owner is the `cell.created_by` actor field — not a role, not a
 * delegable grant level. NULL `created_by` (system origin) is never
 * owned by anyone; the explicit `created_by !== null` guard keeps that
 * a load-bearing property rather than relying on JS equality returning
 * false for NULL.
 */
const is_owner = (auth: RequestContext, cell: CellRow): boolean =>
	auth.actor !== null && cell.created_by !== null && cell.created_by === auth.actor.id;

/**
 * View authorization for a cell.
 *
 * - Admin: always allowed.
 * - `cell.visibility === 'public'`: allowed for everyone, including
 *   unauthenticated callers (e.g. a public landing cell).
 * - Owner (`cell.created_by === auth.actor.id`): allowed.
 * - Any active grant on the cell admits the caller (actor-shaped:
 *   match on actor_id; role-shaped: match on `(role, scope_id?)`
 *   against an active role_grant).
 * - Otherwise: false.
 *
 * @param auth - request context, or `null` for unauthenticated callers
 * @param cell - the cell row
 * @param grants - the cell's grant list, or `null` to skip the grant branch
 * @returns whether the caller may view the cell
 */
export const can_view_cell = (
	auth: RequestContext | null,
	cell: CellRow,
	grants: ReadonlyArray<CellGrantRow> | null
): boolean => {
	if (auth && has_role(auth, ROLE_ADMIN)) return true;
	if (cell_is_public(cell)) return true;
	if (auth && is_owner(auth, cell)) return true;
	if (auth && grant_admits(auth, grants, 'viewer')) return true;
	return false;
};

/**
 * Edit authorization for a cell.
 *
 * Unauthenticated callers can never edit. Admin always allowed.
 *
 * IMPORTANT: the `cell.created_by === null` branch is **explicit
 * defense-in-depth**. NULL `created_by` means system origin (well-known
 * cells seeded by migration, future daemon/agent cells). Non-admin edits
 * MUST be denied — editor-level grants do NOT bypass this guard,
 * because system cells are policy-controlled at admin level. Do NOT
 * collapse into a single equality check that would silently return
 * `false` for NULL via JS equality semantics — the explicit branch
 * survives refactors and reads as a load-bearing security property.
 *
 * @param auth - request context, or `null` for unauthenticated callers
 * @param cell - the cell row
 * @param grants - the cell's grant list, or `null` to skip the grant branch
 * @returns whether the caller may edit the cell
 */
export const can_edit_cell = (
	auth: RequestContext | null,
	cell: CellRow,
	grants: ReadonlyArray<CellGrantRow> | null
): boolean => {
	if (!auth) return false;
	if (has_role(auth, ROLE_ADMIN)) return true;
	if (cell.created_by === null) return false; // explicit: NULL = admin-only
	// Owner check requires a resolved acting actor — account-grain auth
	// (`actor: null`) cannot match an actor-id `created_by`. Grant-admit
	// fallback below handles the actor-grain editor-grant path.
	if (is_owner(auth, cell)) return true;
	if (grant_admits(auth, grants, 'editor')) return true;
	return false;
};

/**
 * Manage authorization for a cell — `admin || owner`.
 *
 * The implicit tier above editor: gates `visibility` writes and all grant
 * management (`cell_grant_create` / `_list` / `_revoke`). NOT delegable and
 * NOT a grant level — an editor-grant holder is never a manager. Grants are
 * not consulted.
 *
 * NULL `created_by` (system origin) has no owner, so manage falls to
 * admin only — the explicit NULL guard lives in `is_owner`.
 *
 * @param auth - request context, or `null` for unauthenticated callers
 * @param cell - the cell row
 * @returns whether the caller is in the manage tier for the cell
 */
export const can_manage_cell = (auth: RequestContext | null, cell: CellRow): boolean => {
	if (!auth) return false;
	if (has_role(auth, ROLE_ADMIN)) return true;
	return is_owner(auth, cell);
};
