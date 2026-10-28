import '../assert_dev_env.ts';

/**
 * Postgres database helpers for cross-backend global setups — creating the
 * database a backend's URL names, emptying one a setup owns, and printing
 * such a URL safely.
 *
 * The harness never creates a database by itself: a setup opts in
 * (`create_cross_backend_global_setup`'s `ensure_databases`, or a call to
 * `ensure_database_for_url`), so a test role without `CREATEDB` is never
 * required by default.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';

import { create_db } from '../../db/create_db.ts';
import { pg_error_code } from '../../db/pg_error.ts';

/** The URL protocols a Postgres connection string carries. */
export const POSTGRES_URL_PROTOCOLS: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);

/**
 * Whether `url` parses as a `postgres:` / `postgresql:` URL. `URL.canParse`
 * alone admits a scheme-less `localhost:5432/db`, which it reads as protocol
 * `localhost:`.
 *
 * @param url - the candidate connection string
 */
export const is_postgres_url = (url: string): boolean =>
	URL.canParse(url) && POSTGRES_URL_PROTOCOLS.has(new URL(url).protocol);

/**
 * `database_url` with its database replaced by `database` — how a setup that
 * spawns a second backend lands on the same server under a database nothing
 * else uses.
 *
 * @param database_url - a `postgres://` URL on the target server
 * @param database - the database name to put in it
 * @returns the URL naming `database` on the same server
 */
export const with_database_name = (database_url: string, database: string): string => {
	const url = new URL(database_url);
	url.pathname = `/${database}`;
	return url.href;
};

/**
 * The URL `createdb` connects through to create a database on the server
 * `server_url` names — the same URL with its database replaced by `postgres`.
 *
 * @param server_url - a `postgres://` URL on the target server
 * @returns the URL of that server's `postgres` maintenance database
 */
export const to_maintenance_database_url = (server_url: string): string =>
	with_database_name(server_url, 'postgres');

/**
 * A database URL fit to print: the password, when there is one, replaced —
 * in the userinfo and in the `password` query parameter `pg` and libpq also
 * take. The whole URL rather than its host, which is empty for a socket URL
 * that names its server in the query string.
 *
 * @param database_url - a `postgres://` URL
 * @returns the URL with any password replaced by `REDACTED`
 */
export const redact_database_url = (database_url: string): string => {
	const url = new URL(database_url);
	if (url.password) url.password = 'REDACTED';
	if (url.searchParams.has('password')) url.searchParams.set('password', 'REDACTED');
	return url.href;
};

/**
 * Whether `createdb`'s stderr is its refusal of a database that already
 * exists — Postgres's `database "<name>" already exists`, which `createdb`
 * prints after `database creation failed: ERROR:`.
 *
 * @param stderr - what `createdb` wrote to stderr
 * @param database - the database it was asked to create
 */
export const is_createdb_already_exists = (stderr: string, database: string): boolean =>
	stderr.includes(`database "${database}" already exists`);

/** Dependencies of `ensure_database` — the warning a failed `createdb` is reported with. */
export interface EnsureDatabaseDeps {
	readonly warn: (message: string) => void;
}

const default_ensure_database_deps: EnsureDatabaseDeps = {
	warn: (message) => console.warn(message)
};

/**
 * Create a Postgres database when it is missing, with `createdb`.
 *
 * Which server it lands on depends on `server_url`. Given one, the database is
 * created on the server that URL names: `createdb` connects through the URL
 * with its database swapped for the `postgres` maintenance database, so host,
 * port, role and query parameters all come from the URL, and a password goes
 * to `createdb` in its environment, never its arguments. Without one,
 * `createdb` reads the libpq environment (`PGHOST` / `PGPORT` / `PGUSER`).
 *
 * Idempotent and never throws: a database that already exists is the quiet
 * success case (`is_createdb_already_exists`). Any other failure — no
 * `createdb` on PATH, no server, a role that may not create databases — is
 * reported through `deps.warn` with `createdb`'s own stderr, and whatever
 * connects next reports a database that is really missing.
 *
 * @param database - the database name
 * @param server_url - a `postgres://` URL on the server to create it on; its database name is ignored
 * @param deps - where a failure is reported, `console.warn` by default
 * @returns whether the database exists now (created, or already there)
 */
export const ensure_database = (
	database: string,
	server_url?: string,
	deps: EnsureDatabaseDeps = default_ensure_database_deps
): boolean => {
	const args = [database];
	const env = { ...process.env };
	if (server_url !== undefined) {
		const url = new URL(to_maintenance_database_url(server_url));
		// any local user can read the process list
		const password = url.searchParams.get('password') ?? decodeURIComponent(url.password);
		if (password) env.PGPASSWORD = password;
		url.password = '';
		url.searchParams.delete('password');
		args.unshift(`--maintenance-db=${url.href}`);
	}
	try {
		execFileSync('createdb', args, { stdio: ['ignore', 'ignore', 'pipe'], env, encoding: 'utf-8' });
		return true;
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stderr?: string };
		const stderr = (failure.stderr ?? '').trim();
		if (is_createdb_already_exists(stderr, database)) return true;
		deps.warn(
			`ensure_database: createdb ${database} failed — ` +
				(failure.code === 'ENOENT' ? 'createdb is not on PATH' : stderr || failure.message)
		);
		return false;
	}
};

/**
 * Create the database a Postgres URL names, on the server it names, when it
 * is missing (`ensure_database`). A URL that is not `postgres:` — `memory://`,
 * `file://` — or that names no database is left alone.
 *
 * @param database_url - the URL a backend connects to
 * @param deps - where a failure is reported, `console.warn` by default
 * @returns whether the URL named a Postgres database to ensure
 */
export const ensure_database_for_url = (
	database_url: string,
	deps?: EnsureDatabaseDeps
): boolean => {
	if (!is_postgres_url(database_url)) return false;
	const database = decodeURIComponent(new URL(database_url).pathname.slice(1));
	if (!database) return false;
	ensure_database(database, database_url, deps);
	return true;
};

/** Options for `empty_owned_database`. */
export interface EmptyOwnedDatabaseOptions {
	/**
	 * The one database name the call may empty — the setup's own. A URL naming
	 * any other database is refused before anything connects.
	 */
	readonly owned_name: string;
	/** Prefixes every error message, naming the setup (e.g. `'schema parity setup'`). */
	readonly label: string;
	/**
	 * Appended to the fix a connect failure suggests — another way to reach a
	 * usable server, such as the env var that points the setup elsewhere.
	 */
	readonly hint?: string;
}

/** A connection failure's text — a refused connection carries a `code` and an empty message. */
const describe_connect_error = (error: unknown): string =>
	(error instanceof Error && error.message) || pg_error_code(error) || String(error);

/**
 * Drop and recreate the `public` schema of a database a setup owns, so a
 * backend that does not wipe its own database migrates and bootstraps from
 * nothing on every run — bootstrap refuses a database that already holds an
 * account.
 *
 * The wipe takes everything, so it is tied to `owned_name`, the one database
 * the setup owns, rather than to whatever URL reaches it. Create the database
 * first (`ensure_database_for_url`); a missing one, a server that cannot be
 * reached and a role that cannot connect all fail with what to check.
 *
 * @param database_url - a `postgres://` URL naming the owned database
 * @param options - the owned name, the setup's label, and an optional hint
 * @throws Error when the URL names another database, or when the database
 * cannot be emptied (with what to check)
 */
export const empty_owned_database = async (
	database_url: string,
	options: EmptyOwnedDatabaseOptions
): Promise<void> => {
	const { owned_name, label, hint } = options;
	const database = decodeURIComponent(new URL(database_url).pathname.slice(1));
	if (database !== owned_name) {
		throw new Error(
			`${label}: refusing to empty database "${database}" — only "${owned_name}" is wiped`
		);
	}
	try {
		// inside the `try`, so a connect error thrown here gets the fix too
		const { db, close } = await create_db(database_url);
		try {
			// loaded here, not at module load: `../db.ts` pulls in `vitest`, which a
			// global setup that only ensures databases must not load
			const { reset_public_schema } = await import('../db.ts');
			await reset_public_schema(db);
		} finally {
			await close();
		}
	} catch (error) {
		// 3D000 invalid_catalog_name — the server answered, the database is missing
		const maintenance_url = redact_database_url(to_maintenance_database_url(database_url));
		const fix =
			pg_error_code(error) === '3D000'
				? `the database does not exist and \`createdb\` did not create it — run ` +
					`\`createdb --maintenance-db=${maintenance_url} ${owned_name}\` to see why ` +
					`(the URL's role needs to be allowed to create databases), or create it ` +
					`there as another role`
				: `check that Postgres is running there and that the URL's role can connect ` +
					`and owns the database` +
					(hint ? `, ${hint}` : '');
		throw new Error(
			`${label}: the Postgres database ${redact_database_url(database_url)} could not be ` +
				`emptied: ${describe_connect_error(error)}. To fix: ${fix}.`,
			{ cause: error }
		);
	}
};
