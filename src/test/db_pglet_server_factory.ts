/**
 * Dev-only native `pglet_server` factory for the `*.db.test.ts` suites.
 *
 * pglet is a small Postgres-compatible engine that speaks the Postgres wire
 * protocol, so it drops in beside PGlite, pglet-wasm and server PG: this spawns
 * an in-memory `pglet_server` and points node-postgres at it, reusing
 * `create_pg_db` verbatim. It is the `pglet-server` leg of the four-driver
 * fixture (`create_db_fixture.ts`) and a `FUZ_TEST_DB_DEFAULT=pglet-server`
 * default (`db_default.ts`). The server is the one the cross-backend harness
 * spawns for a Rust backend (`spawn_pglet_server`), kept for the whole run.
 *
 * Opt-in and test-only — it lives in `src/test/` (never shipped in the package),
 * gated on `PGLET_SERVER_BIN` (the path to a built `pglet_server` binary), the
 * same way the `pg` factory gates on `FUZ_TEST_POSTGRES_URL`. With the var unset the
 * factory is skipped, so a default `gro test` is unaffected. There is no
 * hardcoded binary path, so the published source carries no cross-repo
 * reference; build the binary (`cargo build -p pglet_server`) and point the env
 * at it:
 *
 *   PGLET_SERVER_BIN=/path/to/pglet_server gro test
 *
 * @module
 */

import type { Db } from '#lib/db/db.ts';
import {
	create_pg_db,
	create_pg_pool,
	DEFAULT_DB_CHECKOUT_TIMEOUT_MS,
	register_pg_type_parsers
} from '#lib/db/db_pg.ts';
import {
	PGLET_SERVER_BIN_ENV,
	spawn_pglet_server
} from '#lib/testing/cross_backend/test_database.ts';
import { reset_public_schema, type DbFactoryBuilder } from '#lib/testing/db.ts';

const PGLET_SERVER_BIN = process.env[PGLET_SERVER_BIN_ENV];

// The one server every factory here hands out, spawned on first use and kept
// for the run. A promise rather than a value, so two concurrent first `create()`
// calls spawn one server, and a failed first spawn is the error every later
// `create()` reports.
let server_db: Promise<Db> | null = null;

const resolve_server_db = (bin: string): Promise<Db> =>
	(server_db ??= (async () => {
		// mirror the pg leg's int8→number coercion so BIGSERIAL columns read as numbers
		await register_pg_type_parsers();
		const server = await spawn_pglet_server(bin);
		const { default: pg } = await import('pg');
		return create_pg_db(
			create_pg_pool(pg, {
				connection_string: server.url,
				checkout_timeout_ms: DEFAULT_DB_CHECKOUT_TIMEOUT_MS
			})
		).db;
	})());

/**
 * Create a native pglet (wire-server) database factory for tests.
 *
 * Skipped unless `PGLET_SERVER_BIN` is set. Every factory shares one server for
 * the run, and each `create()` resets the whole `public` schema and runs
 * `init_schema` — the lifecycle the in-memory factories in `testing/db.ts` give
 * their drivers, so fixtures migrating different schemas never see each
 * other's tables, and a suite written against the default meets the same
 * create/reset shape here.
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_pglet_server_factory: DbFactoryBuilder = (init_schema) => {
	const skip = !PGLET_SERVER_BIN;
	return {
		name: 'pglet-server',
		skip,
		skip_reason: skip ? 'PGLET_SERVER_BIN not set' : undefined,
		async create() {
			if (!PGLET_SERVER_BIN) {
				throw new Error('PGLET_SERVER_BIN required for pglet-server tests.');
			}
			const db = await resolve_server_db(PGLET_SERVER_BIN);
			await reset_public_schema(db);
			await init_schema(db);
			return db;
		},
		async close() {
			// No-op: the server lives for the whole run and is killed by the
			// process-exit and signal hooks `spawn_pglet_server` registers.
		}
	};
};
