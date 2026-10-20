/**
 * Tests for cell_item_queries.ts — the named-column projection.
 *
 * Item semantics (position collisions, moves, soft-delete JOIN filtering,
 * reverse reads) are exercised end-to-end by the RPC parity suites
 * (`../auth/cell_relations_parity.db.test.ts`, `../auth/cell_relation_reverse.db.test.ts`);
 * the const is pinned to the live schema by ./column_projections.db.test.ts.
 * This file pins the aliased JOIN read and the reverse read's tiebreak.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	CELL_ITEM_COLUMNS,
	query_cell_item_insert,
	query_cell_item_list_for_child,
	query_cell_item_list_for_parent
} from '#lib/db/cell_item_queries.ts';
import { query_cell_create } from '#lib/db/cell_queries.ts';
import { CELL_VIEWER_UNRESTRICTED } from '#lib/db/cell_view_sql.ts';

import { describe_db } from '../cell_db_fixture.ts';

describe_db('CellItemQueries', (get_db) => {
	test('the i-aliased forward list read hydrates exactly CELL_ITEM_COLUMNS', async () => {
		const deps = { db: get_db() };
		const parent = await query_cell_create(deps, { data: {} });
		const child = await query_cell_create(deps, { data: {} });
		await query_cell_item_insert(deps, {
			parent_id: parent.id,
			position: 'a0',
			child_id: child.id
		});
		// The aliased JOIN read: an unqualified `SELECT *` here would pull the
		// joined `cell` columns onto the row too, which this key set rejects.
		const listed = await query_cell_item_list_for_parent(deps, CELL_VIEWER_UNRESTRICTED, parent.id);
		assert.strictEqual(listed.length, 1);
		assert.deepEqual(Object.keys(listed[0]!).sort(), [...CELL_ITEM_COLUMNS].sort());
		assert.strictEqual(listed[0]!.child_id, child.id);
	});

	test('the reverse read breaks a created_at tie by parent, then position', async () => {
		const deps = { db: get_db() };
		const child = await query_cell_create(deps, { data: {} });
		const [low, high] = [
			await query_cell_create(deps, { data: {} }),
			await query_cell_create(deps, { data: {} })
		]
			.map((c) => c.id)
			.sort();
		// inserted against key order, then given one instant
		for (const parent_id of [high!, low!]) {
			for (const position of ['a2', 'a1']) {
				await query_cell_item_insert(deps, { parent_id, position, child_id: child.id });
			}
		}
		await deps.db.query(`UPDATE cell_item SET created_at = '2026-01-01T00:00:00Z'`);
		const listed = await query_cell_item_list_for_child(deps, CELL_VIEWER_UNRESTRICTED, child.id);
		assert.deepEqual(
			listed.map((i) => [i.parent_id, i.position]),
			[
				[low, 'a1'],
				[low, 'a2'],
				[high, 'a1'],
				[high, 'a2']
			]
		);
	});
});
