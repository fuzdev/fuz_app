/**
 * Database status utility for CLI and dev workflows.
 *
 * Queries migration state and table info without a running server.
 * Returns structured data that consumer scripts can print however they like.
 *
 * @module
 */

import type {Db} from './db.js';
import type {MigrationNamespace} from './migrate.js';

/**
 * Migration status for a single namespace.
 */
export interface MigrationStatus {
	namespace: string;
	/** Current applied version (0 if never migrated). */
	current_version: number;
	/** Total available migrations in the namespace. */
	available_version: number;
	/** Whether the schema is up to date. */
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
}

/**
 * Query database status including connectivity, tables, and migration versions.
 *
 * Designed for CLI `db:status` commands. Does not modify the database.
 *
 * @param db - the database instance
 * @param namespaces - migration namespaces to check versions for
 * @returns a snapshot of database status
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
			error: err instanceof Error ? err.message : String(err),
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
		// table_name from information_schema is trusted
		// eslint-disable-next-line no-await-in-loop
		const result = await db.query_one<{count: string}>(
			`SELECT COUNT(*) as count FROM "${table_name}"`,
		);
		tables.push({
			name: table_name,
			row_count: result ? parseInt(result.count, 10) : 0,
		});
	}

	// check migration versions
	const migrations: Array<MigrationStatus> = [];
	if (namespaces?.length) {
		// check if schema_version table exists
		const sv_exists = await db.query_one<{exists: boolean}>(
			`SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = 'public' AND table_name = 'schema_version'
			) as exists`,
		);

		if (sv_exists?.exists) {
			for (const {namespace, migrations: ns_migrations} of namespaces) {
				// eslint-disable-next-line no-await-in-loop
				const row = await db.query_one<{version: number}>(
					'SELECT version FROM schema_version WHERE namespace = $1',
					[namespace],
				);
				const current_version = row?.version ?? 0;
				migrations.push({
					namespace,
					current_version,
					available_version: ns_migrations.length,
					up_to_date: current_version === ns_migrations.length,
				});
			}
		} else {
			// no schema_version table — all namespaces are at version 0
			for (const {namespace, migrations: ns_migrations} of namespaces) {
				migrations.push({
					namespace,
					current_version: 0,
					available_version: ns_migrations.length,
					up_to_date: ns_migrations.length === 0,
				});
			}
		}
	}

	return {
		connected: true,
		table_count: tables.length,
		tables,
		migrations,
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

	if (status.migrations.length > 0) {
		lines.push('');
		lines.push('  Migrations:');
		for (const m of status.migrations) {
			const marker = m.up_to_date ? 'up to date' : `${m.current_version}/${m.available_version}`;
			lines.push(`    ${m.namespace}: v${m.current_version} (${marker})`);
		}
	}

	return lines.join('\n');
};
