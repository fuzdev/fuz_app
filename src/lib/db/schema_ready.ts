/**
 * Readiness probe core: live-DB schema-drift detection.
 *
 * `/health` is a dumb liveness probe (no DB). `/ready` is the deploy gate — it
 * introspects the live database's column set and compares it against a
 * committed expected column map (what a fresh full migration-chain bootstrap
 * produces). A live DB missing an expected column is exactly the failure mode
 * that silently broke login when the auth schema gained `account.deleted_at`
 * via an in-place base-DDL edit instead of an appended migration: the deployed
 * code required a column an older bootstrapped DB never got, and a `SELECT *` +
 * JS `deleted_at === null` filter rejected every account. The `/ready` route
 * (`http/common_routes.ts`) turns that drift into a loud `503` so a deploy poll
 * rolls the release back instead of promoting code that can't authenticate
 * anyone. The discipline that prevents the drift is the frozen append-only
 * migration chain (`auth/migrations.ts`); this probe is the runtime net for a
 * lapse.
 *
 * The check is intentionally **column-presence only** — not type / constraint /
 * index parity. Column names are DDL-deterministic and engine-portable, so a
 * map generated against PGlite at gen-time compares exactly against a live
 * Postgres at runtime; finer-grained parity would false-positive across the two
 * engines, and a false positive here means a rolled-back deploy — an outage you
 * caused. Full structural parity stays the dev-time cross-backend
 * schema-snapshot suite's job (`testing/schema_introspect.ts`). In-place *type*
 * changes (a column kept by name, retyped) are out of scope — they rely on the
 * query-time column-named failures instead.
 *
 * This module is pure DB introspection + comparison: no HTTP, no filesystem, no
 * fixture-path knowledge. The route factory and the committed-fixture loader
 * live in `http/common_routes.ts`; the gen-time fixture-regeneration helper
 * lives in `testing/schema_ready_fixture.ts`.
 *
 * @module
 */

import type {Db} from './db.ts';

/** Expected schema: table name → sorted column names, from a fresh bootstrap. */
export type ExpectedSchema = Record<string, ReadonlyArray<string>>;

interface ColumnRow {
	table_name: string;
	column_name: string;
}

/**
 * Introspect every column in the `public` schema, grouped by relation. Shared
 * by the runtime `/ready` check and the fixture-generating helper so both
 * observe the exact same shape. `information_schema.columns` spans tables **and
 * views**; for the drift check that's harmless (a never-bootstrapped schema has
 * neither, and extra relations are ignored — see `check_schema_drift`).
 *
 * Unlike `query_schema_snapshot` (which excludes the `schema_version` migration
 * tracker as framework bookkeeping), this **keeps** `schema_version` — a
 * never-migrated DB then correctly fails readiness instead of passing on an
 * empty expectation.
 *
 * @returns relation name → sorted column names
 */
export const query_public_columns = async (db: Db): Promise<Record<string, Array<string>>> => {
	const rows = await db.query<ColumnRow>(
		`SELECT table_name, column_name FROM information_schema.columns
		 WHERE table_schema = 'public'
		 ORDER BY table_name, column_name`,
	);
	const by_table: Record<string, Array<string>> = {};
	for (const {table_name, column_name} of rows) {
		(by_table[table_name] ??= []).push(column_name);
	}
	return by_table;
};

/** Columns the live DB is missing for a table the expected schema declares. */
export interface MissingColumns {
	table: string;
	columns: Array<string>;
}

/** Outcome of a schema-drift check. */
export interface SchemaDriftResult {
	ok: boolean;
	/** Expected tables absent from the live DB. */
	missing_tables: Array<string>;
	/** Per-table columns the expected schema declares that the live DB lacks. */
	missing_columns: Array<MissingColumns>;
}

/**
 * Compare the live DB's columns against `expected`. Reports tables and columns
 * the running code expects that the live DB lacks — the drift that breaks
 * queries. Extra live tables / columns are ignored: forward-compatible, and a
 * newer-than-fixture DB shouldn't fail readiness.
 *
 * @param db - live database to introspect
 * @param expected - the committed column map a fresh bootstrap produces
 */
export const check_schema_drift = async (
	db: Db,
	expected: ExpectedSchema,
): Promise<SchemaDriftResult> => {
	const live = await query_public_columns(db);
	const missing_tables: Array<string> = [];
	const missing_columns: Array<MissingColumns> = [];
	for (const [table, columns] of Object.entries(expected)) {
		const live_columns = live[table];
		if (!live_columns) {
			missing_tables.push(table);
			continue;
		}
		const live_set = new Set(live_columns);
		const missing = columns.filter((column) => !live_set.has(column));
		if (missing.length > 0) missing_columns.push({table, columns: missing});
	}
	return {
		ok: missing_tables.length === 0 && missing_columns.length === 0,
		missing_tables,
		missing_columns,
	};
};

/** Render a drift result as a one-issue-per-line operator string. */
export const format_schema_drift = (drift: SchemaDriftResult): string => {
	const lines: Array<string> = [];
	for (const table of drift.missing_tables) lines.push(`  missing table: ${table}`);
	for (const {table, columns} of drift.missing_columns) {
		lines.push(`  ${table} missing columns: ${columns.join(', ')}`);
	}
	return lines.join('\n');
};

/** Error codes a readiness check returns at `503` (conforms to `{error: string}`). */
export const READY_ERROR = {
	schema_drift: 'schema_drift',
	db_unreachable: 'db_unreachable',
} as const;
