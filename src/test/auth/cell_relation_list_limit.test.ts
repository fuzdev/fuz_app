/**
 * Tests for the relation-list page bound — `CellRelationListLimit` and the
 * `limit` input of `cell_field_list` / `cell_item_list`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import {
	CELL_RELATION_LIST_LIMIT_DEFAULT,
	CELL_RELATION_LIST_LIMIT_MAX,
	CellRelationListLimit
} from '#lib/auth/cell_relation_list_limit.ts';
import { CellFieldListInput } from '#lib/auth/cell_field_action_specs.ts';
import { CellItemListInput } from '#lib/auth/cell_item_action_specs.ts';

const ID = '3f8a1c2e-1234-4abc-9def-0123456789ab';

describe('CellRelationListLimit', () => {
	test('the default page sits within the cap', () => {
		assert.ok(CELL_RELATION_LIST_LIMIT_DEFAULT >= 1);
		assert.ok(CELL_RELATION_LIST_LIMIT_DEFAULT <= CELL_RELATION_LIST_LIMIT_MAX);
	});

	test('admits omitted and 1 through the cap', () => {
		for (const ok of [
			undefined,
			1,
			CELL_RELATION_LIST_LIMIT_DEFAULT,
			CELL_RELATION_LIST_LIMIT_MAX
		]) {
			assert.ok(is(CellRelationListLimit, ok), String(ok));
		}
	});

	test('refuses zero, negatives, fractions, and past the cap', () => {
		for (const bad of [0, -1, 1.5, CELL_RELATION_LIST_LIMIT_MAX + 1, null, '5']) {
			assert.ok(!is(CellRelationListLimit, bad), String(bad));
		}
	});

	test('both list inputs bound limit the same way, either direction', () => {
		for (const [schema, keys] of [
			[CellFieldListInput, ['source_id', 'target_id']],
			[CellItemListInput, ['parent_id', 'child_id']]
		] as const) {
			for (const key of keys) {
				assert.ok(is(schema, { [key]: ID, limit: CELL_RELATION_LIST_LIMIT_MAX }));
				assert.ok(!is(schema, { [key]: ID, limit: CELL_RELATION_LIST_LIMIT_MAX + 1 }));
				assert.ok(!is(schema, { [key]: ID, limit: 0 }));
			}
		}
	});
});
