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
}

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
 * Classify one namespace's tracker rows against the code's list — the pure
 * core of `query_db_status`.
 *
 * Name-prefix verifies `applied_names` (sequence-ascending, empty when the
 * tracker is absent), mirroring `run_migrations`: they must equal the first
 * `applied_names.length` code names by position. A divergent history (a
 * renamed/reordered migration, same count or not) is the exact state the runner
 * refuses to boot against, so a count-only check would report a database the
 * runner rejects as up to date. The pending list is the code suffix past the
 * applied count, clamped, so a binary-older history has no pending tail.
 *
 * @param ns - the namespace and its code-side migrations
 * @param applied_names - the tracker's names for `ns`, sequence-ascending
 * @returns the namespace's migration status
 */
const migration_status = (
	ns: MigrationNamespace,
	applied_names: Array<string>
): MigrationStatus => {
	const code_names = ns.migrations.map((m) => m.name);
	const declared = code_names.length;
	const applied = applied_names.length;

	let divergence: Divergence | undefined;
	if (applied > declared) {
		divergence = { kind: 'binary_older', applied, declared };
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

	return {
		namespace: ns.namespace,
		applied_names,
		pending_names: code_names.slice(Math.min(applied, declared)),
		up_to_date: applied === declared && divergence === undefined,
		...(divergence ? { divergence } : {})
	};
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
	if (namespaces?.length) {
		// no tracker (a never-migrated database) reads as nothing applied yet
		const sv_exists = await has_table(db, 'schema_version');
		for (const ns of namespaces) {
			let applied_names: Array<string> = [];
			if (sv_exists) {
				const rows = await db.query<{ name: string }>(
					`SELECT name FROM schema_version
					 WHERE namespace = $1
					 ORDER BY sequence ASC`,
					[ns.namespace]
				);
				applied_names = rows.map((r) => r.name);
			}
			migrations.push(migration_status(ns, applied_names));
		}
	}

	return {
		connected: true,
		table_count: tables.length,
		tables,
		migrations
	};
};

/**
 * Render a `Divergence` as the operator-facing detail line. Twin of the Rust
 * `Divergence` `Display`.
 */
const format_divergence = (divergence: Divergence): string => {
	switch (divergence.kind) {
		case 'name_mismatch':
			return `position ${divergence.position}: database has \`${divergence.applied}\`, code has \`${divergence.expected}\``;
		case 'binary_older':
			return `database has ${divergence.applied} applied but code declares ${divergence.declared} (binary older than database)`;
	}
};

/**
 * The code's declared migration count for a namespace — the report's
 * denominator. `applied + pending` everywhere but a binary-older history, where
 * the tracker holds more rows than the code declares and the pending tail is
 * empty; the declared count is then the one the divergence carries.
 */
const declared_count = (m: MigrationStatus): number =>
	m.divergence?.kind === 'binary_older'
		? m.divergence.declared
		: m.applied_names.length + m.pending_names.length;

/**
 * Format a `DbStatus` as the body of the human-facing operator report.
 *
 * A `tables:` count with one aligned `name  N rows` line per table, then a
 * `migrations:` header (always printed, even with no namespaces) and one
 * aligned line per namespace: its state (`up-to-date`, `PENDING <n>`, or
 * `DIVERGED`), `applied/declared`, and the latest applied name (`(none)` when
 * nothing is applied). A diverged namespace adds a `diverged:` line, a pending
 * one a `pending:` line naming the tail. A failed connection renders the single
 * line `connection: FAILED (<error>)`. Every line ends in a newline.
 *
 * The body only — the `database status` / `url:` header belongs to the CLI
 * script, which holds the URL a `DbStatus` never sees. For a connected status
 * the output is byte-identical with the Rust twin's `format_db_status`; both
 * test suites pin the same fixture report.
 *
 * @param status - the status to format
 * @returns multi-line string suitable for console output
 */
export const format_db_status = (status: DbStatus): string => {
	if (!status.connected) {
		return `  connection: FAILED${status.error ? ` (${status.error})` : ''}\n`;
	}

	const lines: Array<string> = [`  tables: ${status.table_count}`];

	const table_width = Math.max(0, ...status.tables.map((t) => t.name.length));
	for (const t of status.tables) {
		lines.push(`    ${t.name.padEnd(table_width)}  ${t.row_count} rows`);
	}

	lines.push('');
	lines.push('  migrations:');

	const ns_width = Math.max(0, ...status.migrations.map((m) => m.namespace.length));
	const detail_indent = `    ${''.padEnd(ns_width)}    `;
	for (const m of status.migrations) {
		const state = m.divergence
			? 'DIVERGED'
			: m.up_to_date
				? 'up-to-date'
				: `PENDING ${m.pending_names.length}`;
		const latest = m.applied_names.at(-1) ?? '(none)';
		lines.push(
			`    ${m.namespace.padEnd(ns_width)}  ${state.padEnd(12)} ${m.applied_names.length}/${declared_count(m)}  latest: ${latest}`
		);
		if (m.divergence) {
			lines.push(`${detail_indent}diverged: ${format_divergence(m.divergence)}`);
		} else if (m.pending_names.length > 0) {
			lines.push(`${detail_indent}pending: ${m.pending_names.join(', ')}`);
		}
	}

	return lines.join('\n') + '\n';
};

/** Printed in place of a database URL `display_db_url` won't render. */
const UNPARSEABLE_DB_URL = '(not a URL; hidden)';

/** The port node-postgres dials when the URL names none. */
const DEFAULT_PG_PORT = '5432';

const MALFORMED_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const HOSTNAME = /^[A-Za-z0-9._-]+$/;
const SOCKET_DIR = /^\/[A-Za-z0-9._/-]*$/;
const MISPARSED_USER = /[?=&/#]/;
const PORT = /^\d{1,5}$/;

/**
 * A host as `display_db_url` prints it, or `null` when it isn't an IP literal,
 * a hostname, or a socket directory. An IPv6 literal serializes through
 * `new URL`, which canonicalizes it.
 */
const display_host = (host: string): string | null => {
	if (SOCKET_DIR.test(host)) return host.replaceAll('/', '%2F');
	if (HOSTNAME.test(host)) return host;
	if (!host.includes(':')) return null;
	try {
		return new URL(`http://[${host}]`).hostname;
	} catch {
		return null;
	}
};

/**
 * Render a database URL for printing from the parse node-postgres dials —
 * `new URL`, with pg-connection-string's precedence, where a `user`, `host`, or
 * `port` query parameter overrides the URL's own — so the line names the server
 * dialed and no credential can leak however the input spells it.
 *
 * A `postgres://` or `postgresql://` URL renders as
 * `postgres://[user@]host:port[/dbname]`: never the password, and never the
 * query or fragment (`sslmode` and the like are dropped by design). The scheme
 * always prints as `postgres://`. The port always prints, `5432` when the URL
 * names none. The user and database name print percent-encoded with
 * `encodeURIComponent`, so no control character, escape sequence, or bidi
 * override reaches the terminal and an `@` can't pose as the separator; each
 * prints only when non-empty. An IP-literal host prints canonically (IPv6
 * bracketed); a Unix-socket directory prints with each `/` as `%2F`. A PGlite
 * `file://` or `memory://` URL prints as scheme, host, and path.
 *
 * The whole line is `(not a URL; hidden)` for any other scheme, when `new URL`
 * rejects the input, when it holds a malformed percent-escape (`%ZZ`), when
 * there is no host, when the host is neither an IP literal, a hostname of
 * `A-Z a-z 0-9 . _ -`, nor a socket directory of those characters and `/`, when
 * the user holds `?`, `=`, `&`, `/`, or `#`, or when the port isn't a number up
 * to 65535. The host and user rules match the Rust twin's, where they catch
 * tokio-postgres's split at the first `@`.
 *
 * Twin of the Rust `fuz_db` CLI's `display_db_url`, byte-identical on the URLs
 * both drivers read alike. They part where the drivers do: a `host=` or `port=`
 * query parameter overrides the URL's here (tokio-postgres appends it to a list
 * whose first entry the pool dials); a `dbname=` query parameter, which
 * tokio-postgres honours and node-postgres ignores, and a `#…` fragment, which
 * tokio-postgres keeps as part of the database name; tokio-postgres also
 * accepts `key=value` strings, host lists, and an unencoded `/` or `?` in the
 * password (here, the placeholder); an unencoded `@` in the userinfo splits at
 * the last `@` here, rendering the user and host node-postgres dials, where the
 * Rust twin prints the placeholder; node-postgres decodes the database name
 * with `decodeURI`, so a reserved-character escape such as `%2F` stays literal
 * and prints as `%252F`; an IPv4-mapped IPv6 address serializes differently;
 * and tokio-postgres refuses an unknown query parameter (`sslpassword=`) that
 * node-postgres passes.
 *
 * @param url - the database URL
 * @returns the URL without its password, query, or fragment, or the placeholder
 */
export const display_db_url = (url: string): string => {
	if (MALFORMED_ESCAPE.test(url)) return UNPARSEABLE_DB_URL;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === 'file:' || parsed.protocol === 'memory:') {
			return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		}
		if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
			return UNPARSEABLE_DB_URL;
		}
		const params = parsed.searchParams;
		const user = params.get('user') || decodeURIComponent(parsed.username);
		const param_host = params.get('host');
		const host = display_host(
			param_host || decodeURIComponent(parsed.hostname.replace(/^\[(.*)\]$/, '$1'))
		);
		const port = params.get('port') || parsed.port || DEFAULT_PG_PORT;
		// pg-connection-string moves an encoded socket host into the path when a
		// query `host=` replaces it
		const pathname =
			param_host && /^%2f/i.test(parsed.hostname)
				? parsed.hostname + parsed.pathname
				: parsed.pathname;
		const dbname = decodeURI(pathname.slice(1));
		if (host === null || MISPARSED_USER.test(user) || !PORT.test(port) || Number(port) > 65535) {
			return UNPARSEABLE_DB_URL;
		}
		let shown = 'postgres://';
		if (user) shown += `${encodeURIComponent(user)}@`;
		shown += `${host}:${port}`;
		if (dbname) shown += `/${encodeURIComponent(dbname)}`;
		return shown;
	} catch {
		// `new URL`, a decode, or an encode of a lone surrogate threw
		return UNPARSEABLE_DB_URL;
	}
};
