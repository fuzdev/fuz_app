/**
 * Tests for cell_item_queries.ts — the named-column projection.
 *
 * Item semantics (position collisions, moves, soft-delete JOIN filtering,
 * reverse reads) are exercised end-to-end by the RPC parity suites
 * (`../auth/cell_relations_parity.db.test.ts`, `../auth/cell_relation_reverse.db.test.ts`);
 * the const is pinned to the live schema by ./column_projections.db.test.ts.
 * This file pins the aliased JOIN read.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	CELL_ITEM_COLUMNS,
	query_cell_item_insert,
	query_cell_item_list_for_parent
} from '$lib/db/cell_item_queries.ts';
import { query_cell_create } from '$lib/db/cell_queries.ts';

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
		const listed = await query_cell_item_list_for_parent(deps, parent.id);
		assert.strictEqual(listed.length, 1);
		assert.deepEqual(Object.keys(listed[0]!).sort(), [...CELL_ITEM_COLUMNS].sort());
		assert.strictEqual(listed[0]!.child_id, child.id);
	});
});
