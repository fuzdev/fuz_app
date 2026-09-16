/**
 * Strict relation-read visibility filter.
 *
 * Forward relation reads (the `cell_get` bundle, forward `cell_field_list`
 * / `cell_item_list`, the deep-clone walk) must not surface edges whose
 * target the caller cannot view — otherwise an editor of a public parent
 * could enumerate private children by id, or a public cell could leak the
 * existence of private linked cells. This helper bulk-loads the target
 * cells + their grants and runs `can_view_cell` per target in memory,
 * returning the set of viewable target ids. Batched (two queries for the
 * whole id-set) to avoid the N+1 a naive per-row check would cause.
 *
 * @module
 */

import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { QueryDeps } from '../db/query_deps.ts';
import type { RequestContext } from './request_context.ts';
import { can_view_cell } from './cell_authorize.ts';
import { query_cell_load_many } from '../db/cell_queries.ts';
import { query_cell_grant_list_for_cells, type CellGrantRow } from '../db/cell_grant_queries.ts';

/**
 * Return the subset of `target_ids` the caller may view.
 *
 * Soft-deleted targets and ids with no matching cell are absent from the
 * result (treated as not-viewable). Grants are loaded only for
 * authenticated callers — `null` auth admits solely via the public
 * branch of `can_view_cell`, so the grant load is skipped entirely.
 *
 * @param deps - query deps
 * @param auth - request context, or `null` for unauthenticated callers
 * @param target_ids - candidate cell ids (duplicates are harmless)
 * @returns the set of ids the caller may view
 */
export const filter_visible_target_ids = async (
	deps: QueryDeps,
	auth: RequestContext | null,
	target_ids: ReadonlyArray<Uuid>
): Promise<Set<Uuid>> => {
	const visible = new Set<Uuid>();
	if (target_ids.length === 0) return visible;
	const unique = [...new Set(target_ids)];
	const cells = await query_cell_load_many(deps, unique);
	// Grants only matter for authenticated callers — null auth admits via
	// the public branch alone, so skip the grant load entirely.
	const grants_by_cell = new Map<Uuid, Array<CellGrantRow>>();
	if (auth) {
		const grant_rows = await query_cell_grant_list_for_cells(deps, unique);
		for (const g of grant_rows) {
			let list = grants_by_cell.get(g.cell_id);
			if (list === undefined) {
				list = [];
				grants_by_cell.set(g.cell_id, list);
			}
			list.push(g);
		}
	}
	for (const cell of cells) {
		const grants = auth ? (grants_by_cell.get(cell.id) ?? []) : null;
		if (can_view_cell(auth, cell, grants)) visible.add(cell.id);
	}
	return visible;
};
