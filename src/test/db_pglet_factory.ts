/**
 * Dev-only `pglet` backend factory for the shared `*.db.test.ts` matrix.
 *
 * pglet is a small Postgres-compatible engine that speaks
 * the Postgres wire protocol, so it drops into the matrix as a third backend
 * alongside PGlite and server PG: this spawns a fresh in-memory `pglet_server`
 * and points node-postgres at it, reusing `create_pg_db` verbatim.
 *
 * Opt-in and test-only — it lives in `src/test/` (never shipped in the package),
 * gated on `PGLET_SERVER_BIN` (the path to a built `pglet_server` binary), the
 * same way the `pg` factory gates on `TEST_DATABASE_URL`. With the var unset the
 * factory is skipped, so a default `gro test` is unaffected. There is no
 * hardcoded binary path, so the published source carries no cross-repo
 * reference; build the binary (`cargo build -p pglet_server`) and point the env
 * at it:
 *
 *   PGLET_SERVER_BIN=/path/to/pglet_server gro test
 *
 * Lifecycle mirrors the `pg` factory: one long-lived server per factory instance,
 * kept for the whole run (`isolate: false` + `fileParallelism: false`) rather than
 * per-test — see `create_pglet_factory` below for why it is per-factory, not global
 * — with `DROP TABLE schema_version` + `init_schema` per `create()` and the harness
 * `beforeEach` TRUNCATE giving per-test isolation. A fresh in-memory server starts
 * empty, so no `DROP SCHEMA` (which pglet doesn't implement) is needed.
 *
 * @module
 */

import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import type {Pool} from 'pg';
import {to_error_message} from '@fuzdev/fuz_util/error.ts';

import type {Db} from '$lib/db/db.ts';
import {create_pg_db, register_pg_type_parsers} from '$lib/db/db_pg.ts';
import type {DbFactory} from '$lib/testing/db.ts';

const PGLET_SERVER_BIN = process.env.PGLET_SERVER_BIN;

/** Max time to wait for a spawned `pglet_server` to accept connections. */
const READY_TIMEOUT_MS = 10_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A spawned pglet server: its connection URL and a kill handle. */
interface PgletServer {
	url: string;
	kill: () => void;
}

/** Ask the OS for an unused TCP port (bind to 0, read the assigned port, release). */
const get_free_port = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const address = srv.address();
			const port = address != null && typeof address === 'object' ? address.port : 0;
			srv.close(() => resolve(port));
		});
	});

// Process-level cleanup registry — the spawned server's kill handle is fired on
// `exit` *and* on SIGINT/SIGTERM. `process.once('exit', kill)` alone leaks the
// server when vitest tears down its worker pool by signal (a signal-killed worker
// never emits `exit`), which strands one `pglet_server` per run.
const live_kills: Set<() => void> = new Set();
let cleanup_installed = false;

const register_server_cleanup = (kill: () => void): void => {
	live_kills.add(kill);
	if (cleanup_installed) return;
	cleanup_installed = true;
	const fire_all = (): void => {
		for (const k of live_kills) {
			try {
				k();
			} catch {
				// best-effort exit-time cleanup
			}
		}
		live_kills.clear();
	};
	process.once('exit', fire_all);
	// Tear children down, then restore the default handler and re-raise so the
	// process still exits with the right signal.
	const passthrough = (signal: NodeJS.Signals): void => {
		fire_all();
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	};
	process.once('SIGINT', () => passthrough('SIGINT'));
	process.once('SIGTERM', () => passthrough('SIGTERM'));
};

/**
 * Spawn `pglet_server` (in-memory B+tree) on a free port and wait until it accepts
 * a `SELECT 1` over node-postgres.
 *
 * @throws Error if the binary fails to spawn or never becomes ready
 */
const spawn_pglet_server = async (bin: string): Promise<PgletServer> => {
	const port = await get_free_port();
	// Default storage is the in-memory CoW B+tree (no `--data-dir`), which gives
	// real `BEGIN`/`COMMIT`/`ROLLBACK` — matching the pg / pglite / pglet-wasm legs.
	// `detached` puts the server in its own process group so the whole group can be
	// torn down together (no stray child outliving the test process).
	const child = spawn(bin, ['--port', String(port)], {stdio: 'ignore', detached: true});
	const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
	const kill = (): void => {
		try {
			// Kill the process group (detached spawn) so no stray server survives.
			if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
		} catch {
			// already exited / group already gone
		}
	};
	// The singleton server must outlive each describe block's afterAll, so tie its
	// lifetime to the test *process*. `exit` alone misses vitest's signal-based
	// worker teardown (which would strand the server), so cover SIGINT/SIGTERM too.
	register_server_cleanup(kill);
	child.unref();

	// A spawn failure (e.g. ENOENT for a bad path) fires asynchronously; surface
	// it as a clear error rather than a readiness timeout.
	let spawn_error_message: string | null = null;
	child.once('error', (err) => {
		spawn_error_message = `failed to spawn pglet server "${bin}": ${to_error_message(err)}`;
	});

	const {Client} = await import('pg');
	const deadline = Date.now() + READY_TIMEOUT_MS;
	let last_error: unknown;
	while (Date.now() < deadline) {
		if (spawn_error_message) {
			kill();
			throw new Error(spawn_error_message);
		}
		const client = new Client({connectionString: url, connectionTimeoutMillis: 1000});
		try {
			await client.connect();
			await client.query('SELECT 1');
			await client.end();
			return {url, kill};
		} catch (err) {
			last_error = err;
			try {
				await client.end();
			} catch {
				// connect failed — nothing to close
			}
			await delay(100);
		}
	}
	kill();
	throw new Error(
		`pglet server not ready after ${READY_TIMEOUT_MS}ms: ${to_error_message(last_error)}`,
	);
};

/**
 * Create a pglet (wire-server) database factory for tests.
 *
 * Skipped unless `PGLET_SERVER_BIN` is set. Spawns one in-memory `pglet_server`
 * lazily on first use and reuses it for the run; each `create()` drops
 * `schema_version` and re-runs `init_schema` (idempotent, mirroring the `pg`
 * factory) so migrations re-evaluate against the live tables.
 *
 * The spawned server is **per-factory-instance** (the state below lives in this
 * closure, not module scope): pglet has no `DROP SCHEMA`, so a server shared
 * across fixtures with *different* schemas would accumulate tables and leak them
 * into whole-database introspection (e.g. an auth FK-count test seeing fact
 * tables). One server per `create_pglet_factory` call keeps each fixture's schema
 * isolated; within a fixture every suite shares the one server (same schema).
 *
 * @param init_schema - callback to initialize the database schema
 */
export const create_pglet_factory = (init_schema: (db: Db) => Promise<void>): DbFactory => {
	// Per-factory-instance server/pool/db, spawned lazily on first `create()`.
	let server: PgletServer | null = null;
	let pool: Pool | null = null;
	let db: Db | null = null;
	const skip = !PGLET_SERVER_BIN;
	return {
		name: 'pglet',
		skip,
		skip_reason: skip ? 'PGLET_SERVER_BIN not set' : undefined,
		async create() {
			if (!PGLET_SERVER_BIN) {
				throw new Error('PGLET_SERVER_BIN required for pglet tests.');
			}
			if (!db) {
				// Mirror the pg leg's int8→number coercion so BIGSERIAL columns read
				// as numbers like PGlite does.
				await register_pg_type_parsers();
				server = await spawn_pglet_server(PGLET_SERVER_BIN);
				const {Pool} = await import('pg');
				pool = new Pool({connectionString: server.url});
				db = create_pg_db(pool).db;
			}
			// Drop the tracker so migrations re-evaluate against the actual tables
			// (IF NOT EXISTS guards make re-running safe), as the pg factory does.
			await db.query('DROP TABLE IF EXISTS schema_version');
			await init_schema(db);
			return db;
		},
		async close() {
			// No-op: this factory's server lives for the whole `db` run (it must
			// outlive each suite's afterAll) and is killed by the process-exit /
			// signal hooks registered in `spawn_pglet_server`.
		},
	};
};
