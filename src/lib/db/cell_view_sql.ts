/**
 * `can_view_cell` in SQL — the view predicate a query applies to a cell row
 * before `LIMIT`, so a page holds only rows the caller may view.
 *
 * `can_view_cell_sql` is the one SQL form of the predicate: `query_cell_list`
 * embeds it (adding the steward arm beside it), and the relation lists apply
 * it to the cell at the other end of each edge. It binds the caller through a
 * `CellViewer` (`auth/cell_authorize.ts`'s `cell_viewer_from_auth` builds one
 * from a request context), and the role-shaped grant arm reads the
 * `caller_role_grants` CTE `caller_role_grants_cte` defines. Twin of the Rust
 * `fuz_cell::cell_view_sql`.
 *
 * @module
 */

import type { Uuid } from '../primitive_schemas.ts';
import { cell_moderation_admits_audience_sql } from './cell_moderation.ts';

/**
 * The caller a view predicate binds — what `can_view_cell` reads off the
 * request context.
 *
 * `role_grant_roles` and `role_grant_scope_ids` are parallel, one entry per
 * active role grant (`null` = a global grant): `unnest` pads the shorter with
 * NULLs, and a NULL scope reads as a global grant, so `cell_viewer_params`
 * refuses a mismatch.
 */
export interface CellViewer {
	/** The acting actor; `null` for an anonymous or account-grain caller. */
	readonly actor_id: Uuid | null;
	/** Whether the caller holds the global admin role — the arm that admits every cell. */
	readonly is_admin: boolean;
	/** The roles of the caller's active role grants, parallel to `role_grant_scope_ids`. */
	readonly role_grant_roles: ReadonlyArray<string>;
	/** The scopes of the caller's active role grants, parallel to `role_grant_roles`. */
	readonly role_grant_scope_ids: ReadonlyArray<Uuid | null>;
}

/** An anonymous caller — admitted by the public arm alone. */
export const CELL_VIEWER_ANONYMOUS: CellViewer = {
	actor_id: null,
	is_admin: false,
	role_grant_roles: [],
	role_grant_scope_ids: []
};

/**
 * A server-side read that filters nothing — the admin arm admits every cell.
 * For a caller that applies its own view check afterwards (the `cell_get`
 * bundle) or acts for the server itself.
 */
export const CELL_VIEWER_UNRESTRICTED: CellViewer = {
	actor_id: null,
	is_admin: true,
	role_grant_roles: [],
	role_grant_scope_ids: []
};

/** Where a query binds the `CellViewer` facts `can_view_cell_sql` reads — each a `$N` placeholder. */
export interface CellViewerSqlParams {
	/** The global-admin flag (`bool`). */
	readonly is_admin: string;
	/** The acting actor (`uuid`, NULL when anonymous) — the owner arm and the grant arm's guard. */
	readonly actor_id: string;
	/**
	 * The actor an actor-shaped grant matches, when a query binds it apart
	 * from `actor_id` (`query_cell_list` does). Defaults to `actor_id`.
	 */
	readonly grant_actor_id?: string;
}

/**
 * The viewer's bind values, in the order `[is_admin, actor_id, roles,
 * scope_ids]`.
 *
 * @param viewer - the caller
 * @returns the four bind values
 * @throws {Error} when the role-grant arrays aren't parallel
 */
export const cell_viewer_params = (
	viewer: CellViewer
): [boolean, Uuid | null, ReadonlyArray<string>, ReadonlyArray<Uuid | null>] => {
	if (viewer.role_grant_roles.length !== viewer.role_grant_scope_ids.length) {
		throw new Error(
			`CellViewer: role_grant_roles (len=${viewer.role_grant_roles.length}) and ` +
				`role_grant_scope_ids (len=${viewer.role_grant_scope_ids.length}) must be parallel arrays`
		);
	}
	return [viewer.is_admin, viewer.actor_id, viewer.role_grant_roles, viewer.role_grant_scope_ids];
};

/**
 * The `caller_role_grants` CTE body (no `WITH`): the caller's
 * `(role, scope_id)` pairs, unnested once per query from the parallel arrays
 * at placeholders `roles` and `scope_ids`. PG 12+ inlines a non-recursive
 * single-use CTE, so this is planner-equivalent to a subquery — the form is
 * for clarity.
 *
 * @param roles - the placeholder of the roles array (`text[]`)
 * @param scope_ids - the placeholder of the scope-id array (`uuid[]`)
 * @returns the CTE body
 */
export const caller_role_grants_cte = (roles: string, scope_ids: string): string =>
	`caller_role_grants AS (
	   SELECT role, scope_id FROM unnest(${roles}::text[], ${scope_ids}::uuid[]) AS p(role, scope_id)
	 )`;

/**
 * The `cell_grant` admits-caller predicate over grant alias `g_alias`: an
 * actor-shaped grant matches the actor at placeholder `actor_id`; a
 * role-shaped grant matches a `(role, scope_id)` pair in the
 * `caller_role_grants` CTE (a NULL grant `scope_id` matches any scope).
 * Mirrors `grant_admits` in `auth/cell_authorize.ts`.
 *
 * @param g_alias - the `cell_grant` alias in the enclosing query
 * @param actor_id - the placeholder of the caller's actor (`uuid`)
 * @returns the SQL predicate
 */
export const cell_grant_admits_caller_sql = (g_alias: string, actor_id: string): string => `(
	     (${actor_id}::uuid IS NOT NULL AND ${g_alias}.actor_id = ${actor_id})
	     OR (
	       ${g_alias}.role IS NOT NULL
	       AND EXISTS (
	         SELECT 1 FROM caller_role_grants p
	         WHERE p.role = ${g_alias}.role
	           AND (${g_alias}.scope_id IS NULL OR p.scope_id IS NOT DISTINCT FROM ${g_alias}.scope_id)
	       )
	     )
	   )`;

/**
 * `can_view_cell` over the cell alias `c_alias`: admin, the owner, or — while
 * the cell's `moderation` admits an audience — `public` or a `cell_grant`
 * admitting the caller.
 *
 * Reads the caller at `params`; the grant arm needs the
 * `caller_role_grants_cte` in scope. Liveness (`deleted_at IS NULL`) is the
 * query's own clause, as `can_view_cell` reads a loaded live row.
 *
 * @param c_alias - the `cell` alias in the enclosing query
 * @param params - where the query binds the caller
 * @returns the SQL predicate (parenthesized)
 */
export const can_view_cell_sql = (c_alias: string, params: CellViewerSqlParams): string => {
	const { is_admin, actor_id } = params;
	const grant_actor_id = params.grant_actor_id ?? actor_id;
	return `(
	     ${is_admin}::bool
	     OR (${actor_id}::uuid IS NOT NULL AND ${c_alias}.created_by = ${actor_id})
	     OR (${cell_moderation_admits_audience_sql(c_alias)} AND (
	       ${c_alias}.visibility = 'public'
	       OR (${actor_id}::uuid IS NOT NULL AND EXISTS (
	         SELECT 1 FROM cell_grant g
	         WHERE g.cell_id = ${c_alias}.id AND ${cell_grant_admits_caller_sql('g', grant_actor_id)}
	       ))
	     ))
	   )`;
};
