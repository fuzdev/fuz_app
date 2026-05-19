/**
 * Unit tests for the cross-impl schema-parity diff + format helpers.
 *
 * Covers every `SchemaDiff` kind via minimal hand-built snapshots — the
 * per-field tests under `column_field_differs` also act as a coverage
 * check on `COLUMN_FIELDS`: if a member is missing from the iteration
 * set, the corresponding field-drift test produces zero diffs and fails.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	assert_schema_snapshots_equal,
	diff_schema_snapshots,
	format_schema_diffs,
} from '$lib/testing/schema_parity.js';
import type {
	ColumnSnapshot,
	SchemaSnapshot,
	TableSnapshot,
} from '$lib/testing/schema_introspect.js';

const create_column = (overrides: Partial<ColumnSnapshot> = {}): ColumnSnapshot => ({
	data_type: 'text',
	udt_name: 'text',
	is_nullable: false,
	column_default: null,
	is_identity: false,
	...overrides,
});

const create_table = (overrides: Partial<TableSnapshot> = {}): TableSnapshot => ({
	columns: {},
	indexes: [],
	constraints: [],
	...overrides,
});

const create_snapshot = (overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot => ({
	schema_version: [],
	tables: {},
	sequences: {},
	...overrides,
});

describe('diff_schema_snapshots', () => {
	test('empty snapshots produce no diff', () => {
		const diffs = diff_schema_snapshots(create_snapshot(), create_snapshot());
		assert.deepStrictEqual(diffs, []);
	});

	test('matching snapshots produce no diff', () => {
		const snap = create_snapshot({
			schema_version: [{namespace: 'fuz_auth', name: 'm0', sequence: 0}],
			tables: {foo: create_table({columns: {id: create_column()}})},
			sequences: {foo_id_seq: {data_type: 'bigint'}},
		});
		const diffs = diff_schema_snapshots(snap, snap);
		assert.deepStrictEqual(diffs, []);
	});

	test('schema_version_only_in: row missing on b', () => {
		const row = {namespace: 'fuz_auth', name: 'm0', sequence: 0};
		const diffs = diff_schema_snapshots(
			create_snapshot({schema_version: [row]}),
			create_snapshot(),
		);
		assert.deepStrictEqual(diffs, [{kind: 'schema_version_only_in', where: 'a', row}]);
	});

	test('schema_version_only_in: row missing on a', () => {
		const row = {namespace: 'fuz_auth', name: 'm0', sequence: 0};
		const diffs = diff_schema_snapshots(
			create_snapshot(),
			create_snapshot({schema_version: [row]}),
		);
		assert.deepStrictEqual(diffs, [{kind: 'schema_version_only_in', where: 'b', row}]);
	});

	test('schema_version_sequence_differs', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({schema_version: [{namespace: 'fuz_auth', name: 'm0', sequence: 0}]}),
			create_snapshot({schema_version: [{namespace: 'fuz_auth', name: 'm0', sequence: 1}]}),
		);
		assert.deepStrictEqual(diffs, [
			{kind: 'schema_version_sequence_differs', namespace: 'fuz_auth', name: 'm0', a: 0, b: 1},
		]);
	});

	test('table_only_in (both sides)', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({tables: {foo: create_table()}}),
			create_snapshot({tables: {bar: create_table()}}),
		);
		assert.deepStrictEqual(diffs, [
			{kind: 'table_only_in', where: 'b', table: 'bar'},
			{kind: 'table_only_in', where: 'a', table: 'foo'},
		]);
	});

	test('column_only_in (both sides)', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({tables: {foo: create_table({columns: {a: create_column()}})}}),
			create_snapshot({tables: {foo: create_table({columns: {b: create_column()}})}}),
		);
		assert.deepStrictEqual(diffs, [
			{kind: 'column_only_in', where: 'a', table: 'foo', column: 'a'},
			{kind: 'column_only_in', where: 'b', table: 'foo', column: 'b'},
		]);
	});

	// Per-field column diffs — also acts as an exhaustiveness check on
	// COLUMN_FIELDS. A member missing from the iteration set produces zero
	// diffs and fails the corresponding test below.
	test('column_field_differs: data_type', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({data_type: 'integer'})}})},
			}),
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({data_type: 'bigint'})}})},
			}),
		);
		assert.strictEqual(diffs.length, 1);
		assert.deepStrictEqual(diffs[0], {
			kind: 'column_field_differs',
			table: 't',
			column: 'c',
			field: 'data_type',
			a: 'integer',
			b: 'bigint',
		});
	});

	test('column_field_differs: udt_name (catches SERIAL vs BIGSERIAL)', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({udt_name: 'int4'})}})},
			}),
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({udt_name: 'int8'})}})},
			}),
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0]?.kind, 'column_field_differs');
		assert.strictEqual(diffs[0]!.kind === 'column_field_differs' && diffs[0].field, 'udt_name');
	});

	test('column_field_differs: is_nullable', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({is_nullable: true})}})},
			}),
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({is_nullable: false})}})},
			}),
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0]?.kind, 'column_field_differs');
		assert.strictEqual(diffs[0]!.kind === 'column_field_differs' && diffs[0].field, 'is_nullable');
	});

	test('column_field_differs: column_default', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({column_default: null})}})},
			}),
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({column_default: 'NOW()'})}})},
			}),
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0]?.kind, 'column_field_differs');
		assert.strictEqual(
			diffs[0]!.kind === 'column_field_differs' && diffs[0].field,
			'column_default',
		);
	});

	test('column_field_differs: is_identity', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({is_identity: false})}})},
			}),
			create_snapshot({
				tables: {t: create_table({columns: {c: create_column({is_identity: true})}})},
			}),
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0]?.kind, 'column_field_differs');
		assert.strictEqual(diffs[0]!.kind === 'column_field_differs' && diffs[0].field, 'is_identity');
	});

	test('index_only_in (both sides)', () => {
		const a_only_idx = {name: 'idx_a', definition: 'CREATE INDEX idx_a ON t (x)'};
		const b_only_idx = {name: 'idx_b', definition: 'CREATE INDEX idx_b ON t (y)'};
		const diffs = diff_schema_snapshots(
			create_snapshot({tables: {t: create_table({indexes: [a_only_idx]})}}),
			create_snapshot({tables: {t: create_table({indexes: [b_only_idx]})}}),
		);
		assert.deepStrictEqual(diffs, [
			{kind: 'index_only_in', where: 'a', table: 't', index: 'idx_a'},
			{kind: 'index_only_in', where: 'b', table: 't', index: 'idx_b'},
		]);
	});

	test('index_definition_differs', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {
					t: create_table({indexes: [{name: 'idx', definition: 'CREATE INDEX idx ON t (x)'}]}),
				},
			}),
			create_snapshot({
				tables: {
					t: create_table({indexes: [{name: 'idx', definition: 'CREATE INDEX idx ON t (y)'}]}),
				},
			}),
		);
		assert.deepStrictEqual(diffs, [
			{
				kind: 'index_definition_differs',
				table: 't',
				index: 'idx',
				a: 'CREATE INDEX idx ON t (x)',
				b: 'CREATE INDEX idx ON t (y)',
			},
		]);
	});

	test('constraint_only_in (both sides)', () => {
		const a_only = {name: 'pk_a', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (a)'};
		const b_only = {name: 'pk_b', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (b)'};
		const diffs = diff_schema_snapshots(
			create_snapshot({tables: {t: create_table({constraints: [a_only]})}}),
			create_snapshot({tables: {t: create_table({constraints: [b_only]})}}),
		);
		assert.deepStrictEqual(diffs, [
			{kind: 'constraint_only_in', where: 'a', table: 't', constraint: 'pk_a'},
			{kind: 'constraint_only_in', where: 'b', table: 't', constraint: 'pk_b'},
		]);
	});

	test('constraint_differs by type', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {
					t: create_table({
						constraints: [{name: 'c', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (x)'}],
					}),
				},
			}),
			create_snapshot({
				tables: {
					t: create_table({constraints: [{name: 'c', type: 'UNIQUE', definition: 'UNIQUE (x)'}]}),
				},
			}),
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0]?.kind, 'constraint_differs');
	});

	test('constraint_differs by definition', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {
					t: create_table({constraints: [{name: 'c', type: 'CHECK', definition: 'CHECK (x > 0)'}]}),
				},
			}),
			create_snapshot({
				tables: {
					t: create_table({
						constraints: [{name: 'c', type: 'CHECK', definition: 'CHECK (x >= 0)'}],
					}),
				},
			}),
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0]?.kind, 'constraint_differs');
	});

	test('sequence_only_in (both sides)', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({sequences: {seq_a: {data_type: 'bigint'}}}),
			create_snapshot({sequences: {seq_b: {data_type: 'bigint'}}}),
		);
		assert.deepStrictEqual(diffs, [
			{kind: 'sequence_only_in', where: 'a', sequence: 'seq_a'},
			{kind: 'sequence_only_in', where: 'b', sequence: 'seq_b'},
		]);
	});

	test('sequence_data_type_differs (catches SERIAL vs BIGSERIAL on the sequence)', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({sequences: {seq: {data_type: 'integer'}}}),
			create_snapshot({sequences: {seq: {data_type: 'bigint'}}}),
		);
		assert.deepStrictEqual(diffs, [
			{kind: 'sequence_data_type_differs', sequence: 'seq', a: 'integer', b: 'bigint'},
		]);
	});

	test('multi-field column drift emits one diff per field', () => {
		const diffs = diff_schema_snapshots(
			create_snapshot({
				tables: {
					t: create_table({
						columns: {
							c: create_column({
								data_type: 'integer',
								udt_name: 'int4',
								is_nullable: false,
							}),
						},
					}),
				},
			}),
			create_snapshot({
				tables: {
					t: create_table({
						columns: {
							c: create_column({
								data_type: 'bigint',
								udt_name: 'int8',
								is_nullable: true,
							}),
						},
					}),
				},
			}),
		);
		assert.strictEqual(diffs.length, 3);
		const fields = diffs
			.filter((d) => d.kind === 'column_field_differs')

			.map((d) => (d.kind === 'column_field_differs' ? d.field : null));
		// eslint-disable-next-line @typescript-eslint/require-array-sort-compare
		assert.deepStrictEqual(fields.sort(), ['data_type', 'is_nullable', 'udt_name']);
	});

	test('diffs emit in documented order: schema_version → tables → sequences', () => {
		// Mixed drift across all three sections + multiple tables to verify the
		// sub-orderings (tables sorted, sub-diffs grouped per table).
		const a = create_snapshot({
			schema_version: [{namespace: 'fuz_auth', name: 'older', sequence: 0}],
			tables: {
				zebra: create_table({columns: {id: create_column()}}),
				alpha: create_table({columns: {x: create_column({data_type: 'text'})}}),
			},
			sequences: {seq_z: {data_type: 'bigint'}},
		});
		const b = create_snapshot({
			schema_version: [{namespace: 'fuz_auth', name: 'newer', sequence: 0}],
			tables: {
				alpha: create_table({columns: {x: create_column({data_type: 'integer'})}}),
				bravo: create_table({columns: {y: create_column()}}),
			},
			sequences: {seq_a: {data_type: 'bigint'}},
		});
		const diff_kinds = diff_schema_snapshots(a, b).map((d) => d.kind);
		// schema_version diffs first
		assert.strictEqual(diff_kinds[0], 'schema_version_only_in');
		assert.strictEqual(diff_kinds[1], 'schema_version_only_in');
		// Tables in sorted order: alpha (column_field_differs), bravo (table_only_in),
		// then zebra (table_only_in). Sequences last.
		const sv_count = 2;
		assert.strictEqual(diff_kinds[sv_count], 'column_field_differs'); // alpha
		assert.strictEqual(diff_kinds[sv_count + 1], 'table_only_in'); // bravo
		assert.strictEqual(diff_kinds[sv_count + 2], 'table_only_in'); // zebra
		// Sequences appear after the tables block.
		assert.ok(diff_kinds.lastIndexOf('sequence_only_in') > diff_kinds.indexOf('table_only_in'));
	});
});

describe('format_schema_diffs', () => {
	test('empty diffs render an empty string', () => {
		assert.strictEqual(format_schema_diffs([]), '');
	});

	test('default labels are a / b', () => {
		const rendered = format_schema_diffs([
			{kind: 'table_only_in', where: 'a', table: 'foo'},
			{kind: 'table_only_in', where: 'b', table: 'bar'},
		]);
		assert.match(rendered, /only in a/);
		assert.match(rendered, /only in b/);
	});

	test('custom labels flow through', () => {
		const rendered = format_schema_diffs(
			[{kind: 'sequence_data_type_differs', sequence: 'seq', a: 'integer', b: 'bigint'}],
			{a: 'deno', b: 'rust'},
		);
		assert.match(rendered, /deno=integer/);
		assert.match(rendered, /rust=bigint/);
	});

	test('renders a representative drift mix', () => {
		const rendered = format_schema_diffs(
			[
				{kind: 'table_only_in', where: 'a', table: 'foo'},
				{
					kind: 'column_field_differs',
					table: 't',
					column: 'seq',
					field: 'udt_name',
					a: 'int4',
					b: 'int8',
				},
				{
					kind: 'index_definition_differs',
					table: 't',
					index: 'idx',
					a: 'CREATE INDEX idx ON t (x)',
					b: 'CREATE INDEX idx ON t (y)',
				},
			],
			{a: 'deno', b: 'rust'},
		);
		assert.match(rendered, /table foo only in deno/);
		assert.match(rendered, /t\.seq udt_name differs: deno="int4", rust="int8"/);
		assert.match(rendered, /index idx on t differs/);
	});
});

describe('assert_schema_snapshots_equal', () => {
	test('no-op when snapshots match', () => {
		assert.doesNotThrow(() => assert_schema_snapshots_equal(create_snapshot(), create_snapshot()));
	});

	test('throws with both labels and the diff count', () => {
		try {
			assert_schema_snapshots_equal(
				create_snapshot({tables: {foo: create_table()}}),
				create_snapshot(),
				{a: 'deno', b: 'rust'},
			);
			assert.fail('expected throw');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.match(err.message, /1 diff\(s\) between deno and rust/);
			assert.match(err.message, /table foo only in deno/);
		}
	});
});
