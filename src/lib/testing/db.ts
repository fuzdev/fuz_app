import './assert_dev_env.ts';

/**
 * Test database fixtures for parameterized testing.
 *
 * Provides factory builders for creating test databases with pglet-wasm (the
 * in-memory default), PGlite (in-memory) and pg (PostgreSQL) drivers. Consumer
 * projects provide their own schema initialization via `run_migrations` and
 * compose factories into test suites with `create_describe_db`
 * (`testing/describe_db.ts`). Vitest-free, so the spawned spine binary's
 * import graph (through `testing/app_server.ts`) can reach it.
 *
 * @example
 * ```ts
 * import {
 *   create_default_db_factory,
 *   create_pg_factory,
 *   FUZ_TEST_POSTGRES_URL_ENV
 * } from '@fuzdev/fuz_app/testing/db.ts';
 * import {run_migrations} from '@fuzdev/fuz_app/db/migrate.ts';
 * import {AUTH_MIGRATION_NS} from '@fuzdev/fuz_app/auth/migrations.ts';
 *
 * const init_schema = async (db) => {
 *   await run_migrations(db, [AUTH_MIGRATION_NS]);
 * };
 * const default_factory = create_default_db_factory(init_schema);
 * const pg_factory = create_pg_factory(init_schema, process.env[FUZ_TEST_POSTGRES_URL_ENV], {
 *   suite: 'my_app'
 * });
 * export const db_factories = [default_factory, pg_factory];
 * ```
 *
 * @module
 */

import { threadId } from 'node:worker_threads';
import type { PgletDb } from '@fuzdev/pglet-wasm';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { Db } from '../db/db.ts';
import { create_pglite_db } from '../db/db_pglite.ts';
import { create_pglet_db_driver, create_pglet_instance } from '../db/db_pglet.ts';
import {
	create_pg_db,
	create_pg_pool,
	DEFAULT_DB_CHECKOUT_TIMEOUT_MS,
	register_pg_type_parsers,
	type DbCheckoutPool
} from '../db/db_pg.ts';
import { pg_error_code } from '../db/pg_error.ts';
import { redact_database_url, with_database_name } from '../db/postgres_url.ts';

/**
 * Factory interface for creating test database instances.
 */
export interface DbFactory {
	name: string;
	create: () => Promise<Db>;
	close: (db: Db) => Promise<void>;
	skip: boolean;
	skip_reason?: string;
}

/**
 * Reset a test database to a clean slate by dropping and recreating the `public` schema.
 *
 * `DROP SCHEMA public CASCADE; CREATE SCHEMA public` in plain SQL, so it resets
 * every driver: `create_pglite_factory` calls it on each `create()`, where one
 * instance serves every suite. (`create_pglet_wasm_factory` and
 * `create_pg_factory` need none: each `create()` hands out a fork or a new
 * database.) Drift-proof — it wipes every table, type, and sequence regardless of
 * namespace, so it needs no upkeep when the schema gains a table. The database
 * instance remains usable after reset.
 *
 * @mutates db - drops the `public` schema and recreates it; all rows in all
 *   tables are gone after this returns.
 */
export const reset_public_schema = async (db: Db): Promise<void> => {
	await db.query('DROP SCHEMA public CASCADE');
	await db.query('CREATE SCHEMA public');
};

/**
 * Builds a `DbFactory` from a schema initializer — the shape of every factory builder here.
 */
export type DbFactoryBuilder = (init_schema: (db: Db) => Promise<void>) => DbFactory;

// The module-level PGlite instance the PGlite factories share, created on first use.
let pglite_db: Promise<Db> | null = null;

const resolve_pglite_db = (): Promise<Db> =>
	(pglite_db ??= (async () => {
		const { PGlite } = await import('@electric-sql/pglite');
		return create_pglite_db(new PGlite()).db;
	})());

/**
 * Create a PGlite (in-memory) database factory for tests.
 *
 * Always enabled — needs the optional `@electric-sql/pglite` peer installed.
 * Shares one module-level PGlite WASM instance across the PGlite factories this
 * module builds: the first `create()` creates it, and each `create()` resets its
 * `public` schema (`reset_public_schema`) and runs `init_schema`, so only the
 * first pays the WASM cold start. Every `create()` returns that one instance, so
 * a `create()` resets the database an earlier one returned; `close()` is a no-op.
 *
 * The instance lives as long as this module stays loaded — under the `db`
 * project's `isolate: false` + `fileParallelism: false` that is the whole run;
 * a project that isolates its files gets one per worker. A promise rather than
 * a value, so two concurrent first `create()` calls build one instance, and a
 * failed first load is the error every later `create()` reports.
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_pglite_factory: DbFactoryBuilder = (init_schema) => ({
	name: 'pglite',
	skip: false,
	async create() {
		const db = await resolve_pglite_db();
		// the instance is shared with every PGlite factory, so it may hold any schema
		await reset_public_schema(db);
		await init_schema(db);
		return db;
	},
	async close() {
		// No-op: the instance is module-level, so it lives as long as this module
		// stays loaded. Nothing frees it earlier.
	}
});

/**
 * The migrated pglet bases, one per `init_schema` function, shared by every
 * pglet-wasm factory built with it. Weakly keyed, so a base lives as long as
 * its `init_schema` is reachable (a module-level initializer: the whole run)
 * and is freed with it; nothing closes a base explicitly.
 */
const pglet_wasm_bases: WeakMap<(db: Db) => Promise<void>, Promise<PgletDb>> = new WeakMap();

/**
 * Resolve the migrated base for `init_schema`, creating it and running
 * `init_schema` on it on first use. A promise rather than a value, so two
 * concurrent first `create()` calls migrate one base, and a failed
 * `init_schema` is the error every later `create()` with it reports.
 *
 * The base's `Db` never leaves this function, so nothing but `init_schema`
 * runs on it, and the promise settles only once `init_schema` has — no
 * transaction of the base's is open when a fork is taken. One `init_schema`
 * leaves open (a raw `BEGIN` with no `COMMIT`) makes `fork()` reject `25001`.
 */
const resolve_pglet_wasm_base = (init_schema: (db: Db) => Promise<void>): Promise<PgletDb> => {
	let base = pglet_wasm_bases.get(init_schema);
	if (!base) {
		base = (async () => {
			const pglet = await create_pglet_instance();
			try {
				await init_schema(create_pglet_db_driver(pglet).db);
			} catch (error) {
				// a half-migrated base is never forked; free it, and report the init's error
				await pglet.close().catch(() => {});
				throw error;
			}
			return pglet;
		})();
		pglet_wasm_bases.set(init_schema, base);
	}
	return base;
};

/**
 * Create a pglet-wasm (in-memory) database factory for tests.
 *
 * Always enabled — needs the optional `@fuzdev/pglet-wasm` peer installed.
 * Migrates once per `init_schema`: the first `create()` creates a pglet
 * instance (with fuz_app's value coercion, `PGLET_COERCION`) and runs
 * `init_schema` on it, and that migrated base is shared by every pglet-wasm
 * factory built with the same `init_schema` function. Each `create()` returns a
 * `fork()` of the base — a copy-on-write branch that shares the base's pages
 * until written — so every database it returns is isolated from the base and
 * from every other, and a `create()` never re-runs `init_schema`.
 *
 * `close(db)` closes that fork; a fork is resident until then, so close every
 * database this returns (`create_describe_db` does). Closing one twice is a
 * no-op; closing a database this factory did not create throws. The base is never closed: it lives
 * as long as `init_schema` is reachable.
 *
 * @param init_schema - callback to initialize the database schema, run once per function on the base
 */
export const create_pglet_wasm_factory: DbFactoryBuilder = (init_schema) => {
	// each live fork's close, keyed by the `Db` handed out
	const fork_closers: WeakMap<Db, () => Promise<void>> = new WeakMap();
	// the forks already closed, so a second close is a no-op and not a foreign `Db`
	const closed_forks: WeakSet<Db> = new WeakSet();
	return {
		name: 'pglet-wasm',
		skip: false,
		async create() {
			const base = await resolve_pglet_wasm_base(init_schema);
			const { db, close } = create_pglet_db_driver(await base.fork());
			fork_closers.set(db, close);
			return db;
		},
		async close(db) {
			if (closed_forks.has(db)) return;
			const close = fork_closers.get(db);
			if (!close) {
				throw new Error(
					'create_pglet_wasm_factory: close() got a database this factory did not create'
				);
			}
			fork_closers.delete(db);
			closed_forks.add(db);
			await close();
		}
	};
};

// The builder `create_default_db_factory` uses, `null` for pglet-wasm.
let default_db_factory_builder: DbFactoryBuilder | null = null;

/**
 * Install the builder `create_default_db_factory` uses, so suites written
 * against the default run against another driver without being edited —
 * `create_pglite_factory` to run them on PGlite. Pass `null` to restore
 * pglet-wasm.
 *
 * The slot is read when a factory is built, not when it creates a database,
 * so install before the first `create_default_db_factory` call — a vitest
 * `setupFiles` entry, which runs ahead of every test file's imports, is the
 * shape fuz_app's own `db` project uses. A factory built earlier (including
 * the module-level fallback in `testing/app_server.ts`) keeps the driver it
 * was built with, and uninstalling does not revert it.
 *
 * @param create_factory - the builder to install, or `null` to restore the default
 * @returns the builder this replaced (`null` for pglet-wasm), so a caller can put it back
 */
export const set_default_db_factory = (
	create_factory: DbFactoryBuilder | null
): DbFactoryBuilder | null => {
	const previous = default_db_factory_builder;
	default_db_factory_builder = create_factory;
	return previous;
};

/**
 * Create the default in-memory database factory for tests: pglet-wasm, or the
 * builder `set_default_db_factory` installed.
 *
 * The factory fuz_app's own test helpers fall back to when a suite passes none
 * (`create_test_app_server`, `describe_rate_limiting_tests`,
 * `describe_sse_route_tests`). Call `create_pglite_factory` or
 * `create_pglet_wasm_factory` directly to pin a driver.
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_default_db_factory: DbFactoryBuilder = (init_schema) =>
	(default_db_factory_builder ?? create_pglet_wasm_factory)(init_schema);

/**
 * The env var naming the PostgreSQL server the tests may create databases on
 * — a URL whose role has `CREATEDB`, e.g. `postgres://localhost/postgres`. The
 * variable the Rust spine's `fuz_testing` reads, so one setting turns on the
 * PostgreSQL leg of both. Unset, the PostgreSQL leg is skipped (or, for a
 * PostgreSQL-only project, fails naming the variable).
 */
export const FUZ_TEST_POSTGRES_URL_ENV = 'FUZ_TEST_POSTGRES_URL';

/**
 * What every database the test harness creates on PostgreSQL begins with — the
 * Rust spine's prefix too, so one prefix finds what a killed run of either left
 * behind.
 */
export const TEST_DATABASE_PREFIX = 'fuz_testing_';

/**
 * The longest suite name `create_pg_factory` takes: PostgreSQL truncates a
 * name past 63 bytes, and `fuz_testing_`, `_<pid>`, `_<thread id>` and `_<n>`
 * take the rest. The Rust spine's `SUITE_NAME_LENGTH_MAX`.
 */
const TEST_SUITE_NAME_LENGTH_MAX = 24;

/** Lowercase ASCII, digits and `_`, starting with a letter — a name PostgreSQL keeps as written. */
const TEST_DATABASE_NAME_PART = /^[a-z][a-z0-9_]*$/;

/**
 * Refuse a name part that wouldn't make a database name PostgreSQL keeps as
 * written, unquoted: anything but lowercase ASCII, digits and `_` starting
 * with a letter, or longer than `max_length`. The Rust spine's rule for its
 * suite names.
 *
 * @param kind - what the name is, for the message (`'test suite name'`)
 * @param name - the name part
 * @param max_length - its longest allowed length, in bytes
 * @throws Error when the name breaks the rule
 */
export const assert_test_database_name_part = (
	kind: string,
	name: string,
	max_length: number
): void => {
	if (!TEST_DATABASE_NAME_PART.test(name) || name.length > max_length) {
		throw new Error(
			`${kind} ${JSON.stringify(name)} must be lowercase ASCII, digits, and \`_\`, start with ` +
				`a letter, and be at most ${max_length} bytes`
		);
	}
};

/** How many times a refused `DROP DATABASE` is retried, and how long apart (ms) — the Rust spine's. */
const DROP_RETRIES = 50;
const DROP_RETRY_DELAY_MS = 100;

/**
 * Run one statement over an admin connection to the server `postgres_url`
 * names, opened and closed for it.
 */
const run_admin_statement = async (postgres_url: string, sql: string): Promise<void> => {
	const { default: pg } = await import('pg');
	const client = new pg.Client({ connectionString: postgres_url });
	try {
		await client.connect();
	} catch (error) {
		throw new Error(
			`connect through ${FUZ_TEST_POSTGRES_URL_ENV} (${redact_database_url(postgres_url)}): ` +
				to_error_message(error),
			{ cause: error }
		);
	}
	try {
		await client.query(sql);
	} finally {
		await client.end();
	}
};

/**
 * Create the database `name` on the server `postgres_url` names, from
 * `template0`, so it holds nothing a template added.
 *
 * @param postgres_url - the server, through a role with `CREATEDB` (`FUZ_TEST_POSTGRES_URL`)
 * @param name - the database to create, a name `assert_test_database_name_part` admits
 * @throws Error naming the variable when the server can't be reached, and
 *   saying the role needs `CREATEDB` when it may not create databases
 */
export const create_test_postgres_database = async (
	postgres_url: string,
	name: string
): Promise<void> => {
	try {
		await run_admin_statement(postgres_url, `CREATE DATABASE ${name} TEMPLATE template0`);
	} catch (error) {
		// 42501 insufficient_privilege
		if (pg_error_code(error) === '42501') {
			throw new Error(
				`create ${name} through ${FUZ_TEST_POSTGRES_URL_ENV}: the role needs CREATEDB ` +
					`(${to_error_message(error)})`,
				{ cause: error }
			);
		}
		throw error;
	}
};

/**
 * Drop the database `name` if it exists, `WITH (FORCE)` so connections still
 * open on it are ended. A refusal that passes in moments is retried, as the
 * Rust spine does: `FORCE` can't end an autovacuum worker for a role that
 * isn't a superuser (`42501`), and a connection can open between its
 * terminations and the drop (`55006`).
 *
 * @param postgres_url - the server, through a role with `CREATEDB` (`FUZ_TEST_POSTGRES_URL`)
 * @param name - the database to drop
 */
export const drop_test_postgres_database = async (
	postgres_url: string,
	name: string
): Promise<void> => {
	const sql = `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`;
	for (let attempt = 0; ; attempt++) {
		try {
			await run_admin_statement(postgres_url, sql);
			return;
		} catch (error) {
			const code = pg_error_code(error);
			if (attempt >= DROP_RETRIES || (code !== '42501' && code !== '55006')) throw error;
			await new Promise((resolve) => setTimeout(resolve, DROP_RETRY_DELAY_MS));
		}
	}
};

/** Options for `create_pg_factory`. */
export interface PgFactoryOptions {
	/**
	 * Names the factory's databases, `fuz_testing_<suite>_<pid>_<thread id>_<n>` —
	 * lowercase ASCII, digits and `_`, starting with a letter, at most 24 bytes.
	 */
	readonly suite: string;
}

/**
 * Numbers the databases this module instance creates. Each worker thread
 * loads its own instance, so the name carries the thread id beside the pid.
 */
let next_test_database = 0;

/**
 * Create a pg (PostgreSQL) database factory for tests.
 *
 * Skipped when `postgres_url` is not provided — callers pass
 * `process.env[FUZ_TEST_POSTGRES_URL_ENV]`; the factory never reads the
 * environment. `postgres_url` names a server and a role with `CREATEDB`, and
 * is used only as the admin connection: each `create()` creates a database of
 * its own there, `fuz_testing_<suite>_<pid>_<thread id>_<n>` from
 * `template0` (the thread id, from `node:worker_threads`, keeps names apart
 * under a threads pool), opens production's pool on it and runs
 * `init_schema`; `close()` ends the pool and drops the database
 * `WITH (FORCE)`. The Rust spine's `fuz_testing` creates and drops its
 * databases the same way under the same prefix (its names carry no thread
 * id), so a run of either killed before its `close()` leaves `fuz_testing_*`
 * databases — drop them by that prefix.
 *
 * @param init_schema - callback to initialize the database schema
 * @param postgres_url - the server to create databases on (`FUZ_TEST_POSTGRES_URL`), or `undefined` to skip
 * @param options - the suite name the databases are named for
 * @returns a factory that creates pg databases. The returned `create()`
 *   throws naming the variable when `postgres_url` is unset (despite the
 *   `skip: true` flag — defense against direct invocation), and says the role
 *   needs `CREATEDB` when it may not create databases.
 * @throws Error when `options.suite` breaks the naming rule
 */
export const create_pg_factory = (
	init_schema: (db: Db) => Promise<void>,
	postgres_url: string | undefined,
	options: PgFactoryOptions
): DbFactory => {
	const { suite } = options;
	assert_test_database_name_part('test suite name', suite, TEST_SUITE_NAME_LENGTH_MAX);
	// each database this factory created and has not closed, by the `Db` on it
	const open: Map<Db, { pool: DbCheckoutPool; name: string }> = new Map();

	return {
		name: 'pg',
		skip: !postgres_url,
		skip_reason: postgres_url ? undefined : `${FUZ_TEST_POSTGRES_URL_ENV} not set`,
		async create() {
			if (!postgres_url) {
				throw new Error(`${FUZ_TEST_POSTGRES_URL_ENV} required for pg tests.`);
			}
			const name = `${TEST_DATABASE_PREFIX}${suite}_${process.pid}_${threadId}_${next_test_database++}`;
			await create_test_postgres_database(postgres_url, name);
			let pool: DbCheckoutPool | null = null;
			try {
				const { default: pg } = await import('pg');
				// Mirror production's int8→number coercion (`create_db`) so the
				// test pg pool reads `BIGSERIAL` columns (e.g. `audit_log.seq`)
				// as numbers like PGlite does — without this the pg leg of a
				// `.db.test.ts` sees `seq` as a string and wire-schema parses fail.
				await register_pg_type_parsers();
				// production's pool, so a test reads production's checkout semantics
				pool = create_pg_pool(pg, {
					connection_string: with_database_name(postgres_url, name),
					checkout_timeout_ms: DEFAULT_DB_CHECKOUT_TIMEOUT_MS
				});
				const { db } = create_pg_db(pool);
				await init_schema(db);
				open.set(db, { pool, name });
				return db;
			} catch (error) {
				await pool?.end().catch(() => {});
				await drop_test_postgres_database(postgres_url, name).catch((drop_error: unknown) => {
					console.error(`a test database was left behind: ${name}`, drop_error);
				});
				throw error;
			}
		},
		async close(db) {
			const entry = open.get(db);
			if (!entry || !postgres_url) return;
			open.delete(db);
			try {
				await entry.pool.end();
			} finally {
				await drop_test_postgres_database(postgres_url, entry.name);
			}
		}
	};
};

/**
 * The auth namespace's row tables, in an order a `DELETE` per table can run
 * in: each table before the tables it references, and `role_grant_offer`
 * ahead of `role_grant` (the two reference each other, and the offer's side
 * is the one that blocks). `TRUNCATE … CASCADE` takes them in any order.
 *
 * Excludes `audit_log` (`auth_integration_truncate_tables` adds it) and the
 * singleton rows `app_settings` and `bootstrap_lock`, which a reset restores
 * rather than empties (`reset_auth_singletons`). Consumer projects spread this
 * into their own list and add their app tables.
 */
export const auth_truncate_tables = [
	'role_grant_offer',
	'invite',
	'api_token',
	'auth_session',
	'role_grant',
	'actor',
	'account'
];

/**
 * Auth tables including `audit_log` — every auth namespace table with rows a
 * test adds, what `reset_auth_state` empties. For suites that exercise the
 * full middleware stack (login, admin, rate limiting).
 *
 * Separate from `auth_truncate_tables` because unit-level DB tests that don't
 * touch audit logging don't need to truncate it.
 */
export const auth_integration_truncate_tables = [...auth_truncate_tables, 'audit_log'];

/**
 * Restore the auth namespace's singleton rows to their state on a fresh
 * database with no account: `app_settings` at its defaults (signup closed, never
 * updated) and `bootstrap_lock` not bootstrapped. Writes only a row that
 * differs. What every between-test reset runs beside emptying the row tables,
 * so a test that opens signup or bootstraps doesn't leak into the next.
 *
 * @param db - a database with the auth namespace migrated
 * @mutates the `app_settings` and `bootstrap_lock` rows
 */
export const reset_auth_singletons = async (db: Db): Promise<void> => {
	await db.query(
		'UPDATE app_settings SET open_signup = false, updated_at = NULL, updated_by = NULL ' +
			'WHERE open_signup = true OR updated_at IS NOT NULL OR updated_by IS NOT NULL'
	);
	await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE bootstrapped = true');
};

/**
 * Reset the auth namespace to its fresh-database state: a `DELETE` per table
 * of `auth_integration_truncate_tables`, in its order, then
 * `reset_auth_singletons`. A `DELETE` rather than a `TRUNCATE`, so it runs
 * inside a request's transaction without the table locks a `TRUNCATE` takes;
 * it follows the referencing tables' `ON DELETE` actions, and refuses on a
 * consumer foreign key with no action — empty those first. The
 * `_testing_reset` backdoor's auth wipe.
 *
 * @param db - a database with the auth namespace migrated
 * @mutates every auth row table and the singleton rows
 */
export const reset_auth_state = async (db: Db): Promise<void> => {
	for (const table of auth_integration_truncate_tables) {
		await db.query(`DELETE FROM ${table}`);
	}
	await reset_auth_singletons(db);
};

/**
 * Log factory status to console.
 */
export const log_db_factory_status = (factories: Array<DbFactory>): void => {
	const enabled = factories.filter((f) => !f.skip).map((f) => f.name);
	const skipped = factories.filter((f) => f.skip).map((f) => `${f.name} (${f.skip_reason})`);
	console.log(
		`[db tests] drivers: ${enabled.join(', ')}${
			skipped.length ? ` | skipped: ${skipped.join(', ')}` : ''
		}`
	);
};
