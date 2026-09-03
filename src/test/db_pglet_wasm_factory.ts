/**
 * Dev-only in-process `pglet-wasm` backend factory for the shared `*.db.test.ts` matrix.
 *
 * The in-process sibling of `db_pglet_factory.ts` (which spawns the native `pglet_server` and
 * talks to it over the wire): this loads pglet's published-shape WebAssembly adapter and drives
 * it directly, the same way `create_pglite_factory` drives PGlite. It exercises pglet in the
 * **embedded/local-first** context (no server, no socket) that mirrors how pglite is used.
 *
 * Consumes the ergonomic adapter's `create_pglet_db` — the SAME entry an `npm install`'d
 * consumer of `@fuzdev/pglet_wasm` uses — so this leg validates the *shipped* package (its
 * value-coercion contract, single-flight transaction guard, and `fork()`) against fuz_app's
 * real workload, rather than a hand-rolled shim that drifted from the engine.
 *
 * Opt-in and test-only — it lives in `src/test/` (never shipped in the package), gated on
 * `PGLET_WASM_PKG` (the path to a built `crates/pglet_wasm/pkg-npm` directory — the assembled
 * npm package, NOT the raw `pkg`), the same way the native leg gates on `PGLET_SERVER_BIN` and
 * the `pg` leg on `TEST_DATABASE_URL`. With the var unset the factory is skipped, so a default
 * `gro test` is unaffected and the published source carries no cross-repo path. Build the package
 * (`deno task build:npm` in the pglet repo) and point the env at it:
 *
 *   PGLET_WASM_PKG=/path/to/pglet/crates/pglet_wasm/pkg-npm gro test
 *
 * **int8 → Number.** The adapter defaults int8 to `bigint` (zero precision loss); fuz_app's
 * convention (its `pg` type parsers, `register_pg_type_parsers`) is `Number`, so this leg passes
 * `{coercion: {int8: 'number'}}` to keep it byte-for-byte with the native / `pg` / pglite legs.
 * The adapter also parses timestamps as UTC → `Date`, handles DATE and bytea, and recurses into
 * array elements — none of which the shim this replaced did.
 *
 * **Two exports, two isolation models.** `create_pglet_wasm_factory` is the matrix leg: the
 * schema is migrated **once** into a module-level base and each `create()` `base.fork()`s a fresh
 * copy-on-write branch instead of re-running the migrations (a fork shares the base's pages until
 * written — cheap, no row deep-copy). `create_pglet_wasm_shared_factory` is the stand-in shape for
 * `create_pglite_factory` (see `set_substitute_db_factory` in `testing/db.ts`): one instance for
 * the whole process, no forks, `DROP SCHEMA public CASCADE` + `init_schema` per `create()`. The
 * harness `beforeEach` TRUNCATE gives per-test isolation within a suite under either.
 *
 * @module
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Db, no_nested_transaction, type DbDriverResult } from '$lib/db/db.ts';
import { reset_pglite, type DbFactory } from '$lib/testing/db.ts';

const PGLET_WASM_PKG = process.env.PGLET_WASM_PKG;

/** The transaction handle the adapter hands the callback (query only — no savepoints). */
interface PgletTx {
	query: <T = unknown>(sql: string, params?: Array<unknown>) => Promise<{ rows: Array<T> }>;
}

/** The ergonomic `@fuzdev/pglet_wasm` adapter surface the factory uses (`create_pglet_db`'s return). */
interface PgletDb {
	query: <T = unknown>(sql: string, params?: Array<unknown>) => Promise<{ rows: Array<T> }>;
	transaction: <T>(fn: (tx: PgletTx) => Promise<T>) => Promise<T>;
	/** Branch a fresh, isolated copy-on-write instance at this one's committed state. */
	fork: () => PgletDb;
	/** Free the underlying wasm instance; idempotent. */
	close: () => void;
}

/** Coercion knobs the adapter accepts; fuz_app only sets `int8: 'number'`. */
interface PgletCoercionOptions {
	int8?: 'bigint' | 'number' | 'string';
	date?: 'string' | 'date';
}

/** The slice of the package's Node entry (`index.js`) the factory imports. */
interface PgletWasmModule {
	create_pglet_db: (options?: { coercion?: PgletCoercionOptions }) => PgletDb;
}

// Module-level cache — import the adapter once per vitest worker. The `node` export condition's
// `index.js` runs `readFileSync` + `initSync` at import, so there's no manual wasm-init step.
let wasm_module: PgletWasmModule | null = null;

/** Import the built `@fuzdev/pglet_wasm` Node entry from `PGLET_WASM_PKG` (cached; auto-inits). */
const load_wasm_module = async (pkg_dir: string): Promise<PgletWasmModule> => {
	if (wasm_module) return wasm_module;
	const module_url = pathToFileURL(join(pkg_dir, 'index.js')).href;
	wasm_module = (await import(/* @vite-ignore */ module_url)) as unknown as PgletWasmModule;
	return wasm_module;
};

/**
 * A transaction over a `PgletDb`, delegating to the adapter's single-flight `transaction()`
 * (BEGIN / COMMIT, ROLLBACK on throw). Mirrors `create_pglite_transaction`.
 */
const create_pglet_transaction =
	(pglet: PgletDb) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> =>
		pglet.transaction((tx) => fn(new Db({ client: tx, transaction: no_nested_transaction })));

/** Wrap a `PgletDb` as a fuz_app `Db` — it duck-types as a `DbClient` (`query(sql, params) → {rows}`). */
const create_pglet_wasm_db = (pglet: PgletDb): DbDriverResult => ({
	db: new Db({ client: pglet, transaction: create_pglet_transaction(pglet) }),
	close: () => {
		pglet.close();
		return Promise.resolve();
	}
});

/**
 * Create a pglet-wasm (in-process) database factory for tests.
 *
 * Skipped unless `PGLET_WASM_PKG` is set. Imports the adapter once, migrates the schema once
 * into a base (with fuz_app's int8→Number convention), and `base.fork()`s a fresh isolated
 * instance per `create()` instead of re-running `init_schema`.
 *
 * @param init_schema - callback to initialize the database schema (run once on the base)
 */
export const create_pglet_wasm_factory = (init_schema: (db: Db) => Promise<void>): DbFactory => {
	const skip = !PGLET_WASM_PKG;
	let current_close: (() => Promise<void>) | null = null;
	// The migrated base, seeded once per worker; each `create()` forks it.
	let base: PgletDb | null = null;
	return {
		name: 'pglet-wasm',
		skip,
		skip_reason: skip ? 'PGLET_WASM_PKG not set' : undefined,
		async create() {
			if (!PGLET_WASM_PKG) {
				throw new Error('PGLET_WASM_PKG required for pglet-wasm tests.');
			}
			const mod = await load_wasm_module(PGLET_WASM_PKG);
			// Seed the base once (run the migrations) with fuz_app's int8→Number convention, then
			// leave it pristine — every `create()` forks a copy-on-write branch of its committed state.
			if (!base) {
				base = mod.create_pglet_db({ coercion: { int8: 'number' } });
				const { db: base_db } = create_pglet_wasm_db(base);
				await init_schema(base_db);
			}
			const { db, close } = create_pglet_wasm_db(base.fork());
			current_close = close;
			return db;
		},
		async close() {
			// Free the forked wasm instance for this suite; the base + module stay cached.
			await current_close?.();
			current_close = null;
		}
	};
};

// The one wasm instance every `create_pglet_wasm_shared_factory` factory hands
// out, created on first use and kept for the run. A promise rather than a value
// so two concurrent first `create()` calls build one instance, not two — the
// rule `create_pglet_shared_factory`'s server memo states, rejection included:
// a failed first load is the error every later `create()` reports.
let shared_wasm_db: Promise<Db> | null = null;

const resolve_shared_wasm_db = (pkg_dir: string): Promise<Db> => {
	shared_wasm_db ??= (async () => {
		const mod = await load_wasm_module(pkg_dir);
		// fuz_app's int8 → Number convention, as `create_pglet_wasm_factory` uses
		return create_pglet_wasm_db(mod.create_pglet_db({ coercion: { int8: 'number' } })).db;
	})();
	return shared_wasm_db;
};

/**
 * Create a pglet-wasm (in-process) factory over one process-wide instance,
 * resetting the whole `public` schema per `create()`.
 *
 * The in-process sibling of `create_pglet_shared_factory`, and the same
 * stand-in shape for `create_pglite_factory` (see `set_substitute_db_factory`
 * in `testing/db.ts`): one instance, `DROP SCHEMA public CASCADE` +
 * `init_schema` per `create()`. `create_pglet_wasm_factory` above instead forks
 * a branch per `create()`, which suits a fixture leg whose `create()`/`close()`
 * calls are paired by `create_describe_db`; a suite that calls `create()` per
 * test and never closes the factory would hold every fork of the run.
 *
 * Skipped unless `PGLET_WASM_PKG` is set.
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_pglet_wasm_shared_factory = (
	init_schema: (db: Db) => Promise<void>
): DbFactory => {
	const skip = !PGLET_WASM_PKG;
	return {
		name: 'pglet-wasm',
		skip,
		skip_reason: skip ? 'PGLET_WASM_PKG not set' : undefined,
		async create() {
			if (!PGLET_WASM_PKG) {
				throw new Error('PGLET_WASM_PKG required for pglet-wasm tests.');
			}
			const db = await resolve_shared_wasm_db(PGLET_WASM_PKG);
			await reset_pglite(db);
			await init_schema(db);
			return db;
		},
		async close() {
			// No-op: the shared instance lives for the whole run, as the PGlite one does.
		}
	};
};
