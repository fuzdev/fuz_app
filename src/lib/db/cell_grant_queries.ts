/**
 * Raw queries against the `cell_grant` table.
 *
 * Resource-side ACL for cells: each row admits a principal at a `level`
 * (`viewer` | `editor`). Principal is discriminated by which columns are
 * set — `actor_id` (single actor) xor `(role, scope_id?)` (any holder
 * of a matching role_grant). Owner is implicit on `cell.created_by` and never
 * appears in this table.
 *
 * Convention: `deps: QueryDeps` first, no audit side effects, mutations
 * return the affected row (or `null` for not-found).
 *
 * `query_cell_grant_create` upserts on the relevant partial unique index so
 * re-granting the same principal updates `level` rather than producing
 * duplicate rows. The two principal shapes use different indexes:
 *
 * - Actor-shaped: `idx_cell_grant_unique_actor` on `(cell_id, actor_id)`.
 * - Role-shaped: `idx_cell_grant_unique_role_scope` on `(cell_id, role, scope_id)`
 *   with `NULLS NOT DISTINCT` so two `(role, NULL)` grants on the same cell
 *   collide.
 *
 * @module
 */

import type {QueryDeps} from './query_deps.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import type {CellGrantLevel} from '../auth/cell_grant_action_specs.js';
import {assert_row} from './assert_row.js';

/** Row shape returned by `cell_grant` SELECTs. */
export interface CellGrantRow {
	id: Uuid;
	cell_id: Uuid;
	level: CellGrantLevel;
	actor_id: Uuid | null;
	role: string | null;
	scope_id: Uuid | null;
	granted_by: Uuid | null;
	created_at: Date;
}

/**
 * Discriminated principal input for `query_cell_grant_create`. Wire
 * and query shapes are aligned — actor-shaped principals carry a
 * pre-resolved `actor_id`; pickers run `actor_search` to convert a
 * typed name to an id upstream of the handler.
 */
export type CellGrantPrincipalQueryInput =
	| {kind: 'actor'; actor_id: Uuid}
	| {kind: 'role'; role: string; scope_id: Uuid | null};

/** Input for `query_cell_grant_create`. */
export interface CellGrantCreateQueryInput {
	cell_id: Uuid;
	level: CellGrantLevel;
	principal: CellGrantPrincipalQueryInput;
	granted_by: Uuid | null;
}

/**
 * Insert a grant, or update the existing row's `level` + `granted_by` when
 * one already exists for the same `(cell_id, principal)` pair.
 *
 * Idempotent re-share: caller doesn't need to check existence first. The
 * UPSERT path runs even when the existing row's level matches — handlers
 * reading the row's prior state for audit ("create vs. update") must do
 * so before this call.
 *
 * @param deps - query deps
 * @param input - cell, level, principal, grantor
 * @returns the inserted-or-updated row
 * @mutates `cell_grant` - inserts or updates one row
 */
export const query_cell_grant_create = async (
	deps: QueryDeps,
	input: CellGrantCreateQueryInput,
): Promise<CellGrantRow> => {
	const {cell_id, level, principal, granted_by} = input;
	if (principal.kind === 'actor') {
		const row = await deps.db.query_one<CellGrantRow>(
			`INSERT INTO cell_grant (cell_id, level, actor_id, granted_by)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (cell_id, actor_id) WHERE actor_id IS NOT NULL
			 DO UPDATE SET level = EXCLUDED.level, granted_by = EXCLUDED.granted_by
			 RETURNING *`,
			[cell_id, level, principal.actor_id, granted_by],
		);
		return assert_row(row, 'INSERT INTO cell_grant (actor)');
	}
	const row = await deps.db.query_one<CellGrantRow>(
		`INSERT INTO cell_grant (cell_id, level, role, scope_id, granted_by)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (cell_id, role, scope_id) WHERE role IS NOT NULL
		 DO UPDATE SET level = EXCLUDED.level, granted_by = EXCLUDED.granted_by
		 RETURNING *`,
		[cell_id, level, principal.role, principal.scope_id, granted_by],
	);
	return assert_row(row, 'INSERT INTO cell_grant (role)');
};

/**
 * Fetch a grant by id.
 *
 * @param deps - query deps
 * @param grant_id - grant id
 * @returns the row or `null` when not found
 */
export const query_cell_grant_get = async (
	deps: QueryDeps,
	grant_id: Uuid,
): Promise<CellGrantRow | null> => {
	const row = await deps.db.query_one<CellGrantRow>(`SELECT * FROM cell_grant WHERE id = $1`, [
		grant_id,
	]);
	return row ?? null;
};

/**
 * Delete a grant by id, returning the deleted row.
 *
 * Returning the row lets the caller audit the principal + level after the
 * delete and (for self-revoke) recompute `still_admitted` against the
 * remaining grants on the cell without a second fetch.
 *
 * @param deps - query deps
 * @param grant_id - grant id
 * @returns the deleted row or `null` when no row matched
 * @mutates `cell_grant` - deletes one row
 */
export const query_cell_grant_delete = async (
	deps: QueryDeps,
	grant_id: Uuid,
): Promise<CellGrantRow | null> => {
	const row = await deps.db.query_one<CellGrantRow>(
		`DELETE FROM cell_grant WHERE id = $1 RETURNING *`,
		[grant_id],
	);
	return row ?? null;
};

/**
 * List all grants on a cell, oldest first.
 *
 * Used by `cell_grant_list` (RPC) and by handlers that need grants
 * alongside the cell row for the authorize predicate.
 *
 * @param deps - query deps
 * @param cell_id - cell id
 * @returns matching rows
 */
export const query_cell_grant_list_for_cell = async (
	deps: QueryDeps,
	cell_id: Uuid,
): Promise<Array<CellGrantRow>> =>
	deps.db.query<CellGrantRow>(
		`SELECT * FROM cell_grant
		 WHERE cell_id = $1
		 ORDER BY created_at ASC`,
		[cell_id],
	);

/**
 * List all grants across a set of cells, ordered by cell then creation.
 * Used by the strict relation-read filter to test `can_view_cell` per
 * target in memory — the caller groups the flat result by `cell_id`.
 * Returns **every** grant on each cell (not caller-filtered), because
 * `can_view_cell` needs the full grant list to decide admission.
 *
 * @param deps - query deps
 * @param cell_ids - cells to fetch grants for (duplicates are harmless)
 * @returns matching grant rows (group by `cell_id` caller-side)
 */
export const query_cell_grant_list_for_cells = async (
	deps: QueryDeps,
	cell_ids: ReadonlyArray<Uuid>,
): Promise<Array<CellGrantRow>> => {
	if (cell_ids.length === 0) return [];
	return deps.db.query<CellGrantRow>(
		`SELECT * FROM cell_grant
		 WHERE cell_id = ANY($1::uuid[])
		 ORDER BY cell_id, created_at ASC`,
		[cell_ids as Array<Uuid>],
	);
};

/**
 * Load grants that admit the caller (by actor or role-scoped role_grants) across
 * multiple cells. Used to enrich `cell_list` responses with context about what
 * granted access. Returns grants for the given cells that match the caller's
 * identity or role_grant set.
 *
 * @param cell_ids - cells to fetch grants for
 * @param caller_actor_id - actor id of the caller (null for unauth)
 * @param role_grant_roles - active role_grant roles (parallel array)
 * @param role_grant_scope_ids - active role_grant scope ids (parallel array, parallel to roles)
 * @returns matching grants (may include grants the caller doesn't match; caller's
 * list handler must filter when returning to the API)
 */
export const query_cell_grants_for_caller_in_cells = async (
	deps: QueryDeps,
	cell_ids: Array<Uuid>,
	caller_actor_id: Uuid | null,
	role_grant_roles: Array<string>,
	role_grant_scope_ids: Array<Uuid | null>,
): Promise<Array<CellGrantRow>> => {
	if (cell_ids.length === 0) {
		return [];
	}
	return deps.db.query<CellGrantRow>(
		`SELECT g.* FROM cell_grant g
		 WHERE g.cell_id = ANY($1::uuid[])
		   AND (
		     g.actor_id = $2
		     OR EXISTS (
		       SELECT 1
		       FROM unnest($3::text[], $4::uuid[]) AS p(role, scope_id)
		       WHERE g.role = p.role
		         AND (g.scope_id IS NULL OR g.scope_id IS NOT DISTINCT FROM p.scope_id)
		     )
		   )
		 ORDER BY g.cell_id, g.created_at ASC`,
		[cell_ids, caller_actor_id, role_grant_roles, role_grant_scope_ids],
	);
};
