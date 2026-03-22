import './assert_dev_env.js';

/**
 * Test database fixtures for parameterized testing.
 *
 * Provides factory builders for creating test databases with pglite (in-memory)
 * and pg (PostgreSQL) drivers. Consumer projects provide their own schema
 * initialization via `run_migrations` and compose factories into test suites.
 *
 * @example
 * ```ts
 * import {create_pglite_factory, create_pg_factory} from '@fuzdev/fuz_app/testing/db.js';
 * import {run_migrations} from '@fuzdev/fuz_app/db/migrate.js';
 * import {AUTH_MIGRATION_NS} from '@fuzdev/fuz_app/auth/migrations.js';
 *
 * const init_schema = async (db) => {
 *   await run_migrations(db, [AUTH_MIGRATION_NS]);
 * };
 * const pglite_factory = create_pglite_factory(init_schema);
 * const pg_factory = create_pg_factory(init_schema, process.env.TEST_DATABASE_URL);
 * export const db_factories = [pglite_factory, pg_factory];
 * ```
 *
 * @module
 */

import {describe, beforeAll, beforeEach, afterAll} from 'vitest';
import type {Pool} from 'pg';

import type {Db} from '../db/db.js';
import {create_pglite_db} from '../db/db_pglite.js';
import {assert_valid_sql_identifier} from '../db/sql_identifier.js';
import {create_pg_db} from '../db/db_pg.js';

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
 * Reset a PGlite database to a clean state by dropping and recreating the public schema.
 *
 * Removes all tables, sequences, indexes, types, and functions.
 * The database instance remains usable after reset.
 *
 * @param db - the database to reset
 */
export const reset_pglite = async (db: Db): Promise<void> => {
	await db.query('DROP SCHEMA public CASCADE');
	await db.query('CREATE SCHEMA public');
};

// Module-level PGlite cache — shared across all factories in the same vitest worker (one test file).
// Each vitest file runs in its own worker thread, so no cross-file contamination.
let module_db: Db | null = null;

/**
 * Create a pglite (in-memory) database factory for tests.
 *
 * Always enabled — no external dependencies required.
 * Shares a single PGlite WASM instance across all factories in the same
 * vitest worker thread (one test file). Subsequent `create()` calls reset
 * the schema via `DROP SCHEMA public CASCADE` instead of paying the WASM
 * cold-start cost again.
 *
 * @param init_schema - callback to initialize the database schema
 * @returns a factory that creates in-memory pglite databases
 */
export const create_pglite_factory = (init_schema: (db: Db) => Promise<void>): DbFactory => ({
	name: 'pglite',
	skip: false,
	async create() {
		if (module_db) {
			await reset_pglite(module_db);
		} else {
			const {PGlite} = await import('@electric-sql/pglite');
			const pglite = new PGlite();
			module_db = create_pglite_db(pglite).db;
		}
		await init_schema(module_db);
		return module_db;
	},
	async close() {
		// No-op: shared instance lives for the worker thread's lifetime.
		// PGlite is cleaned up when the vitest worker exits.
	},
});

/**
 * Create a pg (PostgreSQL) database factory for tests.
 *
 * Skipped when `test_url` is not provided.
 * Drops `schema_version` before running `init_schema`, forcing migrations
 * to re-evaluate against the actual tables. Prevents stale version entries
 * from skipping migrations when DDL changes between test sessions.
 *
 * For full clean-slate behavior (recommended), call `drop_auth_schema(db)`
 * at the start of `init_schema` before running migrations. This handles
 * upstream schema changes that go beyond adding new tables/columns.
 *
 * @param init_schema - callback to initialize the database schema
 * @param test_url - PostgreSQL connection URL (e.g. from `TEST_DATABASE_URL`)
 * @returns a factory that creates pg databases
 */
export const create_pg_factory = (
	init_schema: (db: Db) => Promise<void>,
	test_url?: string,
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
			const {Pool} = await import('pg');
			const pool = new Pool({connectionString: test_url});
			pool_ref = pool;
			const {db} = create_pg_db(pool);
			try {
				// Drop schema_version so migrations re-evaluate against the actual
				// tables. Prevents stale version entries from skipping migrations
				// when DDL changes between test sessions. Migrations use
				// IF NOT EXISTS guards, so re-running is safe.
				await db.query('DROP TABLE IF EXISTS schema_version');
				await init_schema(db);
			} catch (error) {
				await pool.end();
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes('does not exist')) {
					const db_name = test_url.split('/').pop()?.split('?')[0] ?? 'test_db';
					throw new Error(
						`Database "${db_name}" does not exist. Create it with: createdb ${db_name}`,
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
		},
	};
};

/**
 * Auth table names in truncation order (children first for FK safety).
 *
 * Consumer projects can spread this into their own list and append app-specific tables.
 */
export const AUTH_TRUNCATE_TABLES = [
	'invite',
	'api_token',
	'auth_session',
	'permit',
	'actor',
	'account',
];

/**
 * Auth tables including `audit_log` — for integration tests that exercise
 * the full middleware stack (login, admin, rate limiting).
 *
 * Separate from `AUTH_TRUNCATE_TABLES` because unit-level DB tests that don't
 * touch audit logging don't need to truncate it.
 */
export const AUTH_INTEGRATION_TRUNCATE_TABLES = [...AUTH_TRUNCATE_TABLES, 'audit_log'];

/**
 * All auth tables in drop order (children first for FK safety).
 *
 * The full set created by `AUTH_MIGRATIONS` — use for clean-slate
 * test DB initialization. `AUTH_TRUNCATE_TABLES` is the subset for
 * between-test data cleanup (excludes `audit_log`).
 *
 * When adding tables to `AUTH_MIGRATIONS`, add them here too.
 */
export const AUTH_DROP_TABLES = [
	'app_settings',
	'invite',
	'audit_log',
	'api_token',
	'auth_session',
	'permit',
	'actor',
	'account',
	'bootstrap_lock',
] as const;

/**
 * Drop all auth tables and schema version tracking for a clean slate.
 *
 * Recommended at the start of `init_schema` callbacks for `create_pg_factory`.
 * Persistent test databases can accumulate stale schema from previous fuz_app
 * versions — this ensures migrations run against a truly empty database.
 * Safe on fresh databases (`IF EXISTS` on all statements). No-op effect for
 * PGlite (already fresh), but harmless to call unconditionally.
 *
 * @param db - the database to clean
 */
export const drop_auth_schema = async (db: Db): Promise<void> => {
	for (const table of AUTH_DROP_TABLES) {
		await db.query(`DROP TABLE IF EXISTS ${assert_valid_sql_identifier(table)} CASCADE`); // eslint-disable-line no-await-in-loop
	}
	await db.query('DROP TABLE IF EXISTS schema_version CASCADE');
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
 * @returns a `describe_db` function for use in test files
 */
export const create_describe_db = (
	factories: DbFactory | Array<DbFactory>,
	truncate_tables: Array<string>,
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
							`TRUNCATE ${truncate_tables.map(assert_valid_sql_identifier).join(', ')} CASCADE`,
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
 *
 * @param factories - the database factories to report on
 */
export const log_db_factory_status = (factories: Array<DbFactory>): void => {
	const enabled = factories.filter((f) => !f.skip).map((f) => f.name);
	const skipped = factories.filter((f) => f.skip).map((f) => `${f.name} (${f.skip_reason})`);
	console.log(
		`[db tests] drivers: ${enabled.join(', ')}${skipped.length ? ` | skipped: ${skipped.join(', ')}` : ''}`,
	);
};
