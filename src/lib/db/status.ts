/**
 * Database status utility for CLI and dev workflows.
 *
 * Queries migration state and table info without a running server.
 * Returns structured data that consumer scripts can print however they like.
 *
 * The migration check is **name-divergence aware**: it name-prefix-verifies the
 * applied migrations against the code's list (mirroring `run_migrations`), so a
 * divergent history (same count, different names) reports a `divergence` and
 * renders `DIVERGED` rather than a false `up_to_date`.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { Db } from './db.ts';
import type { MigrationNamespace } from './migrate.ts';

/**
 * A divergence between the recorded migration tracker and the code's list.
 *
 * Either variant is a state the migration runner refuses to boot against — a
 * re-bootstrap (drop + migrate) is needed. Structured (not a pre-formatted
 * string) so programmatic consumers can branch on `kind`; `format_db_status`
 * renders the operator-facing line. The discriminated-union twin of the Rust
 * `fuz_db` `Divergence` enum.
 */
export type Divergence =
	| {
			/** An applied name doesn't match the code's name at `position`. */
			kind: 'name_mismatch';
			/** Sequence position of the first mismatch. */
			position: number;
			/** The name recorded in the tracker at `position`. */
			applied: string;
			/** The name the code declares at `position`. */
			expected: string;
	  }
	| {
			/** The tracker records more migrations than the code declares. */
			kind: 'binary_older';
			/** Count recorded in the tracker. */
			applied: number;
			/** Count the code declares. */
			declared: number;
	  };

/**
 * Migration status for a single namespace.
 */
export interface MigrationStatus {
	namespace: string;
	/** Names of migrations recorded in the tracker, sequence-ascending. */
	applied_names: Array<string>;
	/** Names of code migrations not yet applied (suffix of the code array). */
	pending_names: Array<string>;
	/**
	 * Whether `applied_names` is the full code array with no name divergence
	 * (no pending work, no diverged history).
	 */
	up_to_date: boolean;
	/**
	 * The first applied/code divergence, if any. Absent when the applied names
	 * are a clean prefix of the code's list (the only state the runner boots
	 * against). Present means a divergent bootstrap history — a re-bootstrap
	 * (drop + migrate) is needed.
	 */
	divergence?: Divergence;
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
	column_name: string
): Promise<boolean> => {
	const row = await db.query_one<{ exists: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = $1
			  AND column_name = $2
		) as exists`,
		[table_name, column_name]
	);
	return row?.exists ?? false;
};

const has_table = async (db: Db, table_name: string): Promise<boolean> => {
	const row = await db.query_one<{ exists: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		) as exists`,
		[table_name]
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
	namespaces?: Array<MigrationNamespace>
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
			migrations: []
		};
	}

	// list tables with row counts
	const table_rows = await db.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public'
		 ORDER BY table_name`
	);

	const tables: Array<TableStatus> = [];
	for (const { table_name } of table_rows) {
		// table_name from information_schema is trusted (no parameterized DDL)
		const result = await db.query_one<{ count: string }>(
			`SELECT COUNT(*) as count FROM "${table_name}"`
		);
		tables.push({
			name: table_name,
			row_count: result ? parseInt(result.count, 10) : 0
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
			for (const { namespace, migrations: ns_migrations } of namespaces) {
				const rows = await db.query<{ name: string }>(
					`SELECT name FROM schema_version
					 WHERE namespace = $1
					 ORDER BY sequence ASC`,
					[namespace]
				);
				const applied_names = rows.map((r) => r.name);
				const code_names = ns_migrations.map((m) => m.name);
				const total = code_names.length;
				const applied = applied_names.length;

				// Name-prefix verify, mirroring the migration runner: the applied
				// names must equal the first `applied` code names by position. A
				// divergent history (a renamed/reordered migration, same count or not)
				// is the exact state `run_migrations` refuses to boot against, so a
				// count-only check would report a DB the runner rejects as up-to-date.
				let divergence: Divergence | undefined;
				if (applied > total) {
					divergence = { kind: 'binary_older', applied, declared: total };
				} else {
					const position = applied_names.findIndex((name, i) => name !== code_names[i]);
					if (position !== -1) {
						divergence = {
							kind: 'name_mismatch',
							position,
							applied: applied_names[position]!,
							expected: code_names[position]!
						};
					}
				}

				// pending = the suffix of code names past the applied count (clamped:
				// a binary-older history has no pending tail)
				const pending_names = code_names.slice(Math.min(applied, total));
				migrations.push({
					namespace,
					applied_names,
					pending_names,
					up_to_date: applied === total && pending_names.length === 0 && divergence === undefined,
					...(divergence ? { divergence } : {})
				});
			}
		} else {
			// no tracker, or pre-0.42 shape — every namespace shows as "nothing applied yet"
			for (const { namespace, migrations: ns_migrations } of namespaces) {
				const code_names = ns_migrations.map((m) => m.name);
				migrations.push({
					namespace,
					applied_names: [],
					pending_names: code_names,
					up_to_date: code_names.length === 0
				});
			}
		}
	}

	return {
		connected: true,
		table_count: tables.length,
		tables,
		migrations,
		...(old_tracker_shape ? { old_tracker_shape: true } : {})
	};
};

/**
 * Render a `Divergence` as the operator-facing detail line. Twin of the Rust
 * `Divergence` `Display`.
 */
const format_divergence = (divergence: Divergence): string => {
	switch (divergence.kind) {
		case 'name_mismatch':
			return `position ${divergence.position}: database has '${divergence.applied}', code has '${divergence.expected}'`;
		case 'binary_older':
			return `database has ${divergence.applied} applied but code declares ${divergence.declared} (binary older than database)`;
	}
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
			'    Drop the table and re-run, or call `baseline()` first if preserving the schema.'
		);
	}

	if (status.migrations.length > 0) {
		lines.push('');
		lines.push('  Migrations:');
		for (const m of status.migrations) {
			const total = m.applied_names.length + m.pending_names.length;
			if (m.divergence) {
				lines.push(
					`    ${m.namespace}: DIVERGED (${m.applied_names.length}/${total}) — ${format_divergence(
						m.divergence
					)}`
				);
			} else if (m.up_to_date) {
				lines.push(`    ${m.namespace}: up to date (${m.applied_names.length}/${total})`);
			} else {
				const pending_list = m.pending_names.join(', ');
				lines.push(
					`    ${m.namespace}: applied ${m.applied_names.length}/${total} (pending: ${
						pending_list
					})`
				);
			}
		}
	}

	return lines.join('\n');
};
