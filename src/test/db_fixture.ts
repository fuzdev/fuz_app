/**
 * Shared database test fixture for fuz_app.
 *
 * Creates the pglite, pg, pglet (native wire), and pglet-wasm factories with the
 * full auth schema via migrations. Consumer test files import `describe_db` for the
 * convenience wrapper or `db_factories` for manual composition.
 *
 * @module
 */

import type { Db } from '$lib/db/db.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	drop_auth_schema,
	auth_integration_truncate_tables,
	log_db_factory_status
} from '$lib/testing/db.ts';
import { create_pglet_factory } from './db_pglet_factory.ts';
import { create_pglet_wasm_factory } from './db_pglet_wasm_factory.ts';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};

/**
 * `init_schema` with the whole-`public`-schema reset the pg factory needs, per
 * `drop_auth_schema`'s guidance.
 *
 * Unlike every other driver, `create_pg_factory` hands out one persistent
 * database and its `create()` drops only `schema_version` — and the `db`
 * project runs `isolate: false`, so one process shares that database across
 * every file. DDL another file's suite migrated (the cell/fact tables) is
 * therefore still standing when this file's suite runs, and the suites that
 * assert over the *whole* schema — `auth/account_schema.db.test.ts`'s foreign
 * key inventory — read those tables and fail. The pglite factory already
 * resets its schema per `create()`; this gives pg the same clean slate.
 */
const init_schema_pg = async (db: Db): Promise<void> => {
	await drop_auth_schema(db);
	await init_schema(db);
};

export const pglite_factory = create_pglite_factory(init_schema);
export const pg_factory = create_pg_factory(init_schema_pg, TEST_DATABASE_URL);
export const pglet_factory = create_pglet_factory(init_schema);
export const pglet_wasm_factory = create_pglet_wasm_factory(init_schema);
export const db_factories = [pglite_factory, pg_factory, pglet_factory, pglet_wasm_factory];

log_db_factory_status(db_factories);

/** Runs against all factories with auth + audit_log tables. */
export const describe_db = create_describe_db(db_factories, auth_integration_truncate_tables);
