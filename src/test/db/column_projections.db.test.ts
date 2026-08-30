/**
 * Tests for column_projections.ts — the named-projection registry against the
 * live full-spine schema: every `*_COLUMNS` const pinned through
 * `assert_columns_match_live`, then one catalog scan proving no public table is
 * missing from the registry.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { query_public_columns } from '$lib/db/schema_ready.ts';
import { assert_columns_match_live } from '$lib/testing/db.ts';

import { describe_db } from '../cell_db_fixture.ts';
import { column_projections, column_projection_exempt_tables } from './column_projections.ts';

describe_db('column_projections', (get_db) => {
	test('every registered const names exactly its live table columns', async () => {
		for (const [table, columns] of Object.entries(column_projections)) {
			await assert_columns_match_live(get_db(), table, columns);
		}
	});

	test('every live public table is registered or exempted', async () => {
		const live = await query_public_columns(get_db());
		const registered = [
			...Object.keys(column_projections),
			...Object.keys(column_projection_exempt_tables)
		].sort();
		assert.deepEqual(Object.keys(live).sort(), registered);
	});
});
