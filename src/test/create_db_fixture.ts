/**
 * `create_db_fixture` — builds the four-driver test fixture (pglite, pg, pglet
 * native wire, pglet-wasm) for a migration namespace list and binds
 * `describe_db` over it. Each fixture module (./db_fixture.ts for auth-only,
 * ./cell_db_fixture.ts for the full spine, ./fact_db_fixture.ts for facts
 * alone) calls this once at module load; importing a fixture therefore
 * constructs only that fixture's factories.
 *
 * @module
 */

import type { Db } from '$lib/db/db.ts';
import { run_migrations, type MigrationNamespace } from '$lib/db/migrate.ts';
import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	drop_auth_schema,
	log_db_factory_status,
	type DbFactory
} from '$lib/testing/db.ts';
import { create_pglet_factory } from './db_pglet_factory.ts';
import { create_pglet_wasm_factory } from './db_pglet_wasm_factory.ts';

/** The four-driver fixture `create_db_fixture` builds. */
export interface DbFixture {
	pglite_factory: DbFactory;
	pg_factory: DbFactory;
	/** All four drivers — pglite, pg, pglet, pglet-wasm — in that order. */
	db_factories: Array<DbFactory>;
	/** `describe_db(name, fn)` bound to all four factories + the fixture's truncate list. */
	describe_db: ReturnType<typeof create_describe_db>;
}

/**
 * Build the four-driver fixture for a migration namespace list.
 *
 * pg auto-skips when `TEST_DATABASE_URL` is unset, and the pglet legs (native
 * + wasm) auto-skip when `PGLET_SERVER_BIN` / `PGLET_WASM_PKG` are unset
 * (pglite always runs). Every namespace's migration is idempotent (guarded
 * `CREATE TYPE` + `CREATE TABLE IF NOT EXISTS`), so re-running it is safe on
 * any driver.
 *
 * The pg factory gets a whole-`public`-schema reset in front of the
 * migrations, per `drop_auth_schema`'s guidance: unlike every other driver,
 * `create_pg_factory` hands out one persistent database and its `create()`
 * drops only `schema_version` — and the `db` project runs `isolate: false`,
 * so one process shares that database across every file. DDL another file's
 * suite migrated (the cell/fact tables) is therefore still standing when this
 * file's suite runs, and the suites that assert over the *whole* schema —
 * `auth/account_schema.db.test.ts`'s foreign key inventory — read those tables
 * and fail. The pglite factory already resets its schema per `create()`; this
 * gives pg the same clean slate.
 *
 * @param namespaces - migration namespaces to run, in order
 * @param truncate_tables - tables to truncate between tests (children first)
 * @returns the pglite + pg factories, the full four-driver list, and the bound `describe_db`
 */
export const create_db_fixture = (
	namespaces: Array<MigrationNamespace>,
	truncate_tables: Array<string>
): DbFixture => {
	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, namespaces);
	};
	const init_schema_pg = async (db: Db): Promise<void> => {
		await drop_auth_schema(db);
		await init_schema(db);
	};
	const pglite_factory = create_pglite_factory(init_schema);
	const pg_factory = create_pg_factory(init_schema_pg, process.env.TEST_DATABASE_URL);
	const db_factories = [
		pglite_factory,
		pg_factory,
		create_pglet_factory(init_schema),
		create_pglet_wasm_factory(init_schema)
	];
	log_db_factory_status(db_factories);
	return {
		pglite_factory,
		pg_factory,
		db_factories,
		describe_db: create_describe_db(db_factories, truncate_tables)
	};
};
