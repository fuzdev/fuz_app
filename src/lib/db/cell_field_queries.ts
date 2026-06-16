/**
 * Raw queries against the `cell_field` table.
 *
 * Named-relation primitive: each row is `(source_id, name) → target_id`,
 * a JSON-object-shaped edge from one cell to another. `(source_id, name)`
 * is unique — one target per name per source. Multiplicity by composition
 * (target a collection cell whose `items[]` are the multi-valued tags),
 * not by allowing duplicate field rows.
 *
 * Reads filter both endpoints by `cell.deleted_at IS NULL` so relations
 * dangling off a soft-deleted cell don't surface to the live graph.
 *
 * `query_cell_field_set` upserts on the `(source_id, name)` PK so
 * re-pointing a name updates `target_id` in place — JSON-object semantics
 * (`obj.foo = bar` overwrites whatever was there).
 *
 * @module
 */

import type {QueryDeps} from './query_deps.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import {assert_row} from './assert_row.ts';

/** Row shape returned by `cell_field` SELECTs. */
export interface CellFieldRow {
	source_id: Uuid;
	name: string;
	target_id: Uuid;
	created_at: Date;
}

/** Input for `query_cell_field_set`. */
export interface CellFieldSetQueryInput {
	source_id: Uuid;
	name: string;
	target_id: Uuid;
}

/**
 * Insert or update a field row.
 *
 * UPSERT on `(source_id, name)` — re-setting the same name updates
 * `target_id` and bumps `created_at` (timestamp reflects last write).
 * Idempotent at the row level: caller can re-issue with the same input
 * without checking existence first.
 *
 * @param deps - query deps
 * @param input - source, name, target
 * @returns the inserted-or-updated row
 * @mutates `cell_field` - inserts or updates one row
 */
export const query_cell_field_set = async (
	deps: QueryDeps,
	input: CellFieldSetQueryInput,
): Promise<CellFieldRow> => {
	const row = await deps.db.query_one<CellFieldRow>(
		`INSERT INTO cell_field (source_id, name, target_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (source_id, name)
		 DO UPDATE SET target_id = EXCLUDED.target_id, created_at = NOW()
		 RETURNING *`,
		[input.source_id, input.name, input.target_id],
	);
	return assert_row(row, 'INSERT INTO cell_field');
};

/**
 * Fetch one field row by primary key.
 *
 * Does NOT JOIN cell — the caller decides whether to filter by
 * `deleted_at`. Used by handlers that need the row's current target_id
 * for audit envelopes before issuing the delete.
 *
 * @param deps - query deps
 * @param source_id - source cell id
 * @param name - field name
 * @returns the row or `null` when not found
 */
export const query_cell_field_get = async (
	deps: QueryDeps,
	source_id: Uuid,
	name: string,
): Promise<CellFieldRow | null> => {
	const row = await deps.db.query_one<CellFieldRow>(
		`SELECT * FROM cell_field WHERE source_id = $1 AND name = $2`,
		[source_id, name],
	);
	return row ?? null;
};

/**
 * Delete a field row by primary key. Returns the deleted row so callers
 * can audit the prior target_id without a pre-fetch.
 *
 * @returns the deleted row, or `null` when no row matched (idempotent
 *   delete: a 200 response is correct even when nothing was deleted)
 * @mutates `cell_field` - deletes one row
 */
export const query_cell_field_delete = async (
	deps: QueryDeps,
	source_id: Uuid,
	name: string,
): Promise<CellFieldRow | null> => {
	const row = await deps.db.query_one<CellFieldRow>(
		`DELETE FROM cell_field WHERE source_id = $1 AND name = $2 RETURNING *`,
		[source_id, name],
	);
	return row ?? null;
};

/**
 * Forward fields list (`source.fields[]`).
 *
 * Filters target by `deleted_at IS NULL` so relations to tombstoned cells
 * don't surface; the source filter is the caller's responsibility (gated
 * upstream by `can_view_cell(source)`).
 *
 * @param deps - query deps
 * @param source_id - source cell id
 * @returns matching rows, oldest first by name (lex order)
 */
export const query_cell_field_list_for_source = async (
	deps: QueryDeps,
	source_id: Uuid,
	options?: {limit?: number; name_after?: string},
): Promise<Array<CellFieldRow>> => {
	const limit = options?.limit ?? null;
	const name_after = options?.name_after ?? null;
	return deps.db.query<CellFieldRow>(
		`SELECT f.* FROM cell_field f
		 JOIN cell t ON t.id = f.target_id
		 WHERE f.source_id = $1
		   AND t.deleted_at IS NULL
		   AND ($3::text IS NULL OR f.name > $3)
		 ORDER BY f.name ASC
		 LIMIT $2`,
		[source_id, limit, name_after],
	);
};

/**
 * Reverse fields list (`target.upfields[]`).
 *
 * Returns rows whose `target_id = $1`, joined to `cell` on `source_id` so
 * relations from tombstoned sources don't surface. The caller-side
 * authz filter (per-source `can_view_cell`) runs after the SQL fetch
 * — see the 2-layer authz contract on `cell_field_list({target_id})`.
 *
 * Bounded by `limit` (the wire `cell_field_list` cap) so a heavily
 * inbound-linked target can't force an unbounded fetch + per-source authz
 * pass on the public, IP-rate-limited reverse endpoint.
 *
 * @param deps - query deps
 * @param target_id - target cell id
 * @param options - `limit` caps the row count
 * @returns matching rows, oldest first by source created_at
 */
export const query_cell_field_list_for_target = async (
	deps: QueryDeps,
	target_id: Uuid,
	options?: {limit?: number},
): Promise<Array<CellFieldRow>> =>
	deps.db.query<CellFieldRow>(
		`SELECT f.* FROM cell_field f
		 JOIN cell s ON s.id = f.source_id
		 WHERE f.target_id = $1
		   AND s.deleted_at IS NULL
		 ORDER BY f.created_at ASC
		 LIMIT $2`,
		[target_id, options?.limit ?? null],
	);
