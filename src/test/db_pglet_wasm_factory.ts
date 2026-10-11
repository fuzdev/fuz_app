/**
 * Dev-only in-process `pglet-wasm` matrix leg for the shared `*.db.test.ts` fixtures.
 *
 * The in-process sibling of `db_pglet_server_factory.ts` (which spawns the native `pglet_server` and
 * talks to it over the wire): this drives the installed `@fuzdev/pglet-wasm` package directly,
 * through the same `create_pglet_instance` + `create_pglet_db_driver` that `create_db`'s `memory://`
 * and `create_pglet_wasm_factory` use. It exercises pglet in the **embedded/local-first**
 * context (no server, no socket).
 *
 * Always enabled — the package is a devDependency. To run an unreleased pglet build, link its
 * assembled npm package (`crates/pglet_wasm/pkg-npm`, `deno task build:npm` in the pglet repo)
 * over the installed one; see `src/test/CLAUDE.md`.
 *
 * **One fork per `create()`.** The schema is migrated **once** into a module-level base and
 * each `create()` `base.fork()`s a fresh copy-on-write branch instead of re-running the
 * migrations (a fork shares the base's pages until written — cheap, no row deep-copy). That
 * suits a matrix leg, whose `create()`/`close()` calls `create_describe_db` pairs; a suite that
 * calls `create()` per test and never closes the factory would hold every fork of the run, which
 * is why the default factory (`create_pglet_wasm_factory` in `testing/db.ts`) shares one
 * instance and resets its schema instead. The harness `beforeEach` TRUNCATE gives per-test
 * isolation within a suite under either.
 *
 * @module
 */

import type { PgletDb } from '@fuzdev/pglet-wasm';

import type { Db } from '#lib/db/db.ts';
import { create_pglet_db_driver, create_pglet_instance } from '#lib/db/db_pglet.ts';
import type { DbFactory } from '#lib/testing/db.ts';

/**
 * Create the pglet-wasm matrix leg: migrates the schema once into a base and
 * `base.fork()`s a fresh isolated instance per `create()` instead of re-running
 * `init_schema`.
 *
 * @param init_schema - callback to initialize the database schema (run once on the base)
 */
export const create_pglet_wasm_fork_factory = (
	init_schema: (db: Db) => Promise<void>
): DbFactory => {
	let current_close: (() => Promise<void>) | null = null;
	// the migrated base, seeded once per factory; each `create()` forks it
	let base: PgletDb | null = null;
	return {
		name: 'pglet-wasm',
		skip: false,
		async create() {
			if (!base) {
				base = await create_pglet_instance();
				await init_schema(create_pglet_db_driver(base).db);
			}
			const { db, close } = create_pglet_db_driver(await base.fork());
			current_close = close;
			return db;
		},
		async close() {
			// free the forked instance for this suite; the base stays for the next fork
			await current_close?.();
			current_close = null;
		}
	};
};
