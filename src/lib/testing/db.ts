import './assert_dev_env.ts';

/**
 * Test database fixtures for parameterized testing.
 *
 * Provides factory builders for creating test databases with pglite (in-memory)
 * and pg (PostgreSQL) drivers. Consumer projects provide their own schema
 * initialization via `run_migrations` and compose factories into test suites.
 *
 * @example
 * ```ts
 * import {create_pglite_factory, create_pg_factory} from '@fuzdev/fuz_app/testing/db.ts';
 * import {run_migrations} from '@fuzdev/fuz_app/db/migrate.ts';
 * import {auth_migration_ns} from '@fuzdev/fuz_app/auth/migrations.ts';
 *
 * const init_schema = async (db) => {
 *   await run_migrations(db, [auth_migration_ns]);
 * };
 * const pglite_factory = create_pglite_factory(init_schema);
 * const pg_factory = create_pg_factory(init_schema, process.env.TEST_DATABASE_URL);
 * export const db_factories = [pglite_factory, pg_factory];
 * ```
 *
 * @module
 */

import { describe, beforeAll, beforeEach, afterAll, assert } from 'vitest';
import type { Pool } from 'pg';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { Db } from '../db/db.ts';
import { create_pglite_db } from '../db/db_pglite.ts';
import { assert_valid_sql_identifier } from '../db/sql_identifier.ts';
import { create_pg_db, register_pg_type_parsers } from '../db/db_pg.ts';
import { query_public_columns } from '../db/schema_ready.ts';

/**
 * CI detection — `CI=true` is set automatically by GitHub Actions, GitLab CI, etc.
 */
export const IS_CI = process.env.CI === 'true';

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
 * Reset a test database to a clean state by dropping and recreating the public schema.
 *
 * Removes all tables, sequences, indexes, types, and functions.
 * The database instance remains usable after reset. Despite the name it issues
 * plain SQL, so it also resets the other drivers the test factories hand out.
 *
 * @mutates db - drops the `public` schema and recreates it; all rows in all
 *   tables are gone after this returns.
 */
export const reset_pglite = async (db: Db): Promise<void> => {
	await db.query('DROP SCHEMA public CASCADE');
	await db.query('CREATE SCHEMA public');
};

// Module-level PGlite cache — one instance shared by the PGlite factories this
// module builds, for as long as the module is loaded. Under the `db` project's
// `isolate: false` + `fileParallelism: false` that is the whole run; a project
// that isolates its files gets one per worker instead.
let module_db: Db | null = null;

/**
 * Builds a `DbFactory` from a schema initializer — `create_pglite_factory`'s own shape.
 */
export type DbFactoryBuilder = (init_schema: (db: Db) => Promise<void>) => DbFactory;

/**
 * Options for `create_pglite_factory`.
 */
export interface CreatePgliteFactoryOptions {
	/**
	 * Whether an installed substitute (`set_substitute_db_factory`) may stand in
	 * for the PGlite factory at this call site. Defaults to `true`; pass `false`
	 * where PGlite itself is the subject under test.
	 */
	substitutable?: boolean;
}

// The installed stand-in for `create_pglite_factory`, `null` when none is installed.
let substitute_db_factory: DbFactoryBuilder | null = null;

/**
 * Install a builder that stands in for `create_pglite_factory`, so suites
 * written against PGlite can run against another driver without being edited.
 *
 * Injected rather than selected here: the drivers a substitute wraps live in
 * test-side code this shipped module cannot import. A call site that passes
 * `{substitutable: false}` keeps PGlite regardless. Pass `null` to uninstall.
 *
 * The slot is read when a factory is built, not when it creates a database,
 * so install before the first `create_pglite_factory` call — a vitest
 * `setupFiles` entry, which runs ahead of every test file's imports, is the
 * shape fuz_app's own `db` project uses. A factory built earlier (including
 * the module-level fallback in `testing/app_server.ts`) keeps the driver it
 * was built with, and uninstalling does not revert it.
 *
 * @param create_factory - the builder to install, or `null` to remove the installed one
 */
export const set_substitute_db_factory = (create_factory: DbFactoryBuilder | null): void => {
	substitute_db_factory = create_factory;
};

/**
 * Create a pglite (in-memory) database factory for tests.
 *
 * Always enabled — no external dependencies required.
 * Shares a single PGlite WASM instance across the PGlite factories this module builds.
 * Subsequent `create()` calls reset the schema via `DROP SCHEMA public CASCADE`
 * instead of paying the WASM cold-start cost again.
 *
 * Returns the installed substitute's factory instead when one is installed and
 * `options.substitutable` is not `false` — see `set_substitute_db_factory`.
 *
 * @param init_schema - callback to initialize the database schema
 * @param options - `substitutable: false` pins this call site to PGlite
 */
export const create_pglite_factory = (
	init_schema: (db: Db) => Promise<void>,
	options?: CreatePgliteFactoryOptions
): DbFactory => {
	if (substitute_db_factory && options?.substitutable !== false) {
		return substitute_db_factory(init_schema);
	}
	return {
		name: 'pglite',
		skip: false,
		async create() {
			if (module_db) {
				await reset_pglite(module_db);
			} else {
				const { PGlite } = await import('@electric-sql/pglite');
				const pglite = new PGlite();
				module_db = create_pglite_db(pglite).db;
			}
			await init_schema(module_db);
			return module_db;
		},
		async close() {
			// No-op: the instance is the module-level cache above, so it lives as long
			// as this module stays loaded — under the `db` project's `isolate: false` +
			// `fileParallelism: false` that is the whole run. Nothing frees the PGlite
			// instance earlier.
		}
	};
};

/**
 * Create a pg (PostgreSQL) database factory for tests.
 *
 * Skipped when `test_url` is not provided.
 * Drops `schema_version` before running `init_schema`, forcing migrations
 * to re-evaluate against the actual tables. Prevents stale tracker rows
 * from skipping migrations when DDL changes between test sessions.
 *
 * For full clean-slate behavior (recommended), call `drop_auth_schema(db)`
 * at the start of `init_schema` before running migrations. This handles
 * upstream schema changes that go beyond adding new tables/columns.
 *
 * @param init_schema - callback to initialize the database schema
 * @param test_url - PostgreSQL connection URL (e.g. from `TEST_DATABASE_URL`)
 * @returns a factory that creates pg databases. The returned `create()`
 *   throws when `test_url` is unset (despite the `skip: true` flag — defense
 *   against direct invocation), and rewrites Postgres "database does not
 *   exist" errors into a `createdb` hint message.
 */
export const create_pg_factory = (
	init_schema: (db: Db) => Promise<void>,
	test_url?: string
): DbFactory => {
	const should_skip = !test_url;
	const skip_reason = !test_url ? 'TEST_DATABASE_URL not set' : undefined;

	let pool_ref: Pool | null = null;

	return {
		name: 'pg',
		skip: should_skip,
		skip_reason,
		async create() {
			if (!test_url) {
				throw new Error('TEST_DATABASE_URL required for pg tests.');
			}
			// Close any previous pool to prevent leaks on repeated create() calls.
			// With isolate: false, the pool may have been ended by a previous file's close().
			if (pool_ref) {
				try {
					await pool_ref.end();
				} catch {
					// pool already ended — safe to ignore
				}
				pool_ref = null;
			}
			const { Pool } = await import('pg');
			// Mirror production's int8→number coercion (`create_db`) so the
			// test pg pool reads `BIGSERIAL` columns (e.g. `audit_log.seq`)
			// as numbers like PGlite does — without this the pg leg of a
			// `.db.test.ts` sees `seq` as a string and wire-schema parses fail.
			await register_pg_type_parsers();
			const pool = new Pool({ connectionString: test_url });
			pool_ref = pool;
			const { db } = create_pg_db(pool);
			try {
				// Drop schema_version so migrations re-evaluate against the actual
				// tables. Prevents stale tracker rows from skipping migrations
				// when DDL changes between test sessions. Migrations use
				// IF NOT EXISTS guards, so re-running is safe.
				await db.query('DROP TABLE IF EXISTS schema_version');
				await init_schema(db);
			} catch (error) {
				await pool.end();
				const msg = to_error_message(error);
				if (msg.includes('does not exist')) {
					const db_name = test_url.split('/').pop()?.split('?')[0] ?? 'test_db';
					throw new Error(
						`Database "${db_name}" does not exist. Create it with: createdb ${db_name}`
					);
				}
				throw error;
			}
			return db;
		},
		async close() {
			if (pool_ref) {
				try {
					await pool_ref.end();
				} catch {
					// pool already ended — safe to ignore
				}
				pool_ref = null;
			}
		}
	};
};

/**
 * Auth table names in truncation order (children first for FK safety).
 *
 * Consumer projects can spread this into their own list and append app-specific tables.
 */
export const auth_truncate_tables = [
	'invite',
	'api_token',
	'auth_session',
	'role_grant',
	'role_grant_offer',
	'actor',
	'account'
];

/**
 * Auth tables including `audit_log` — for integration tests that exercise
 * the full middleware stack (login, admin, rate limiting).
 *
 * Separate from `auth_truncate_tables` because unit-level DB tests that don't
 * touch audit logging don't need to truncate it.
 */
export const auth_integration_truncate_tables = [...auth_truncate_tables, 'audit_log'];

/**
 * Reset the entire `public` schema for a clean slate before re-migration.
 *
 * Recommended at the start of `init_schema` callbacks for `create_pg_factory`.
 * Persistent test databases accumulate stale DDL across fuz_app versions;
 * `DROP SCHEMA public CASCADE; CREATE SCHEMA public` wipes every table, type,
 * and sequence regardless of namespace, so migrations always run against a
 * truly empty database. Drift-proof — unlike a hand-maintained drop list it
 * needs no upkeep when the schema gains a table. Despite the historical name,
 * this resets the whole schema, not just auth tables (the only documented use
 * is clean-slate re-migration, which always wanted a full reset).
 *
 * @mutates db - drops and recreates the `public` schema; all tables gone.
 */
export const drop_auth_schema = async (db: Db): Promise<void> => {
	await db.query('DROP SCHEMA public CASCADE');
	await db.query('CREATE SCHEMA public');
};

/**
 * Create a `describe_db` function bound to specific factories and truncate tables.
 *
 * Returns a 2-arg `(name, fn)` function that runs the test suite against each
 * factory. Each factory gets its own `describe` block with a shared database
 * instance, automatic `beforeEach` truncation, and `afterAll` cleanup.
 * Skipped factories use `describe.skip`.
 *
 * @param factories - one or more database factories to run suites against
 * @param truncate_tables - tables to truncate between tests (children first for FK safety)
 * @mutates the underlying database between tests — `beforeEach` issues
 *   `TRUNCATE <truncate_tables> CASCADE` against the shared instance.
 */
export const create_describe_db = (
	factories: DbFactory | Array<DbFactory>,
	truncate_tables: Array<string>
): ((name: string, fn: (get_db: () => Db) => void) => void) => {
	const factory_list = Array.isArray(factories) ? factories : [factories];
	return (name, fn) => {
		for (const factory of factory_list) {
			const describe_fn = factory.skip ? describe.skip : describe;
			describe_fn(`${name} (${factory.name})`, () => {
				let db: Db | undefined;
				beforeAll(async () => {
					db = await factory.create();
				});
				beforeEach(async () => {
					if (db && truncate_tables.length > 0) {
						await db.query(
							`TRUNCATE ${truncate_tables.map(assert_valid_sql_identifier).join(', ')} CASCADE`
						);
					}
				});
				afterAll(async () => {
					if (db) await factory.close(db);
				});
				fn(() => db!);
			});
		}
	};
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

/**
 * Assert a `*_COLUMNS` projection const names exactly the live columns of
 * `table` — the drift guard for an exported const (`ACCOUNT_COLUMNS`,
 * `CELL_COLUMNS`, a consumer's own).
 *
 * This is the reverse of the fail-loud read: a named projection makes a
 * *dropped* column fail loud at query time, but a column *added* to the table
 * and not to the projection would silently vanish from every row read. Both
 * directions are covered by the equality here. It guards one const; it can't
 * see a table that has *no* const — for that, keep a table → const registry
 * and assert its key set against `query_public_columns` (fuz_app's own is
 * `src/test/db/column_projections.db.test.ts`).
 *
 * @param db - a bootstrapped test database
 * @param table - the `public`-schema table the const projects
 * @param columns - the projection const's column names
 */
export const assert_columns_match_live = async (
	db: Db,
	table: string,
	columns: ReadonlyArray<string>
): Promise<void> => {
	const live = await query_public_columns(db, { table });
	assert.ok(live[table], `table "${table}" is not in the live public schema`);
	assert.deepEqual([...columns].sort(), live[table]);
};
