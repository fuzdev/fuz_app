/**
 * Tests for cell_queries.ts — the named-column projection.
 *
 * CRUD + list semantics are exercised end-to-end by the RPC parity suites
 * (`../auth/cell_crud_parity.db.test.ts` and siblings); the const is pinned to
 * the live schema by ./column_projections.db.test.ts. This file pins the
 * derived `grant_count` projection.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { CELL_COLUMNS, query_cell_create } from '$lib/db/cell_queries.ts';

import { describe_db } from '../cell_db_fixture.ts';

describe_db('CellQueries', (get_db) => {
	test('cell_row_projection hydrates CELL_COLUMNS plus the derived grant_count', async () => {
		// `CELL_COLUMNS` itself is pinned to the live table by the registry test
		// (`./column_projections.db.test.ts`); this pins the one thing that isn't a
		// column — `grant_count` — landing on every row through `cell_row_projection`.
		const deps = { db: get_db() };
		const created = await query_cell_create(deps, { data: { label: 'projection' } });
		assert.deepEqual(Object.keys(created).sort(), [...CELL_COLUMNS, 'grant_count'].sort());
		assert.strictEqual(created.grant_count, 0);
	});
});
