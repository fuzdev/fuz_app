/**
 * Raw queries against the `cell_item` table.
 *
 * Ordered-child membership: each row is `(parent_id, position) → child_id`.
 * `position` is opaque text (fractional-indexing key) — lex ordering is
 * the contract. The PK on `(parent_id, position)` enforces one cell per
 * slot but allows the same `child_id` to appear at multiple positions
 * (the primitive is JSON-array-shaped — ordered multiset, not set;
 * domain dedup rules ride on top).
 *
 * Reads filter both endpoints by `cell.deleted_at IS NULL` so items
 * dangling off a soft-deleted cell don't surface.
 *
 * `query_cell_item_insert` returns the inserted row OR throws the
 * underlying `23505` (Postgres unique violation) on a `(parent_id,
 * position)` collision. Handlers convert this into the
 * `cell_item_position_taken` JSON-RPC error so the client retries with a
 * refreshed bracket.
 *
 * @module
 */

import type {QueryDeps} from './query_deps.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import {assert_row} from './assert_row.ts';

/** Row shape returned by `cell_item` SELECTs. */
export interface CellItemRow {
	parent_id: Uuid;
	position: string;
	child_id: Uuid;
	created_at: Date;
}

/** Input for `query_cell_item_insert`. */
export interface CellItemInsertQueryInput {
	parent_id: Uuid;
	position: string;
	child_id: Uuid;
}

/**
 * Insert one item row at the caller-supplied `position`.
 *
 * Throws on `(parent_id, position)` collision (Postgres `23505`); handler
 * callers detect via `is_pg_unique_violation` and surface as
 * `cell_item_position_taken`. Helper-side jitter (`fractional_index`)
 * makes the collision rate negligible at realistic UX concurrency, so
 * the throw is the cold-path safety net, not the hot path.
 *
 * @mutates `cell_item` - inserts one row
 */
export const query_cell_item_insert = async (
	deps: QueryDeps,
	input: CellItemInsertQueryInput,
): Promise<CellItemRow> => {
	const row = await deps.db.query_one<CellItemRow>(
		`INSERT INTO cell_item (parent_id, position, child_id)
		 VALUES ($1, $2, $3)
		 RETURNING *`,
		[input.parent_id, input.position, input.child_id],
	);
	return assert_row(row, 'INSERT INTO cell_item');
};

/**
 * Fetch one item row by `(parent_id, position)`. Used by move + delete
 * handlers to confirm the row exists before issuing the mutation.
 *
 * @returns the row or `null` when not found
 */
export const query_cell_item_get = async (
	deps: QueryDeps,
	parent_id: Uuid,
	position: string,
): Promise<CellItemRow | null> => {
	const row = await deps.db.query_one<CellItemRow>(
		`SELECT * FROM cell_item WHERE parent_id = $1 AND position = $2`,
		[parent_id, position],
	);
	return row ?? null;
};

/**
 * Move an item row from `position_old` to `position_new` (same parent).
 *
 * Implemented as an UPDATE on the PK; throws `23505` on collision with
 * an existing row at `position_new` so handlers can surface
 * `cell_item_position_taken`. The caller-supplied `position_new` is what
 * fractional-indexing produced for the new slot — collisions are rare
 * but the error path keeps the client truthful.
 *
 * @returns the updated row, or `null` when the source row was missing
 *   (raced with a deleter)
 * @mutates `cell_item` - updates one row's `position`
 */
export const query_cell_item_move = async (
	deps: QueryDeps,
	parent_id: Uuid,
	position_old: string,
	position_new: string,
): Promise<CellItemRow | null> => {
	const row = await deps.db.query_one<CellItemRow>(
		`UPDATE cell_item
		 SET position = $3
		 WHERE parent_id = $1 AND position = $2
		 RETURNING *`,
		[parent_id, position_old, position_new],
	);
	return row ?? null;
};

/**
 * Delete one item row by `(parent_id, position)`. Returns the deleted
 * row so callers can audit `child_id` after the delete without a
 * pre-fetch.
 *
 * @returns the deleted row, or `null` when nothing matched
 * @mutates `cell_item` - deletes one row
 */
export const query_cell_item_delete = async (
	deps: QueryDeps,
	parent_id: Uuid,
	position: string,
): Promise<CellItemRow | null> => {
	const row = await deps.db.query_one<CellItemRow>(
		`DELETE FROM cell_item WHERE parent_id = $1 AND position = $2 RETURNING *`,
		[parent_id, position],
	);
	return row ?? null;
};

/**
 * Forward items list (`parent.items[]`), ordered by lex `position`.
 *
 * Filters child by `deleted_at IS NULL` so items pointing at tombstoned
 * cells don't surface; the parent filter is the caller's responsibility
 * (gated upstream by `can_view_cell(parent)`).
 *
 * @param limit - optional row cap (passes through to SQL `LIMIT`)
 */
export const query_cell_item_list_for_parent = async (
	deps: QueryDeps,
	parent_id: Uuid,
	options?: {limit?: number; position_after?: string},
): Promise<Array<CellItemRow>> => {
	const limit = options?.limit ?? null;
	const position_after = options?.position_after ?? null;
	return deps.db.query<CellItemRow>(
		`SELECT i.* FROM cell_item i
		 JOIN cell c ON c.id = i.child_id
		 WHERE i.parent_id = $1
		   AND c.deleted_at IS NULL
		   AND ($3::text IS NULL OR i.position > $3)
		 ORDER BY i.position ASC
		 LIMIT $2`,
		[parent_id, limit, position_after],
	);
};

/**
 * Reverse items list (`child.lists[]`).
 *
 * Returns rows whose `child_id = $1`, joined to `cell` on `parent_id` so
 * items from tombstoned parents don't surface. The caller-side authz
 * filter (per-parent `can_view_cell`) runs after the SQL fetch — see
 * the 2-layer authz contract on `cell_item_list({child_id})`.
 *
 * Bounded by `limit` (the wire `cell_item_list` cap) so a heavily
 * inbound-linked child can't force an unbounded fetch + per-parent authz
 * pass on the public, IP-rate-limited reverse endpoint.
 */
export const query_cell_item_list_for_child = async (
	deps: QueryDeps,
	child_id: Uuid,
	options?: {limit?: number},
): Promise<Array<CellItemRow>> =>
	deps.db.query<CellItemRow>(
		`SELECT i.* FROM cell_item i
		 JOIN cell p ON p.id = i.parent_id
		 WHERE i.child_id = $1
		   AND p.deleted_at IS NULL
		 ORDER BY i.created_at ASC
		 LIMIT $2`,
		[child_id, options?.limit ?? null],
	);
