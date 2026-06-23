import './assert_dev_env.ts';

/**
 * Cross-impl schema parity — structural diff + assertion over two
 * `SchemaSnapshot`s captured via `query_schema_snapshot`.
 *
 * Two live impls (TS fuz_app vs Rust spine) are each other's parity
 * reference. After both bootstrap, snapshot each, diff, fail loudly on
 * drift. The diff entries name the specific divergence (column type,
 * missing index, constraint absent on one side) so the error
 * message points at the source.
 *
 * Consumer pattern (in zzz's integration runner or fuz_app's own
 * cross-backend tests):
 *
 * ```ts
 * const snapshot_a = await query_schema_snapshot(db_after_deno_bootstrap);
 * const snapshot_b = await query_schema_snapshot(db_after_rust_bootstrap);
 * assert_schema_snapshots_equal(snapshot_a, snapshot_b, {a: 'deno', b: 'rust'});
 * ```
 *
 * Non-coverage — drift the gate does **not** detect:
 *
 * - regular triggers (`pg_trigger`); `CONSTRAINT TRIGGER` is captured via
 *   pg_constraint, but standalone `CREATE TRIGGER` is not
 * - views, materialized views, functions, procedures
 * - table storage parameters (fillfactor, tablespace, autovacuum settings)
 * - column physical order — the snapshot keys columns by name, so two
 *   impls with the same columns in different declaration order compare
 *   equal (functional parity is preserved; `SELECT *` ordering is not)
 * - `COMMENT ON ...`
 * - the `schema_version` migration tracker (always excluded — framework
 *   bookkeeping, not domain schema)
 * - permissions / `GRANT`s
 *
 * None of these are used by the current fuz_app auth schema. Extend
 * `query_schema_snapshot` + `SchemaDiff` if a consumer's schema reaches
 * for them; omitting them today keeps the diff surface focused on what
 * fuz_app actually emits.
 *
 * @module
 */

import type {
	ColumnSnapshot,
	EnumTypeSnapshot,
	MigrationTracker,
	SchemaSnapshot,
	SequenceSnapshot,
	TableSnapshot,
} from './schema_introspect.ts';

/** Structured drift entry. `where` is the named source impl ('a' or 'b'). */
export type SchemaDiff =
	| {readonly kind: 'table_only_in'; readonly where: 'a' | 'b'; readonly table: string}
	| {
			readonly kind: 'column_only_in';
			readonly where: 'a' | 'b';
			readonly table: string;
			readonly column: string;
	  }
	| {
			readonly kind: 'column_field_differs';
			readonly table: string;
			readonly column: string;
			readonly field: keyof ColumnSnapshot;
			readonly a: unknown;
			readonly b: unknown;
	  }
	| {
			readonly kind: 'index_only_in';
			readonly where: 'a' | 'b';
			readonly table: string;
			readonly index: string;
	  }
	| {
			readonly kind: 'index_definition_differs';
			readonly table: string;
			readonly index: string;
			readonly a: string;
			readonly b: string;
	  }
	| {
			readonly kind: 'constraint_only_in';
			readonly where: 'a' | 'b';
			readonly table: string;
			readonly constraint: string;
	  }
	| {
			readonly kind: 'constraint_differs';
			readonly table: string;
			readonly constraint: string;
			readonly a: {type: string; definition: string};
			readonly b: {type: string; definition: string};
	  }
	| {readonly kind: 'sequence_only_in'; readonly where: 'a' | 'b'; readonly sequence: string}
	| {
			readonly kind: 'sequence_data_type_differs';
			readonly sequence: string;
			readonly a: string;
			readonly b: string;
	  }
	| {readonly kind: 'enum_only_in'; readonly where: 'a' | 'b'; readonly enum_name: string}
	| {
			readonly kind: 'enum_labels_differ';
			readonly enum_name: string;
			readonly a: ReadonlyArray<string>;
			readonly b: ReadonlyArray<string>;
	  };

/**
 * Structural diff between two snapshots — empty array means parity holds.
 *
 * Order of diffs is deterministic: tables in sorted order (with
 * column/index/constraint sub-diffs grouped per table), then sequences.
 * Consumers can rely on this for stable diff output.
 */
export const diff_schema_snapshots = (a: SchemaSnapshot, b: SchemaSnapshot): Array<SchemaDiff> => {
	const diffs: Array<SchemaDiff> = [];

	const all_tables = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
	for (const table of [...all_tables].sort()) {
		const ta = a.tables[table];
		const tb = b.tables[table];
		if (!ta) {
			diffs.push({kind: 'table_only_in', where: 'b', table});
			continue;
		}
		if (!tb) {
			diffs.push({kind: 'table_only_in', where: 'a', table});
			continue;
		}
		diff_table(table, ta, tb, diffs);
	}

	const all_sequences = new Set([...Object.keys(a.sequences), ...Object.keys(b.sequences)]);
	for (const sequence of [...all_sequences].sort()) {
		const sa = a.sequences[sequence];
		const sb = b.sequences[sequence];
		if (!sa) {
			diffs.push({kind: 'sequence_only_in', where: 'b', sequence});
			continue;
		}
		if (!sb) {
			diffs.push({kind: 'sequence_only_in', where: 'a', sequence});
			continue;
		}
		diff_sequence(sequence, sa, sb, diffs);
	}

	const all_enums = new Set([...Object.keys(a.enums), ...Object.keys(b.enums)]);
	for (const enum_name of [...all_enums].sort()) {
		const ea = a.enums[enum_name];
		const eb = b.enums[enum_name];
		if (!ea) {
			diffs.push({kind: 'enum_only_in', where: 'b', enum_name});
			continue;
		}
		if (!eb) {
			diffs.push({kind: 'enum_only_in', where: 'a', enum_name});
			continue;
		}
		diff_enum(enum_name, ea, eb, diffs);
	}

	return diffs;
};

const COLUMN_FIELDS = [
	'data_type',
	'udt_name',
	'is_nullable',
	'column_default',
	'is_identity',
] as const satisfies ReadonlyArray<keyof ColumnSnapshot>;

const diff_table = (
	table: string,
	a: TableSnapshot,
	b: TableSnapshot,
	out: Array<SchemaDiff>,
): void => {
	const all_columns = new Set([...Object.keys(a.columns), ...Object.keys(b.columns)]);
	for (const column of [...all_columns].sort()) {
		const ca = a.columns[column];
		const cb = b.columns[column];
		if (!ca) {
			out.push({kind: 'column_only_in', where: 'b', table, column});
			continue;
		}
		if (!cb) {
			out.push({kind: 'column_only_in', where: 'a', table, column});
			continue;
		}
		for (const field of COLUMN_FIELDS) {
			if (ca[field] !== cb[field]) {
				out.push({
					kind: 'column_field_differs',
					table,
					column,
					field,
					a: ca[field],
					b: cb[field],
				});
			}
		}
	}

	const a_indexes = new Map(a.indexes.map((i) => [i.name, i.definition]));
	const b_indexes = new Map(b.indexes.map((i) => [i.name, i.definition]));
	const all_indexes = new Set([...a_indexes.keys(), ...b_indexes.keys()]);
	for (const index of [...all_indexes].sort()) {
		const def_a = a_indexes.get(index);
		const def_b = b_indexes.get(index);
		if (def_a === undefined) {
			out.push({kind: 'index_only_in', where: 'b', table, index});
			continue;
		}
		if (def_b === undefined) {
			out.push({kind: 'index_only_in', where: 'a', table, index});
			continue;
		}
		if (def_a !== def_b) {
			out.push({kind: 'index_definition_differs', table, index, a: def_a, b: def_b});
		}
	}

	const a_constraints = new Map(a.constraints.map((c) => [c.name, c]));
	const b_constraints = new Map(b.constraints.map((c) => [c.name, c]));
	const all_constraints = new Set([...a_constraints.keys(), ...b_constraints.keys()]);
	for (const constraint of [...all_constraints].sort()) {
		const ca = a_constraints.get(constraint);
		const cb = b_constraints.get(constraint);
		if (!ca) {
			out.push({kind: 'constraint_only_in', where: 'b', table, constraint});
			continue;
		}
		if (!cb) {
			out.push({kind: 'constraint_only_in', where: 'a', table, constraint});
			continue;
		}
		if (ca.type !== cb.type || ca.definition !== cb.definition) {
			out.push({
				kind: 'constraint_differs',
				table,
				constraint,
				a: {type: ca.type, definition: ca.definition},
				b: {type: cb.type, definition: cb.definition},
			});
		}
	}
};

const diff_sequence = (
	sequence: string,
	a: SequenceSnapshot,
	b: SequenceSnapshot,
	out: Array<SchemaDiff>,
): void => {
	if (a.data_type !== b.data_type) {
		out.push({
			kind: 'sequence_data_type_differs',
			sequence,
			a: a.data_type,
			b: b.data_type,
		});
	}
};

const diff_enum = (
	enum_name: string,
	a: EnumTypeSnapshot,
	b: EnumTypeSnapshot,
	out: Array<SchemaDiff>,
): void => {
	// Labels are an ordered set — compare positionally, so both a missing/extra
	// label and a reorder (a real schema change) surface as drift.
	const differ = a.labels.length !== b.labels.length || a.labels.some((l, i) => l !== b.labels[i]);
	if (differ) {
		out.push({kind: 'enum_labels_differ', enum_name, a: a.labels, b: b.labels});
	}
};

/** Labels used in formatted output — defaults to `'a'` and `'b'`. */
export interface SchemaDiffLabels {
	readonly a?: string;
	readonly b?: string;
}

/**
 * Render a diff list as a human-readable multi-line string. Empty diffs
 * produce an empty string.
 */
export const format_schema_diffs = (
	diffs: ReadonlyArray<SchemaDiff>,
	labels: SchemaDiffLabels = {},
): string => {
	if (diffs.length === 0) return '';
	const label_a = labels.a ?? 'a';
	const label_b = labels.b ?? 'b';
	const where_label = (where: 'a' | 'b'): string => (where === 'a' ? label_a : label_b);

	const lines: Array<string> = [];
	for (const d of diffs) {
		switch (d.kind) {
			case 'table_only_in':
				lines.push(`  table ${d.table} only in ${where_label(d.where)}`);
				break;
			case 'column_only_in':
				lines.push(`  ${d.table}.${d.column} only in ${where_label(d.where)}`);
				break;
			case 'column_field_differs':
				lines.push(
					`  ${d.table}.${d.column} ${d.field} differs: ${label_a}=${JSON.stringify(d.a)}, ${
						label_b
					}=${JSON.stringify(d.b)}`,
				);
				break;
			case 'index_only_in':
				lines.push(`  index ${d.index} on ${d.table} only in ${where_label(d.where)}`);
				break;
			case 'index_definition_differs':
				lines.push(
					`  index ${d.index} on ${d.table} differs:\n    ${label_a}: ${d.a}\n    ${label_b}: ${
						d.b
					}`,
				);
				break;
			case 'constraint_only_in':
				lines.push(`  constraint ${d.constraint} on ${d.table} only in ${where_label(d.where)}`);
				break;
			case 'constraint_differs':
				lines.push(
					`  constraint ${d.constraint} on ${d.table} differs:\n    ${label_a}: ${d.a.type} ${
						d.a.definition
					}\n    ${label_b}: ${d.b.type} ${d.b.definition}`,
				);
				break;
			case 'sequence_only_in':
				lines.push(`  sequence ${d.sequence} only in ${where_label(d.where)}`);
				break;
			case 'sequence_data_type_differs':
				lines.push(
					`  sequence ${d.sequence} data_type differs: ${label_a}=${d.a}, ${label_b}=${d.b}`,
				);
				break;
			case 'enum_only_in':
				lines.push(`  enum ${d.enum_name} only in ${where_label(d.where)}`);
				break;
			case 'enum_labels_differ':
				lines.push(
					`  enum ${d.enum_name} labels differ: ${label_a}=${JSON.stringify(d.a)}, ${
						label_b
					}=${JSON.stringify(d.b)}`,
				);
				break;
			default:
				// Compile-time exhaustiveness — a new SchemaDiff variant without a
				// case here makes `d` non-never and fails type-check.
				d satisfies never;
				break;
		}
	}
	return lines.join('\n');
};

/**
 * Throw if the two snapshots disagree. The error message names the impls
 * (via `labels`) and lists every diff, so the failure is self-diagnosing.
 *
 * Consumers wire this after bootstrapping each impl against an isolated DB:
 *
 * ```ts
 * await drop_recreate_db('zzz_test');
 * await spawn_backend(deno_config);
 * const snapshot_deno = await query_schema_snapshot(db, {});
 * await drop_recreate_db('zzz_test');
 * await spawn_backend(rust_config);
 * const snapshot_rust = await query_schema_snapshot(db, {});
 * assert_schema_snapshots_equal(snapshot_deno, snapshot_rust, {a: 'deno', b: 'rust'});
 * ```
 */
export const assert_schema_snapshots_equal = (
	a: SchemaSnapshot,
	b: SchemaSnapshot,
	labels: SchemaDiffLabels = {},
): void => {
	const diffs = diff_schema_snapshots(a, b);
	if (diffs.length === 0) return;
	const label_a = labels.a ?? 'a';
	const label_b = labels.b ?? 'b';
	throw new Error(
		`Schema parity failed: ${diffs.length} diff(s) between ${label_a} and ${
			label_b
		}\n${format_schema_diffs(diffs, labels)}`,
	);
};

/**
 * Structured migration-identity drift entry. Keyed on `(namespace, name)` —
 * the `schema_version` PK — so a name rename and a partitioning change both
 * surface as `tracker_row_only_in`, and a re-order surfaces as
 * `tracker_sequence_differs`.
 */
export type MigrationTrackerDiff =
	| {
			readonly kind: 'tracker_row_only_in';
			readonly where: 'a' | 'b';
			readonly namespace: string;
			readonly name: string;
	  }
	| {
			readonly kind: 'tracker_sequence_differs';
			readonly namespace: string;
			readonly name: string;
			readonly a: number;
			readonly b: number;
	  };

const tracker_key = (namespace: string, name: string): string => `${namespace} ${name}`;

/**
 * Structural diff between two migration trackers — empty array means the two
 * spines recorded byte-identical migration identity. Keyed on
 * `(namespace, name)`; sequence mismatches on a shared key are reported too.
 * Deterministic order: shared/missing rows in sorted `(namespace, name)` order.
 */
export const diff_migration_trackers = (
	a: MigrationTracker,
	b: MigrationTracker,
): Array<MigrationTrackerDiff> => {
	const diffs: Array<MigrationTrackerDiff> = [];
	const a_by_key = new Map(a.entries.map((e) => [tracker_key(e.namespace, e.name), e]));
	const b_by_key = new Map(b.entries.map((e) => [tracker_key(e.namespace, e.name), e]));
	// Union keyed by `(namespace, name)`; the value is a reference entry (from
	// whichever side has it) used to recover namespace/name for the diff — so a
	// row present on only one side needs no non-null assertion.
	const by_key = new Map([...a_by_key, ...b_by_key]);
	for (const [key, ref] of [...by_key].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
		const ea = a_by_key.get(key);
		const eb = b_by_key.get(key);
		if (!ea) {
			diffs.push({
				kind: 'tracker_row_only_in',
				where: 'b',
				namespace: ref.namespace,
				name: ref.name,
			});
			continue;
		}
		if (!eb) {
			diffs.push({
				kind: 'tracker_row_only_in',
				where: 'a',
				namespace: ref.namespace,
				name: ref.name,
			});
			continue;
		}
		if (ea.sequence !== eb.sequence) {
			diffs.push({
				kind: 'tracker_sequence_differs',
				namespace: ea.namespace,
				name: ea.name,
				a: ea.sequence,
				b: eb.sequence,
			});
		}
	}
	return diffs;
};

/**
 * Render migration-tracker diffs as a human-readable multi-line string.
 * Empty diffs produce an empty string.
 */
export const format_migration_tracker_diffs = (
	diffs: ReadonlyArray<MigrationTrackerDiff>,
	labels: SchemaDiffLabels = {},
): string => {
	if (diffs.length === 0) return '';
	const label_a = labels.a ?? 'a';
	const label_b = labels.b ?? 'b';
	const lines: Array<string> = [];
	for (const d of diffs) {
		switch (d.kind) {
			case 'tracker_row_only_in':
				lines.push(
					`  migration ${d.namespace}/${d.name} only in ${d.where === 'a' ? label_a : label_b}`,
				);
				break;
			case 'tracker_sequence_differs':
				lines.push(
					`  migration ${d.namespace}/${d.name} sequence differs: ${label_a}=${d.a}, ${
						label_b
					}=${d.b}`,
				);
				break;
			default:
				d satisfies never;
				break;
		}
	}
	return lines.join('\n');
};

/**
 * Throw if the two spines' `schema_version` trackers disagree — the gate for
 * the swap-freely invariant (any consumer can swap TS↔Rust over one DB without
 * re-bootstrapping). This catches what `assert_schema_snapshots_equal` is blind
 * to by design: the snapshot excludes the tracker, so a migration-name or
 * partitioning divergence that yields an identical *schema* (e.g. `cell_v0` vs
 * `full_cell_schema`, or `cell_history` bundled vs isolated) passes schema
 * parity but breaks the runner's positional name-prefix check at boot
 * (`name-divergence-at-N`). The error names the impls and lists every diff.
 */
export const assert_migration_trackers_equal = (
	a: MigrationTracker,
	b: MigrationTracker,
	labels: SchemaDiffLabels = {},
): void => {
	const diffs = diff_migration_trackers(a, b);
	if (diffs.length === 0) return;
	const label_a = labels.a ?? 'a';
	const label_b = labels.b ?? 'b';
	throw new Error(
		`Migration-identity parity failed: ${diffs.length} diff(s) between ${label_a} and ${
			label_b
		}\n${format_migration_tracker_diffs(diffs, labels)}`,
	);
};
