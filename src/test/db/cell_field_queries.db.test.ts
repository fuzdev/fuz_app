/**
 * Tests for cell_field_queries.ts — the named-column projection.
 *
 * Field semantics (UPSERT, soft-delete JOIN filtering, reverse reads) are
 * exercised end-to-end by the RPC parity suites
 * (`../auth/cell_relations_parity.db.test.ts`, `../auth/cell_relation_reverse.db.test.ts`);
 * the const is pinned to the live schema by ./column_projections.db.test.ts.
 * This file pins the aliased JOIN read and the reverse read's tiebreak.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	CELL_FIELD_COLUMNS,
	query_cell_field_set,
	query_cell_field_list_for_source,
	query_cell_field_list_for_target
} from '#lib/db/cell_field_queries.ts';
import { query_cell_create } from '#lib/db/cell_queries.ts';
import { CELL_VIEWER_UNRESTRICTED } from '#lib/db/cell_view_sql.ts';

import { describe_db } from '../cell_db_fixture.ts';

describe_db('CellFieldQueries', (get_db) => {
	test('the f-aliased forward list read hydrates exactly CELL_FIELD_COLUMNS', async () => {
		const deps = { db: get_db() };
		const source = await query_cell_create(deps, { data: {} });
		const target = await query_cell_create(deps, { data: {} });
		await query_cell_field_set(deps, { source_id: source.id, name: 'link', target_id: target.id });
		// The aliased JOIN read: an unqualified `SELECT *` here would pull the
		// joined `cell` columns onto the row too, which this key set rejects.
		const listed = await query_cell_field_list_for_source(
			deps,
			CELL_VIEWER_UNRESTRICTED,
			source.id
		);
		assert.strictEqual(listed.length, 1);
		assert.deepEqual(Object.keys(listed[0]!).sort(), [...CELL_FIELD_COLUMNS].sort());
		assert.strictEqual(listed[0]!.target_id, target.id);
	});

	test('the reverse read breaks a created_at tie by source, then name', async () => {
		const deps = { db: get_db() };
		const target = await query_cell_create(deps, { data: {} });
		const [low, high] = [
			await query_cell_create(deps, { data: {} }),
			await query_cell_create(deps, { data: {} })
		]
			.map((c) => c.id)
			.sort();
		// inserted against key order, then given one instant
		for (const source_id of [high!, low!]) {
			for (const name of ['b', 'a']) {
				await query_cell_field_set(deps, { source_id, name, target_id: target.id });
			}
		}
		await deps.db.query(`UPDATE cell_field SET created_at = '2026-01-01T00:00:00Z'`);
		const listed = await query_cell_field_list_for_target(
			deps,
			CELL_VIEWER_UNRESTRICTED,
			target.id
		);
		assert.deepEqual(
			listed.map((f) => [f.source_id, f.name]),
			[
				[low, 'a'],
				[low, 'b'],
				[high, 'a'],
				[high, 'b']
			]
		);
	});
});
