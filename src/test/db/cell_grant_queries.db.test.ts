/**
 * Tests for cell_grant_queries.ts — the named-column projection.
 *
 * Grant semantics (UPSERT, principal shapes, caller matching) are exercised
 * end-to-end by the RPC parity suites (`../auth/cell_relations_parity.db.test.ts`,
 * `../auth/cell_grant_role_parity.db.test.ts`); the const is pinned to the live
 * schema by ./column_projections.db.test.ts. This file pins the aliased JOIN read.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	CELL_GRANT_COLUMNS,
	query_cell_grant_create,
	query_cell_grants_for_caller_in_cells
} from '$lib/db/cell_grant_queries.ts';
import { query_cell_create } from '$lib/db/cell_queries.ts';

import { describe_db } from '../cell_db_fixture.ts';

/**
 * Any role name works at the query layer — the unknown-role gate lives in the
 * action layer, so the RPC suites' registered `member` role isn't needed here.
 */
const ROLE = 'member';

describe_db('CellGrantQueries', (get_db) => {
	test('the g-aliased caller-match read hydrates exactly CELL_GRANT_COLUMNS', async () => {
		const deps = { db: get_db() };
		const cell = await query_cell_create(deps, { data: {} });
		const created = await query_cell_grant_create(deps, {
			cell_id: cell.id,
			level: 'viewer',
			principal: { kind: 'role', role: ROLE, scope_id: null },
			granted_by: null
		});
		// The aliased JOIN read: an unqualified `SELECT *` here would pull the
		// joined `cell` columns onto the row too, which this key set rejects.
		const matched = await query_cell_grants_for_caller_in_cells(
			deps,
			[cell.id],
			null,
			[ROLE],
			[null]
		);
		assert.strictEqual(matched.length, 1);
		assert.deepEqual(Object.keys(matched[0]!).sort(), [...CELL_GRANT_COLUMNS].sort());
		assert.strictEqual(matched[0]!.id, created.id);
	});
});
