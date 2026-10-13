/**
 * Tests for `cell_action_specs.ts` — the length cap on the wire `kind`, on
 * `cell_create` and on the `cell_list` filter.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	CELL_KIND_LENGTH_MAX,
	CellCreateInput,
	CellListInput
} from '#lib/auth/cell_action_specs.ts';

const astral = '\u{1F600}';

describe('cell kind length cap', () => {
	test('CellCreateInput admits a kind at the cap and refuses one past it', () => {
		const at_cap = CellCreateInput.safeParse({ data: {}, kind: 'a'.repeat(CELL_KIND_LENGTH_MAX) });
		assert.ok(at_cap.success);
		assert.strictEqual(at_cap.data.kind?.length, CELL_KIND_LENGTH_MAX);
		assert.ok(
			!CellCreateInput.safeParse({ data: {}, kind: 'a'.repeat(CELL_KIND_LENGTH_MAX + 1) }).success
		);
		// typeless stays admitted
		assert.ok(CellCreateInput.safeParse({ data: {}, kind: null }).success);
		assert.ok(CellCreateInput.safeParse({ data: {} }).success);
	});

	test('CellCreateInput counts UTF-16 code units', () => {
		assert.ok(
			CellCreateInput.safeParse({ data: {}, kind: astral.repeat(CELL_KIND_LENGTH_MAX / 2) }).success
		);
		assert.ok(
			!CellCreateInput.safeParse({ data: {}, kind: astral.repeat(CELL_KIND_LENGTH_MAX / 2) + 'a' })
				.success
		);
	});

	test('CellListInput admits a kind filter at the cap and refuses one past it', () => {
		assert.ok(CellListInput.safeParse({ kind: 'a'.repeat(CELL_KIND_LENGTH_MAX) }).success);
		assert.ok(!CellListInput.safeParse({ kind: 'a'.repeat(CELL_KIND_LENGTH_MAX + 1) }).success);
		// the empty filter is admitted: it matches nothing
		assert.ok(CellListInput.safeParse({ kind: '' }).success);
	});
});
