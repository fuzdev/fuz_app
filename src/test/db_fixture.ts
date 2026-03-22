/**
 * Shared database test fixture for fuz_app.
 *
 * Creates pglite + pg factories with the full auth schema via migrations.
 * Consumer test files import `describe_db` for the convenience wrapper
 * or `db_factories` for manual composition.
 *
 * @module
 */

import type {Db} from '$lib/db/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
	log_db_factory_status,
} from '$lib/testing/db.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};

export const pglite_factory = create_pglite_factory(init_schema);
export const pg_factory = create_pg_factory(init_schema, TEST_DATABASE_URL);
export const db_factories = [pglite_factory, pg_factory];

log_db_factory_status(db_factories);

/** Runs against all factories with auth + audit_log tables. */
export const describe_db = create_describe_db(db_factories, AUTH_INTEGRATION_TRUNCATE_TABLES);
