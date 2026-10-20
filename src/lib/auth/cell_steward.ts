/**
 * The steward read arm, with the governing-root load it needs.
 *
 * `can_steward_cell` (`auth/cell_authorize.ts`) is pure over
 * `(auth, cell, root)`; `cell_steward_admits` is the composition every steward
 * site runs after `can_view_cell` denies: it loads the governing root (active
 * rows only, so a soft-deleted root stewards nothing) and applies the
 * predicate. It short-circuits with no query unless the caller is
 * authenticated and the cell is a pending or rejected contribution.
 *
 * **Where the steward arm applies** — the surfaces a moderator works from:
 * `cell_get`, `cell_moderate` (whose root-authority check it lets a non-admin
 * root owner reach), the cell-scoped fact route, and `cell_list`'s general
 * predicate (the SQL twin in `query_cell_list`).
 *
 * **Where it must not** — every other read keeps `can_view_cell` alone:
 * `cell_clone` (a steward copying a contribution out from under its
 * moderation), the parent check on `cell_create` (a steward contributing under
 * a pending post), the relation endpoint gates and `filter_visible_target_ids`
 * (the `cell_get` bundle, the field / item lists and their list gates),
 * `cell_list`'s `shared_with` semi-join (a grant footprint, not a moderation
 * queue), and `cell_grant_revoke`'s `still_admitted` recompute. Widening one of
 * these is a decision, not a sweep. Twin of the Rust `fuz_cell::cell_steward`.
 *
 * @module
 */

import type { QueryDeps } from '../db/query_deps.ts';
import { query_cell_get, type CellRow } from '../db/cell_queries.ts';
import { cell_moderation_is_stewardable } from '../db/cell_moderation.ts';
import type { RequestContext } from './request_context.ts';
import { can_steward_cell } from './cell_authorize.ts';

/**
 * Whether `auth` stewards `cell` — loads the governing root and applies
 * `can_steward_cell`.
 *
 * Resolves `false` without a query for an unauthenticated caller, a root, or a
 * cell whose moderation isn't `'pending'` / `'rejected'`; a missing or
 * soft-deleted root is `false` too.
 *
 * @param deps - query deps
 * @param auth - request context, or `null` for unauthenticated callers
 * @param cell - the cell the caller couldn't otherwise view
 * @returns whether the steward arm admits the caller
 */
export const cell_steward_admits = async (
	deps: QueryDeps,
	auth: RequestContext | null,
	cell: CellRow
): Promise<boolean> => {
	if (auth === null || cell.root_id === null) return false;
	if (!cell_moderation_is_stewardable(cell.moderation)) return false;
	const root = await query_cell_get(deps, cell.root_id);
	if (!root) return false;
	return can_steward_cell(auth, cell, root);
};
