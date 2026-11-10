/**
 * The libpq side of a Postgres `DATABASE_URL`: the database it names, the
 * maintenance connection a client program like `createdb` or `dropdb` reaches
 * its server through, the environment that carries the URL's password, and the
 * argv those programs get. Pure functions, shared by the dev setup helpers
 * (`dev/setup.ts`) and the cross-backend test setup
 * (`testing/cross_backend/postgres_database.ts`).
 *
 * URL rewrites edit the raw query pairs, never `URLSearchParams`, which
 * reserializes every value form-encoded: a space becomes `+`, which libpq reads
 * as a literal plus (`options=-c%20search_path%3Dapp` would arrive broken).
 *
 * @module
 */

import { is_pg_database_url } from './create_db.ts';

/** A raw query pair's key, percent-decoded as libpq decodes it, or `null` for a malformed escape. */
const to_query_key = (pair: string): string | null => {
	try {
		return decodeURIComponent(pair.split('=', 1)[0]!);
	} catch {
		return null;
	}
};

/** The raw pairs of a URL's query (`url.search` without its `?`), empty pairs dropped. */
const to_query_pairs = (url: URL): Array<string> =>
	url.search
		.slice(1)
		.split('&')
		.filter((pair) => pair !== '');

/**
 * Rewrite a URL's query pair by pair, leaving every pair the rewrite keeps
 * byte for byte as it was.
 *
 * @param url - the URL to rewrite
 * @param rewrite - each raw pair and its decoded key to its replacement, or `null` to drop it
 * @mutates url - replaces its `search`
 */
export const rewrite_query_pairs = (
	url: URL,
	rewrite: (pair: string, key: string | null) => string | null
): void => {
	if (!url.search) return;
	const pairs: Array<string> = [];
	for (const pair of to_query_pairs(url)) {
		const next = rewrite(pair, to_query_key(pair));
		if (next !== null) pairs.push(next);
	}
	url.search = pairs.join('&');
};

/**
 * Extract the database name from a PostgreSQL URL, percent-decoded.
 *
 * @param url - a `DATABASE_URL`
 * @returns the database name, or `null` if the URL isn't a valid `postgres://` / `postgresql://` URL or names no database
 */
export const parse_db_name = (url: string): string | null => {
	if (!is_pg_database_url(url) || !URL.canParse(url)) return null;
	try {
		return decodeURIComponent(new URL(url).pathname.slice(1)) || null;
	} catch {
		return null; // a malformed percent-escape
	}
};

/**
 * The maintenance database a client program connects to in order to create or
 * drop `database`: `postgres`, or `template1` when `database` is `postgres`
 * itself — a database can't be dropped over a connection to it, and `dropdb`
 * falls back to `template1` the same way when given no maintenance database.
 *
 * @param database - the database being created or dropped
 */
export const to_maintenance_database_name = (database: string): string =>
	database === 'postgres' ? 'template1' : 'postgres';

/**
 * The URL a client program connects through to create or drop `database` on
 * the server `server_url` names: `server_url` with its database replaced by
 * the maintenance database (`to_maintenance_database_name`) and its password
 * removed, from the userinfo and the `password` query parameter, and any
 * fragment dropped. Host, port, role, and every other query parameter are kept
 * as written. The password reaches the program in its environment instead
 * (`to_postgres_password_env`), never its argv, which any local user can read
 * from the process list.
 *
 * @param server_url - a `postgres://` URL on the target server; its database name is ignored
 * @param database - the database being created or dropped
 * @returns the maintenance URL, with no password
 */
export const to_maintenance_database_url = (server_url: string, database: string): string => {
	const url = new URL(server_url);
	url.pathname = `/${to_maintenance_database_name(database)}`;
	url.password = '';
	// libpq reads a fragment as part of the database name
	url.hash = '';
	rewrite_query_pairs(url, (pair, key) => (key === 'password' ? null : pair));
	return url.href;
};

/**
 * The environment that hands a client program the password `database_url`
 * carries: `{PGPASSWORD}` when it has one, `{}` when it has none. libpq reads
 * `PGPASSWORD` as it reads a `password` connection parameter, ahead of
 * `~/.pgpass`. A `password` query parameter wins over the userinfo's, as in
 * libpq, which applies query parameters after the URI's components.
 *
 * @param database_url - a `postgres://` URL
 * @returns the environment to add, or `null` when the password has a malformed percent-escape
 */
export const to_postgres_password_env = (database_url: string): Record<string, string> | null => {
	const url = new URL(database_url);
	let raw: string | null = null;
	for (const pair of to_query_pairs(url)) {
		if (to_query_key(pair) !== 'password') continue;
		const eq = pair.indexOf('=');
		raw = eq === -1 ? '' : pair.slice(eq + 1);
	}
	raw ??= url.password;
	if (raw === '') return {};
	try {
		return { PGPASSWORD: decodeURIComponent(raw) };
	} catch {
		return null;
	}
};

/**
 * Whether `createdb`'s stderr is its refusal of a database that already
 * exists — Postgres's `database "<name>" already exists`, which `createdb`
 * prints after `database creation failed: ERROR:`. The text is the server's,
 * in its `lc_messages`, so only an English refusal is recognized.
 *
 * @param stderr - what `createdb` wrote to stderr
 * @param database - the database it was asked to create
 */
export const is_createdb_already_exists = (stderr: string, database: string): boolean =>
	stderr.includes(`database "${database}" already exists`);

/**
 * The argv for `createdb` to create `database`: never prompting
 * (`--no-password`), on the server `server_url` names when given (through
 * `--maintenance-db`, `to_maintenance_database_url`) or else the server the
 * libpq environment names, with `--` ahead of the name so a name beginning
 * with `-` stays an operand.
 *
 * @param database - the database to create
 * @param server_url - a `postgres://` URL on the target server
 */
export const to_createdb_args = (database: string, server_url?: string): Array<string> => [
	'--no-password',
	...(server_url === undefined
		? []
		: [`--maintenance-db=${to_maintenance_database_url(server_url, database)}`]),
	'--',
	database
];

/**
 * The argv for `dropdb` to drop `database` if it exists, on the server
 * `server_url` names, as `to_createdb_args` builds it.
 *
 * @param database - the database to drop
 * @param server_url - a `postgres://` URL on the target server
 */
export const to_dropdb_args = (database: string, server_url: string): Array<string> => [
	'--if-exists',
	'--no-password',
	`--maintenance-db=${to_maintenance_database_url(server_url, database)}`,
	'--',
	database
];
