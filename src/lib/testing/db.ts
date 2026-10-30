import './assert_dev_env.ts';

/**
 * Test database fixtures for parameterized testing.
 *
 * Provides factory builders for creating test databases with pglet-wasm (the
 * in-memory default), PGlite (in-memory) and pg (PostgreSQL) drivers. Consumer
 * projects provide their own schema initialization via `run_migrations` and
 * compose factories into test suites.
 *
 * @example
 * ```ts
 * import {create_default_db_factory, create_pg_factory} from '@fuzdev/fuz_app/testing/db.ts';
 * import {run_migrations} from '@fuzdev/fuz_app/db/migrate.ts';
 * import {AUTH_MIGRATION_NS} from '@fuzdev/fuz_app/auth/migrations.ts';
 *
 * const init_schema = async (db) => {
 *   await run_migrations(db, [AUTH_MIGRATION_NS]);
 * };
 * const default_factory = create_default_db_factory(init_schema);
 * const pg_factory = create_pg_factory(init_schema, process.env.TEST_DATABASE_URL);
 * export const db_factories = [default_factory, pg_factory];
 * ```
 *
 * @module
 */

import { describe, beforeAll, beforeEach, afterAll, assert } from 'vitest';
import type { Pool } from 'pg';

import type { Db } from '../db/db.ts';
import { create_pglite_db } from '../db/db_pglite.ts';
import { create_pglet_db_driver, create_pglet_instance } from '../db/db_pglet.ts';
import { assert_valid_sql_identifier } from '../db/sql_identifier.ts';
import {
	create_pg_db,
	create_pg_pool,
	DEFAULT_DB_CHECKOUT_TIMEOUT_MS,
	register_pg_type_parsers
} from '../db/db_pg.ts';
import { query_public_columns } from '../db/schema_ready.ts';
import { pg_error_code } from '../db/pg_error.ts';

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
 * every driver: the in-memory factories call it on each `create()`, and it is
 * recommended at the start of `init_schema` callbacks for `create_pg_factory`,
 * whose persistent databases accumulate stale DDL across fuz_app versions.
 * Drift-proof — it wipes every table, type, and sequence regardless of
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

/**
 * Build a factory over one module-level instance per driver: the first
 * `create()` creates it, and each `create()` resets its `public` schema and
 * runs `init_schema`, so only the first pays the WASM cold start.
 *
 * The instance lives as long as this module stays loaded — under the `db`
 * project's `isolate: false` + `fileParallelism: false` that is the whole run;
 * a project that isolates its files gets one per worker. A promise rather than
 * a value, so two concurrent first `create()` calls build one instance, and a
 * failed first load is the error every later `create()` reports.
 */
const create_shared_instance_factory = (
	name: string,
	resolve_db: () => Promise<Db>,
	init_schema: (db: Db) => Promise<void>
): DbFactory => {
	return {
		name,
		skip: false,
		async create() {
			const db = await resolve_db();
			// the instance is shared with every factory of this driver, so it may hold any schema
			await reset_public_schema(db);
			await init_schema(db);
			return db;
		},
		async close() {
			// No-op: the instance is module-level, so it lives as long as this module
			// stays loaded. Nothing frees it earlier.
		}
	};
};

// The module-level instances the shared factories hand out, created on first use.
let pglite_db: Promise<Db> | null = null;
let pglet_wasm_db: Promise<Db> | null = null;

const resolve_pglite_db = (): Promise<Db> =>
	(pglite_db ??= (async () => {
		const { PGlite } = await import('@electric-sql/pglite');
		return create_pglite_db(new PGlite()).db;
	})());

const resolve_pglet_wasm_db = (): Promise<Db> =>
	(pglet_wasm_db ??= create_pglet_instance().then((pglet) => create_pglet_db_driver(pglet).db));

/**
 * Create a PGlite (in-memory) database factory for tests.
 *
 * Always enabled — needs the optional `@electric-sql/pglite` peer installed.
 * Shares one PGlite WASM instance across the PGlite factories this module
 * builds; each `create()` resets the schema via `DROP SCHEMA public CASCADE`
 * instead of paying the cold start again.
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_pglite_factory: DbFactoryBuilder = (init_schema) =>
	create_shared_instance_factory('pglite', resolve_pglite_db, init_schema);

/**
 * Create a pglet-wasm (in-memory) database factory for tests.
 *
 * Always enabled — needs the optional `@fuzdev/pglet-wasm` peer installed.
 * Shares one pglet instance across the pglet-wasm factories this module
 * builds, created with fuz_app's value coercion (`PGLET_COERCION`); each
 * `create()` resets the schema via `DROP SCHEMA public CASCADE`.
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_pglet_wasm_factory: DbFactoryBuilder = (init_schema) =>
	create_shared_instance_factory('pglet-wasm', resolve_pglet_wasm_db, init_schema);

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
 * Create a pg (PostgreSQL) database factory for tests.
 *
 * Skipped when `test_url` is not provided. Each `create()` opens a pool,
 * resets the `public` schema (`reset_public_schema`) and runs `init_schema` —
 * the lifecycle every factory here shares, so a persistent test database never
 * carries stale DDL or tracker rows from an earlier run or another suite's
 * schema. Point `test_url` at a database used only for tests.
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
			const { default: pg } = await import('pg');
			// Mirror production's int8→number coercion (`create_db`) so the
			// test pg pool reads `BIGSERIAL` columns (e.g. `audit_log.seq`)
			// as numbers like PGlite does — without this the pg leg of a
			// `.db.test.ts` sees `seq` as a string and wire-schema parses fail.
			await register_pg_type_parsers();
			// production's pool, so a test reads production's checkout semantics
			const pool = create_pg_pool(pg, {
				connection_string: test_url,
				checkout_timeout_ms: DEFAULT_DB_CHECKOUT_TIMEOUT_MS
			});
			pool_ref = pool;
			const { db } = create_pg_db(pool);
			try {
				await reset_public_schema(db);
				await init_schema(db);
			} catch (error) {
				await pool.end();
				// 3D000 invalid_catalog_name — the database itself is missing, not
				// something a migration referenced
				if (pg_error_code(error) === '3D000') {
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
