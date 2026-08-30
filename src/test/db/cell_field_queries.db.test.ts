/**
 * Tests for cell_field_queries.ts — the named-column projection.
 *
 * Field semantics (UPSERT, soft-delete JOIN filtering, reverse reads) are
 * exercised end-to-end by the RPC parity suites
 * (`../auth/cell_relations_parity.db.test.ts`, `../auth/cell_relation_reverse.db.test.ts`);
 * the const is pinned to the live schema by ./column_projections.db.test.ts.
 * This file pins the aliased JOIN read.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	CELL_FIELD_COLUMNS,
	query_cell_field_set,
	query_cell_field_list_for_source
} from '$lib/db/cell_field_queries.ts';
import { query_cell_create } from '$lib/db/cell_queries.ts';

import { describe_db } from '../cell_db_fixture.ts';

describe_db('CellFieldQueries', (get_db) => {
	test('the f-aliased forward list read hydrates exactly CELL_FIELD_COLUMNS', async () => {
		const deps = { db: get_db() };
		const source = await query_cell_create(deps, { data: {} });
		const target = await query_cell_create(deps, { data: {} });
		await query_cell_field_set(deps, { source_id: source.id, name: 'link', target_id: target.id });
		// The aliased JOIN read: an unqualified `SELECT *` here would pull the
		// joined `cell` columns onto the row too, which this key set rejects.
		const listed = await query_cell_field_list_for_source(deps, source.id);
		assert.strictEqual(listed.length, 1);
		assert.deepEqual(Object.keys(listed[0]!).sort(), [...CELL_FIELD_COLUMNS].sort());
		assert.strictEqual(listed[0]!.target_id, target.id);
	});
});
