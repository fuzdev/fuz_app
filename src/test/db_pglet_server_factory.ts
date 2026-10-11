/**
 * Dev-only native `pglet_server` factory for the `*.db.test.ts` suites.
 *
 * pglet is a small Postgres-compatible engine that speaks the Postgres wire
 * protocol, so it drops in beside PGlite, pglet-wasm and server PG: this spawns
 * an in-memory `pglet_server` and points node-postgres at it, reusing
 * `create_pg_db` verbatim. It is the `pglet-server` leg of the four-driver
 * fixture (`create_db_fixture.ts`) and a `FUZ_TEST_DB_DEFAULT=pglet-server`
 * default (`db_default.ts`).
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
 * @module
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { Db } from '#lib/db/db.ts';
import { create_pg_db, register_pg_type_parsers } from '#lib/db/db_pg.ts';
import { reset_public_schema, type DbFactoryBuilder } from '#lib/testing/db.ts';

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
	const child = spawn(bin, ['--port', String(port)], { stdio: 'ignore', detached: true });
	const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
	const kill = (): void => {
		try {
			// Kill the process group (detached spawn) so no stray server survives.
			if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
		} catch {
			// already exited / group already gone
		}
	};
	// The server must outlive each describe block's afterAll, so tie its
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

	const { Client } = await import('pg');
	const deadline = Date.now() + READY_TIMEOUT_MS;
	let last_error: unknown;
	while (Date.now() < deadline) {
		if (spawn_error_message) {
			kill();
			throw new Error(spawn_error_message);
		}
		const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
		try {
			await client.connect();
			await client.query('SELECT 1');
			await client.end();
			return { url, kill };
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
		`pglet server not ready after ${READY_TIMEOUT_MS}ms: ${to_error_message(last_error)}`
	);
};

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
		const { Pool } = await import('pg');
		return create_pg_db(new Pool({ connectionString: server.url })).db;
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
			// process-exit / signal hooks registered in `spawn_pglet_server`.
		}
	};
};
