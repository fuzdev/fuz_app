/**
 * Database status utility for CLI and dev workflows.
 *
 * Queries migration state and table info without a running server.
 * Returns structured data that consumer scripts can print however they like.
 *
 * @module
 */

import {to_error_message} from '@fuzdev/fuz_util/error.ts';

import type {Db} from './db.ts';
import type {MigrationNamespace} from './migrate.ts';

/**
 * Migration status for a single namespace.
 */
export interface MigrationStatus {
	namespace: string;
	/** Names of migrations recorded in the tracker, sequence-ascending. */
	applied_names: Array<string>;
	/** Names of code migrations not yet applied (suffix of the code array). */
	pending_names: Array<string>;
	/** Whether `applied_names` is the full code array (no pending work). */
	up_to_date: boolean;
}

/**
 * Table info with row count.
 */
export interface TableStatus {
	name: string;
	row_count: number;
}

/**
 * Full database status snapshot.
 */
export interface DbStatus {
	/** Whether the database is reachable. */
	connected: boolean;
	/** Error message if connection failed. */
	error?: string;
	/** Number of public tables. */
	table_count: number;
	/** Per-table row counts. */
	tables: Array<TableStatus>;
	/** Per-namespace migration status. */
	migrations: Array<MigrationStatus>;
	/**
	 * True if the pre-0.42 `schema_version` shape (with a `version` column)
	 * was detected. The runner refuses to start in this state — operators
	 * see this flag as their cue to drop the table or call `baseline()`.
	 */
	old_tracker_shape?: boolean;
}

const has_table_column = async (
	db: Db,
	table_name: string,
	column_name: string,
): Promise<boolean> => {
	const row = await db.query_one<{exists: boolean}>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = $1
			  AND column_name = $2
		) as exists`,
		[table_name, column_name],
	);
	return row?.exists ?? false;
};

const has_table = async (db: Db, table_name: string): Promise<boolean> => {
	const row = await db.query_one<{exists: boolean}>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		) as exists`,
		[table_name],
	);
	return row?.exists ?? false;
};

/**
 * Query database status including connectivity, tables, and migration state.
 *
 * Designed for CLI `db:status` commands. Does not modify the database.
 *
 * @param db - the database instance
 * @param namespaces - migration namespaces to check status for
 * @returns a snapshot of database status; `connected: false` with `error`
 *   set when the initial connectivity probe fails
 * @throws Error propagated from the driver if a query fails after the
 *   connectivity probe (e.g. a table is dropped mid-scan)
 */
export const query_db_status = async (
	db: Db,
	namespaces?: Array<MigrationNamespace>,
): Promise<DbStatus> => {
	// check connectivity
	try {
		await db.query('SELECT 1');
	} catch (err) {
		return {
			connected: false,
			error: to_error_message(err),
			table_count: 0,
			tables: [],
			migrations: [],
		};
	}

	// list tables with row counts
	const table_rows = await db.query<{table_name: string}>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public'
		 ORDER BY table_name`,
	);

	const tables: Array<TableStatus> = [];
	for (const {table_name} of table_rows) {
		// table_name from information_schema is trusted (no parameterized DDL)
		const result = await db.query_one<{count: string}>(
			`SELECT COUNT(*) as count FROM "${table_name}"`,
		);
		tables.push({
			name: table_name,
			row_count: result ? parseInt(result.count, 10) : 0,
		});
	}

	// check migration state
	const migrations: Array<MigrationStatus> = [];
	let old_tracker_shape: boolean | undefined;
	if (namespaces?.length) {
		const sv_exists = await has_table(db, 'schema_version');
		// pre-0.42 shape carries a `version` column; new shape carries `name`
		const old_shape = sv_exists ? await has_table_column(db, 'schema_version', 'version') : false;
		if (old_shape) old_tracker_shape = true;

		if (sv_exists && !old_shape) {
			for (const {namespace, migrations: ns_migrations} of namespaces) {
				const rows = await db.query<{name: string}>(
					`SELECT name FROM schema_version
					 WHERE namespace = $1
					 ORDER BY sequence ASC`,
					[namespace],
				);
				const applied_names = rows.map((r) => r.name);
				const code_names = ns_migrations.map((m) => m.name);
				// pending = the suffix of code names beyond applied.length (callers
				// see the boot algorithm's tail without paying for verify here)
				const pending_names = code_names.slice(applied_names.length);
				migrations.push({
					namespace,
					applied_names,
					pending_names,
					up_to_date: applied_names.length === code_names.length && pending_names.length === 0,
				});
			}
		} else {
			// no tracker, or pre-0.42 shape — every namespace shows as "nothing applied yet"
			for (const {namespace, migrations: ns_migrations} of namespaces) {
				const code_names = ns_migrations.map((m) => m.name);
				migrations.push({
					namespace,
					applied_names: [],
					pending_names: code_names,
					up_to_date: code_names.length === 0,
				});
			}
		}
	}

	return {
		connected: true,
		table_count: tables.length,
		tables,
		migrations,
		...(old_tracker_shape ? {old_tracker_shape: true} : {}),
	};
};

/**
 * Format a `DbStatus` as a human-readable string for CLI output.
 *
 * @param status - the status to format
 * @returns multi-line string suitable for console output
 */
export const format_db_status = (status: DbStatus): string => {
	const lines: Array<string> = [];

	if (!status.connected) {
		lines.push(`  Connection: FAILED${status.error ? ` (${status.error})` : ''}`);
		return lines.join('\n');
	}

	lines.push(`  Connection: OK`);
	lines.push(`  Tables: ${status.table_count}`);

	if (status.tables.length > 0) {
		lines.push('');
		const max_name = Math.max(...status.tables.map((t) => t.name.length));
		for (const t of status.tables) {
			lines.push(`    ${t.name.padEnd(max_name)}  ${t.row_count} rows`);
		}
	}

	if (status.old_tracker_shape) {
		lines.push('');
		lines.push('  Migrations: pre-0.42 schema_version shape detected.');
		lines.push(
			'    Drop the table and re-run, or call `baseline()` first if preserving the schema.',
		);
	}

	if (status.migrations.length > 0) {
		lines.push('');
		lines.push('  Migrations:');
		for (const m of status.migrations) {
			const total = m.applied_names.length + m.pending_names.length;
			if (m.up_to_date) {
				lines.push(`    ${m.namespace}: up to date (${m.applied_names.length}/${total})`);
			} else {
				const pending_list = m.pending_names.join(', ');
				lines.push(
					`    ${m.namespace}: applied ${m.applied_names.length}/${total} (pending: ${pending_list})`,
				);
			}
		}
	}

	return lines.join('\n');
};
