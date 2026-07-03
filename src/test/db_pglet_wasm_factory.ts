/**
 * Dev-only in-process `pglet-wasm` backend factory for the shared `*.db.test.ts` matrix.
 *
 * The in-process sibling of `db_pglet_factory.ts` (which spawns the native
 * `pglet_server` and talks to it over the wire): this loads pglet's WebAssembly
 * build and drives it directly, the same way `create_pglite_factory` drives PGlite.
 * It exercises pglet in the **embedded/local-first** context (no server, no socket)
 * that mirrors how pglite is used, complementing the native-wire leg.
 *
 * Opt-in and test-only — it lives in `src/test/` (never shipped in the package),
 * gated on `PGLET_WASM_PKG` (the path to a built `crates/pglet_wasm/pkg` directory),
 * the same way the native leg gates on `PGLET_SERVER_BIN` and the `pg` leg on
 * `TEST_DATABASE_URL`. With the var unset the factory is skipped, so a default
 * `gro test` is unaffected and the published source carries no cross-repo path.
 * Build the pkg (`deno task wasm:build` in the pglet repo) and point the env at it:
 *
 *   PGLET_WASM_PKG=/path/to/pglet/crates/pglet_wasm/pkg gro test
 *
 * Uses the `PgletBtree` binding — an in-memory copy-on-write B+tree with real
 * `BEGIN`/`COMMIT`/`ROLLBACK` transactions and bound-`$N`-parameter queries, which
 * is what fuz_app's `Db` requires. A fresh instance is created per `create()`
 * (cheap, in-memory), so no `DROP SCHEMA` (which pglet doesn't implement) is needed;
 * the harness `beforeEach` TRUNCATE gives per-test isolation.
 *
 * @module
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {Db, no_nested_transaction, type DbDriverResult} from '$lib/db/db.ts';
import type {DbFactory} from '$lib/testing/db.ts';

const PGLET_WASM_PKG = process.env.PGLET_WASM_PKG;

/** The slice of the generated `pglet_wasm` module the factory uses. */
interface PgletWasmModule {
	initSync: (input: {module: BufferSource}) => unknown;
	PgletBtree: new () => PgletBtreeInstance;
}

/** A row object as the wasm binding hands it back (raw values, pre-coercion). */
type WasmRow = Record<string, unknown>;

/** A column descriptor from the wasm `QueryResult.fields` array. */
interface WasmField {
	name: string;
	dataTypeName: string;
}

interface WasmQueryResult {
	rows: Array<WasmRow>;
	fields: Array<WasmField>;
}

/** The in-memory B+tree binding surface (see `crates/pglet_wasm`). */
interface PgletBtreeInstance {
	exec: (sql: string) => void;
	query: (sql: string) => WasmQueryResult;
	queryParams: (sql: string, params: Array<unknown>) => WasmQueryResult;
	free: () => void;
}

// Module-level cache — initialize the WASM module once per vitest worker; each
// `create()` makes a fresh `PgletBtree` over it.
let wasm_module: PgletWasmModule | null = null;

/** Load + `initSync` the `pglet_wasm` pkg from `PGLET_WASM_PKG` (cached). */
const load_wasm_module = async (pkg_dir: string): Promise<PgletWasmModule> => {
	if (wasm_module) return wasm_module;
	const module_url = pathToFileURL(join(pkg_dir, 'pglet_wasm.js')).href;
	const mod = (await import(/* @vite-ignore */ module_url)) as unknown as PgletWasmModule;
	// The `--target web` pkg needs the `.wasm` bytes passed to `initSync` to run
	// outside a browser (the same load path the pglet benches use under Node).
	mod.initSync({module: readFileSync(join(pkg_dir, 'pglet_wasm_bg.wasm'))});
	wasm_module = mod;
	return mod;
};

/**
 * Coerce one wasm `QueryResult` into `{rows}` matching the pg / pglite drivers.
 *
 * Two value shapes differ from what node-postgres / PGlite type parsers yield and
 * are normalized here: `int8` columns arrive as JS `BigInt` (→ `Number`, the
 * `register_pg_type_parsers` analog for `BIGSERIAL` ids/sizes), and `timestamp` /
 * `timestamptz` columns arrive as ISO strings (→ `Date`, matching both other drivers).
 *
 * A `BigInt` value only ever comes from an `INT8` column, so the column metadata
 * tells us up front whether anything needs rewriting: when a result has neither an
 * `int8` nor a `timestamp`/`timestamptz` column, the rows are returned as-is —
 * skipping the per-row object rebuild on the common (text/uuid/jsonb) path.
 */
const coerce_result = (result: WasmQueryResult): {rows: Array<unknown>} => {
	let has_int8 = false;
	const timestamp_columns = new Set<string>();
	for (const f of result.fields) {
		if (f.dataTypeName === 'INT8') {
			has_int8 = true;
		} else if (f.dataTypeName === 'TIMESTAMP' || f.dataTypeName === 'TIMESTAMPTZ') {
			timestamp_columns.add(f.name);
		}
	}
	if (!has_int8 && timestamp_columns.size === 0) {
		return {rows: result.rows};
	}
	const rows = result.rows.map((row) => {
		const out: WasmRow = {};
		for (const key in row) {
			const value = row[key];
			if (typeof value === 'bigint') {
				out[key] = Number(value);
			} else if (typeof value === 'string' && timestamp_columns.has(key)) {
				out[key] = new Date(value);
			} else {
				out[key] = value;
			}
		}
		return out;
	});
	return {rows};
};

/** A `DbClient` over a `PgletBtree` instance, with driver-parity value coercion. */
const create_pglet_wasm_client = (pglet: PgletBtreeInstance) => ({
	query: <T = unknown>(text: string, values?: Array<unknown>): Promise<{rows: Array<T>}> => {
		const result =
			values && values.length > 0 ? pglet.queryParams(text, values) : pglet.query(text);
		return Promise.resolve(coerce_result(result) as {rows: Array<T>});
	},
});

/**
 * Wrap a callback in a `BEGIN` / `COMMIT` (or `ROLLBACK` on throw) over the single
 * in-process connection — the same approach `create_pg_db` uses on a pooled client.
 */
const create_pglet_wasm_transaction =
	(pglet: PgletBtreeInstance, client: ReturnType<typeof create_pglet_wasm_client>) =>
	async <T>(fn: (tx_db: Db) => Promise<T>): Promise<T> => {
		pglet.exec('BEGIN');
		try {
			const result = await fn(new Db({client, transaction: no_nested_transaction}));
			pglet.exec('COMMIT');
			return result;
		} catch (error) {
			pglet.exec('ROLLBACK');
			throw error;
		}
	};

/** Create a `Db` backed by a `PgletBtree` wasm instance. */
const create_pglet_wasm_db = (pglet: PgletBtreeInstance): DbDriverResult => {
	const client = create_pglet_wasm_client(pglet);
	return {
		db: new Db({client, transaction: create_pglet_wasm_transaction(pglet, client)}),
		close: () => {
			pglet.free();
			return Promise.resolve();
		},
	};
};

/**
 * Create a pglet-wasm (in-process) database factory for tests.
 *
 * Skipped unless `PGLET_WASM_PKG` is set. Loads the wasm module once and creates a
 * fresh in-memory `PgletBtree` per `create()`, running `init_schema` against it.
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_pglet_wasm_factory = (init_schema: (db: Db) => Promise<void>): DbFactory => {
	const skip = !PGLET_WASM_PKG;
	let current_close: (() => Promise<void>) | null = null;
	return {
		name: 'pglet-wasm',
		skip,
		skip_reason: skip ? 'PGLET_WASM_PKG not set' : undefined,
		async create() {
			if (!PGLET_WASM_PKG) {
				throw new Error('PGLET_WASM_PKG required for pglet-wasm tests.');
			}
			const mod = await load_wasm_module(PGLET_WASM_PKG);
			const pglet = new mod.PgletBtree();
			const {db, close} = create_pglet_wasm_db(pglet);
			current_close = close;
			await init_schema(db);
			return db;
		},
		async close() {
			// Free the wasm instance for this suite; the module stays cached.
			await current_close?.();
			current_close = null;
		},
	};
};
