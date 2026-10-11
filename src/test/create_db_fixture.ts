/**
 * `create_db_fixture` — builds the four-driver test fixture (pglite, pg,
 * pglet-server, pglet-wasm) for a migration namespace list and binds
 * `describe_db` over it. Each fixture module (./db_fixture.ts for auth-only,
 * ./cell_db_fixture.ts for the full spine, ./fact_db_fixture.ts for facts
 * alone) calls this once at module load; importing a fixture therefore
 * constructs only that fixture's factories.
 *
 * @module
 */

import type { Db } from '#lib/db/db.ts';
import { run_migrations, type MigrationNamespace } from '#lib/db/migrate.ts';
import {
	create_default_db_factory,
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	log_db_factory_status,
	type DbFactory
} from '#lib/testing/db.ts';
import { create_pglet_server_factory } from './db_pglet_server_factory.ts';
import { create_pglet_wasm_fork_factory } from './db_pglet_wasm_factory.ts';

/** The four-driver fixture `create_db_fixture` builds. */
export interface DbFixture {
	/**
	 * This fixture's schema on the run's default driver — pglet-wasm, or the
	 * driver `db_default.ts` installs. For the suites that take one
	 * database directly rather than through `describe_db`.
	 */
	default_db_factory: DbFactory;
	pg_factory: DbFactory;
	/** All four drivers — pglite, pg, pglet-server, pglet-wasm — in that order. */
	db_factories: Array<DbFactory>;
	/** `describe_db(name, fn)` bound to all four factories + the fixture's truncate list. */
	describe_db: ReturnType<typeof create_describe_db>;
}

/**
 * Build the four-driver fixture for a migration namespace list.
 *
 * pg auto-skips when `TEST_DATABASE_URL` is unset, and pglet-server when
 * `PGLET_SERVER_BIN` is (pglite and pglet-wasm always run). Every namespace's migration is idempotent (guarded
 * `CREATE TYPE` + `CREATE TABLE IF NOT EXISTS`), so re-running it is safe on
 * any driver.
 * *
 * Every factory resets the whole `public` schema per `create()`, so the
 * fixtures' different schemas never leak into each other — the suites that
 * assert over the *whole* schema (`auth/account_schema.db.test.ts`'s foreign
 * key inventory) depend on that.
 *
 * @param namespaces - migration namespaces to run, in order
 * @param truncate_tables - tables to truncate between tests (children first)
 * @returns the default-driver + pg factories, the full four-driver list, and the bound `describe_db`
 */
export const create_db_fixture = (
	namespaces: Array<MigrationNamespace>,
	truncate_tables: Array<string>
): DbFixture => {
	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, namespaces);
	};
	const pg_factory = create_pg_factory(init_schema, process.env.TEST_DATABASE_URL);
	const db_factories = [
		create_pglite_factory(init_schema),
		pg_factory,
		create_pglet_server_factory(init_schema),
		create_pglet_wasm_fork_factory(init_schema)
	];
	log_db_factory_status(db_factories);
	return {
		// the suites that take one database directly are not a leg of the matrix, so
		// they follow the run's default driver like every other `create_default_db_factory` site
		default_db_factory: create_default_db_factory(init_schema),
		pg_factory,
		db_factories,
		describe_db: create_describe_db(db_factories, truncate_tables)
	};
};
