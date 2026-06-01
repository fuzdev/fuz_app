import './assert_dev_env.js';

/**
 * PostgreSQL schema introspection — produces a normalized, JSON-serializable
 * snapshot of a database's structure for cross-impl parity checks.
 *
 * The snapshot covers:
 *
 * - Tables with columns (data type, nullability, default, identity)
 * - Indexes with canonical Postgres-rendered definitions
 * - Constraints (CHECK, FOREIGN KEY, PRIMARY KEY, UNIQUE, EXCLUSION)
 * - Sequences with data type — distinguishes `int4` (SERIAL) from `int8`
 *   (BIGSERIAL)
 *
 * Designed for `pg_catalog` introspection — works against both PostgreSQL
 * and PGlite. The snapshot is fully deterministic: every collection sorts by
 * a stable key and excludes time-varying fields like `applied_at`.
 *
 * Paired with `testing/schema_parity.ts` for comparison + assertion helpers.
 *
 * @module
 */

import {z} from 'zod';

import type {Db} from '../db/db.js';

/**
 * Per-column structural metadata. The Zod schema is the canonical source
 * for the column shape — `SchemaSnapshot` reuses it as the cross-impl
 * `_testing_schema_snapshot` RPC action's wire validator, so the
 * introspection type and the wire contract can't drift apart.
 */
export const ColumnSnapshot = z.object({
	/** SQL standard type name from `information_schema.columns.data_type`. */
	data_type: z.string(),
	/** Postgres-native type name from `information_schema.columns.udt_name`. */
	udt_name: z.string(),
	/** `true` when the column accepts NULL. */
	is_nullable: z.boolean(),
	/** Default-value expression as Postgres reports it, or `null` if none. */
	column_default: z.string().nullable(),
	/** `true` when the column was declared GENERATED ... AS IDENTITY. */
	is_identity: z.boolean(),
});
export type ColumnSnapshot = z.infer<typeof ColumnSnapshot>;

/** Per-table structural metadata. */
export const TableSnapshot = z.object({
	/** Column metadata keyed by column name (sorted on serialization). */
	columns: z.record(z.string(), ColumnSnapshot),
	/** Index definitions as Postgres renders them via `pg_indexes.indexdef`. */
	indexes: z.array(z.object({name: z.string(), definition: z.string()})),
	/** Constraint definitions as Postgres renders them via `pg_get_constraintdef`. */
	constraints: z.array(z.object({name: z.string(), type: z.string(), definition: z.string()})),
});
export type TableSnapshot = z.infer<typeof TableSnapshot>;

/** Sequence metadata — `data_type` is `bigint` (BIGSERIAL) or `integer` (SERIAL). */
export const SequenceSnapshot = z.object({
	data_type: z.string(),
});
export type SequenceSnapshot = z.infer<typeof SequenceSnapshot>;

/**
 * Normalized database schema snapshot for parity comparison — the single
 * source of truth for the snapshot shape across the introspection query
 * (`query_schema_snapshot`), the diff comparator (`testing/schema_parity.ts`), and
 * the cross-impl RPC action's wire validator (`testing/cross_backend/testing_reset_actions.ts`).
 *
 * All fields are deterministically ordered on capture so structural equality
 * via `JSON.stringify` or per-key comparison yields stable results.
 */
export const SchemaSnapshot = z.object({
	/** Tables keyed by name. */
	tables: z.record(z.string(), TableSnapshot),
	/** Sequences keyed by name. */
	sequences: z.record(z.string(), SequenceSnapshot),
});
export type SchemaSnapshot = z.infer<typeof SchemaSnapshot>;

/** Filter options for `query_schema_snapshot`. */
export interface QuerySchemaSnapshotOptions {
	/**
	 * Schema name to introspect — defaults to `'public'`. Single-schema only;
	 * cross-schema introspection isn't a current need.
	 */
	readonly schema?: string;
	/**
	 * Tables to exclude from the snapshot. The `schema_version` migration
	 * tracker is always excluded — it's framework bookkeeping created by the
	 * migration runner, identical across impls, and not part of any
	 * consumer's domain schema.
	 */
	readonly exclude_tables?: ReadonlyArray<string>;
}

interface ColumnRow {
	table_name: string;
	column_name: string;
	data_type: string;
	udt_name: string;
	is_nullable: string;
	column_default: string | null;
	is_identity: string;
}

interface IndexRow {
	tablename: string;
	indexname: string;
	indexdef: string;
}

interface ConstraintRow {
	table_name: string;
	conname: string;
	contype: string;
	definition: string;
}

interface SequenceRow {
	sequence_name: string;
	data_type: string;
}

const sort_keys = <T>(record: Record<string, T>): Record<string, T> => {
	const sorted: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) {
		sorted[key] = record[key]!;
	}
	return sorted;
};

const contype_to_kind = (contype: string): string => {
	switch (contype) {
		case 'p':
			return 'PRIMARY KEY';
		case 'f':
			return 'FOREIGN KEY';
		case 'u':
			return 'UNIQUE';
		case 'c':
			return 'CHECK';
		case 'x':
			return 'EXCLUSION';
		case 't':
			return 'TRIGGER';
		default:
			return contype;
	}
};

/**
 * Introspect a live database into a deterministic `SchemaSnapshot`.
 *
 * Reads `information_schema` and `pg_catalog` to capture tables, columns,
 * indexes, constraints, and sequences.
 *
 * The `schema_version` migration tracker never appears in the `tables`
 * field — it's framework bookkeeping created by the migration runner,
 * identical across consumers, and would only add noise.
 */
export const query_schema_snapshot = async (
	db: Db,
	options: QuerySchemaSnapshotOptions = {},
): Promise<SchemaSnapshot> => {
	const schema = options.schema ?? 'public';
	const exclude_tables = new Set(options.exclude_tables ?? []);
	exclude_tables.add('schema_version');

	// All tables in the target schema, minus the excludes.
	const table_rows = await db.query<{table_name: string}>(
		`SELECT table_name
		 FROM information_schema.tables
		 WHERE table_schema = $1 AND table_type = 'BASE TABLE'
		 ORDER BY table_name ASC`,
		[schema],
	);
	const table_names = table_rows.map((r) => r.table_name).filter((n) => !exclude_tables.has(n));

	// Columns — batched in one query, grouped client-side. udt_name
	// distinguishes int4 from int8 (SERIAL vs BIGSERIAL).
	const column_rows = await db.query<ColumnRow>(
		`SELECT table_name, column_name, data_type, udt_name, is_nullable,
		        column_default, is_identity
		 FROM information_schema.columns
		 WHERE table_schema = $1
		 ORDER BY table_name ASC, ordinal_position ASC`,
		[schema],
	);

	// Indexes — pg_indexes.indexdef gives the canonical CREATE INDEX statement
	// as Postgres would re-emit it, which normalizes whitespace and case.
	const index_rows = await db.query<IndexRow>(
		`SELECT tablename, indexname, indexdef
		 FROM pg_indexes
		 WHERE schemaname = $1
		 ORDER BY tablename ASC, indexname ASC`,
		[schema],
	);

	// Constraints — pg_get_constraintdef produces a canonical text rendering.
	// Skip NOT NULL constraints (`contype = 'n'`): PG17+ catalogs them as
	// named `pg_constraint` rows while PGlite / older PG don't, and
	// nullability is already captured per-column by `is_nullable` — including
	// them would report a pure engine-cataloging artifact as cross-backend
	// drift between a PGlite and a real-Postgres backend.
	const constraint_rows = await db.query<ConstraintRow>(
		`SELECT c.conrelid::regclass::text AS table_name,
		        c.conname,
		        c.contype::text,
		        pg_get_constraintdef(c.oid) AS definition
		 FROM pg_constraint c
		 JOIN pg_namespace n ON n.oid = c.connamespace
		 WHERE n.nspname = $1
		   AND c.conrelid != 0
		   AND c.contype != 'n'
		 ORDER BY table_name ASC, conname ASC`,
		[schema],
	);

	// Sequences — data_type distinguishes bigint (BIGSERIAL) from integer (SERIAL).
	const sequence_rows = await db.query<SequenceRow>(
		`SELECT sequence_name, data_type
		 FROM information_schema.sequences
		 WHERE sequence_schema = $1
		 ORDER BY sequence_name ASC`,
		[schema],
	);

	const tables: Record<string, TableSnapshot> = {};
	for (const name of table_names) {
		const columns: Record<string, ColumnSnapshot> = {};
		for (const row of column_rows) {
			if (row.table_name !== name) continue;
			columns[row.column_name] = {
				data_type: row.data_type,
				udt_name: row.udt_name,
				is_nullable: row.is_nullable === 'YES',
				column_default: row.column_default,
				is_identity: row.is_identity === 'YES',
			};
		}
		const indexes = index_rows
			.filter((r) => r.tablename === name)
			.map((r) => ({name: r.indexname, definition: r.indexdef}));
		const constraints = constraint_rows
			// `conrelid::regclass::text` returns either bare (`foo`) or schema-
			// qualified (`public.foo`) depending on the connection's search_path,
			// so accept both forms here.
			.filter((r) => r.table_name === name || r.table_name === `${schema}.${name}`)
			.map((r) => ({
				name: r.conname,
				type: contype_to_kind(r.contype),
				definition: r.definition,
			}));
		tables[name] = {columns: sort_keys(columns), indexes, constraints};
	}

	const sequences: Record<string, SequenceSnapshot> = {};
	for (const row of sequence_rows) {
		sequences[row.sequence_name] = {data_type: row.data_type};
	}

	return {
		tables: sort_keys(tables),
		sequences: sort_keys(sequences),
	};
};
