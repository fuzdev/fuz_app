import '../assert_dev_env.ts';

/**
 * The database a spawned test backend runs over, provisioned by the harness
 * before the spawn and gone after its teardown.
 *
 * By default it is a native `pglet_server` of its own (pglet speaks the
 * Postgres wire protocol, so `tokio-postgres` and `pg` both reach it),
 * spawned on a port the kernel picks. Under `FUZ_TEST_POSTGRES_URL`
 * (`FUZ_TEST_POSTGRES_URL_ENV`) it is instead a PostgreSQL database of its
 * own on that server, `fuz_testing_<repo>_<name>`, dropped if a killed run
 * left it and dropped again on `close()` — under a session advisory lock on
 * the name, so a second run of it fails rather than dropping the first's.
 * Either way it starts empty, so a backend boots over nothing another run or
 * another backend wrote.
 *
 * One pglet server per database: pglet keeps one store per process and
 * ignores the database name a client asks for, so two backends that must not
 * share rows can't share a server. Two that must — the backend swap and both
 * spines live — share one `TestDatabase`.
 *
 * The `pglet_server` binary is built in the backend's own Cargo workspace
 * (`prepare_pglet_server_binary`), whose lockfile already holds the pglet the
 * Rust spine's `fuz_testing` runs, or named by `PGLET_SERVER_BIN`.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { create_db } from '../../db/create_db.ts';
import { redact_database_url, with_database_name } from '../../db/postgres_url.ts';
import {
	assert_test_database_name_part,
	create_test_postgres_database,
	drop_test_postgres_database,
	FUZ_TEST_POSTGRES_URL_ENV,
	reset_public_schema,
	TEST_DATABASE_PREFIX
} from '../db.ts';
import type { BackendConfig } from './backend_config.ts';
import { prepare_cargo_binary } from './cargo_binary.ts';

/** Env var naming a prebuilt `pglet_server` binary, which `prepare_pglet_server_binary` returns unbuilt. */
export const PGLET_SERVER_BIN_ENV = 'PGLET_SERVER_BIN';

/** The Cargo package, and binary, of the pglet wire server. */
export const PGLET_SERVER_CRATE = 'pglet_server';

/** Which engine a `TestDatabase` runs on. */
export type TestDatabaseEngine = 'pglet' | 'postgres';

/** A database provisioned for spawned test backends. */
export interface TestDatabase {
	/** The `postgres://` URL a backend's `DATABASE_URL` takes. */
	readonly url: string;
	readonly engine: TestDatabaseEngine;
	/**
	 * Empty it — drop and recreate its `public` schema — so the next backend
	 * migrates and bootstraps from nothing (`empty_test_database`).
	 */
	readonly empty: () => Promise<void>;
	/** Stop its pglet server, or drop its PostgreSQL database. Idempotent. */
	readonly close: () => Promise<void>;
}

/** Options for `open_test_database`. */
export interface OpenTestDatabaseOptions {
	/**
	 * Names it: the PostgreSQL database is `fuz_testing_<repo>_<name>`, `<repo>`
	 * the running repo's directory (as `default_test_backend_prefix` namespaces
	 * temp directories), so two repos' backends of one name never share a
	 * database. Lowercase ASCII, digits and `_`, starting with a letter.
	 */
	readonly name: string;
	/**
	 * The PostgreSQL server to create the database on, through a role with
	 * `CREATEDB` — `process.env[FUZ_TEST_POSTGRES_URL_ENV]`. `undefined` for a
	 * pglet server.
	 */
	readonly postgres_url: string | undefined;
	/**
	 * The `pglet_server` binary's path, asked for only when `postgres_url` is
	 * unset — `prepare_pglet_server_binary`, so a PostgreSQL run builds nothing.
	 * `null` for a database that must be PostgreSQL (a gate pglet can't
	 * answer, like index rendering), which then fails naming the variable
	 * rather than running on another engine or skipping.
	 */
	readonly pglet_server_bin: (() => string) | null;
}

/** The longest database name PostgreSQL keeps whole. */
const POSTGRES_NAME_LENGTH_MAX = 63;

/**
 * The PostgreSQL database `open_test_database` names for `name`:
 * `fuz_testing_<repo>_<name>`, the repo directory's name lowercased with
 * every character PostgreSQL would need quoted as `_`.
 *
 * @param name - the database's name within the repo
 * @returns the database name
 * @throws Error when `name` breaks the naming rule or the whole name is too long
 */
export const to_test_database_name = (name: string): string => {
	const repo = basename(process.cwd())
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_');
	const prefix = `${TEST_DATABASE_PREFIX}${repo}_`;
	assert_test_database_name_part(
		'test database name',
		name,
		Math.max(0, POSTGRES_NAME_LENGTH_MAX - prefix.length)
	);
	return prefix + name;
};

/**
 * Provision a database for spawned test backends: a pglet server of its own,
 * or under `postgres_url` a PostgreSQL database of its own, empty either way.
 *
 * @param options - its name, the PostgreSQL server, and the pglet binary
 * @returns the database; `close()` it after the backends' teardown
 * @throws Error when the pglet server doesn't start, when the PostgreSQL
 *   database can't be created (naming the variable, or the missing `CREATEDB`),
 *   when another run holds the PostgreSQL database's name, or when a
 *   PostgreSQL-only database (`pglet_server_bin: null`) has no `postgres_url`
 */
export const open_test_database = async (
	options: OpenTestDatabaseOptions
): Promise<TestDatabase> => {
	const { name, postgres_url } = options;
	if (postgres_url) {
		const database = to_test_database_name(name);
		// The name is stable, so another run of the same project (or a clone in a
		// directory of the same name) would drop this run's live database before
		// its port claim refused it. A session advisory lock on the name, held by
		// an admin connection for the database's life, makes the second run fail
		// first; the lock goes with the connection, so a killed run frees it.
		const lock = await lock_test_database_name(postgres_url, database);
		const url = with_database_name(postgres_url, database);
		try {
			// a killed run's leftover, which the stable name finds
			await drop_test_postgres_database(postgres_url, database);
			await create_test_postgres_database(postgres_url, database);
		} catch (error) {
			await lock.end().catch(() => {});
			throw error;
		}
		let closed: Promise<void> | null = null;
		return {
			url,
			engine: 'postgres',
			empty: () => empty_test_database(url),
			close: () =>
				(closed ??= (async () => {
					try {
						await drop_test_postgres_database(postgres_url, database);
					} finally {
						await lock.end();
					}
				})())
		};
	}
	if (!options.pglet_server_bin) {
		throw new Error(
			`the test database ${JSON.stringify(name)} runs only on PostgreSQL: set ` +
				`${FUZ_TEST_POSTGRES_URL_ENV} to a server and a role with CREATEDB ` +
				`(e.g. postgres://localhost/postgres)`
		);
	}
	const server = await spawn_pglet_server(options.pglet_server_bin());
	return {
		url: server.url,
		engine: 'pglet',
		empty: () => empty_test_database(server.url),
		close: async () => server.kill()
	};
};

/**
 * Take a session advisory lock on `database`'s name through an admin
 * connection to `postgres_url`, returning the connection that holds it.
 *
 * @throws Error when another session holds it — another run of this database
 */
const lock_test_database_name = async (
	postgres_url: string,
	database: string
): Promise<{ end: () => Promise<void> }> => {
	const { default: pg } = await import('pg');
	const client = new pg.Client({ connectionString: postgres_url });
	try {
		await client.connect();
	} catch (error) {
		throw new Error(
			`connect through ${FUZ_TEST_POSTGRES_URL_ENV} (${redact_database_url(postgres_url)}): ` +
				to_error_message(error),
			{ cause: error }
		);
	}
	let locked: boolean;
	try {
		const result = await client.query<{ locked: boolean }>(
			'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
			[database]
		);
		locked = result.rows[0]!.locked;
	} catch (error) {
		await client.end().catch(() => {});
		throw error;
	}
	if (!locked) {
		await client.end().catch(() => {});
		throw new Error(`another run holds ${database} — wait for it, or stop it`);
	}
	return { end: () => client.end() };
};

/**
 * Refuse a backend config built for `database` that doesn't run over it — a
 * config factory that ignores the URL it was given (a hardcoded one left
 * behind) still type-checks, and would run on another database beside an
 * unused one.
 *
 * @param config - the backend's config
 * @param database - the database provisioned for it
 * @throws Error naming the backend when its `DATABASE_URL` is not the database's URL
 */
export const assert_config_on_database = (
	config: Pick<BackendConfig, 'name' | 'env'>,
	database: Pick<TestDatabase, 'url'>
): void => {
	if (config.env.DATABASE_URL !== database.url) {
		throw new Error(
			`backend ${config.name}'s DATABASE_URL is not the database provisioned for it — ` +
				'its config factory must pass on the URL it is given'
		);
	}
};

/**
 * Empty the database at `url` — drop and recreate its `public` schema
 * (`reset_public_schema`), which holds every table the spines migrate. What
 * `TestDatabase.empty` runs, for a test file that has the URL but not the
 * `TestDatabase` (a global setup provides only what serializes).
 *
 * @param url - a `TestDatabase`'s URL
 */
export const empty_test_database = async (url: string): Promise<void> => {
	const { db, close } = await create_db(url);
	try {
		await reset_public_schema(db);
	} finally {
		await close();
	}
};

/** Where `prepare_pglet_server_binary` builds `pglet_server`. */
export interface PgletServerBinaryOptions {
	/**
	 * The Cargo workspace the backend's binary is built in — its lockfile holds
	 * the pglet the Rust spine runs, so the server is the same pglet.
	 */
	readonly workspace_dir: string;
	/** The Cargo profile — the backend binary's, so the pglet library is built once. Default `'dev'`. */
	readonly profile?: string;
	/** A prebuilt binary that wins over the build. Default `$PGLET_SERVER_BIN`. */
	readonly bin_override?: string;
}

/**
 * The `pglet_server` binary a pglet `TestDatabase` spawns: `bin_override`
 * (`$PGLET_SERVER_BIN`) unbuilt when set, else built with
 * `cargo build -p pglet_server --bin pglet_server` in the workspace
 * (`prepare_cargo_binary`, so `FUZ_TESTING_NO_REBUILD=1` skips the build) —
 * a path dependency's binary, which Cargo builds like the workspace's own.
 *
 * @param options - the workspace, profile and override
 * @returns the binary's absolute path
 * @throws Error when the workspace is missing or the build fails
 */
export const prepare_pglet_server_binary = (options: PgletServerBinaryOptions): string => {
	const { workspace_dir, profile, bin_override = process.env[PGLET_SERVER_BIN_ENV] } = options;
	if (bin_override) return bin_override;
	return prepare_cargo_binary({ workspace_dir, package: PGLET_SERVER_CRATE, profile });
};

/** A spawned `pglet_server`: its connection URL and a kill. */
export interface PgletServer {
	readonly url: string;
	/** SIGKILL its process group. Idempotent. */
	readonly kill: () => void;
}

/** How long a spawned `pglet_server` may take to print its listening line (ms). */
const PGLET_SERVER_READY_TIMEOUT_MS = 10_000;

/** The line `pglet_server` prints once it listens, with the address it bound. */
const PGLET_LISTENING_LINE = /^pglet listening on (\S+)$/;

/**
 * Spawn `pglet_server` on a port the kernel picks (`--port 0`), in-memory (its
 * default B+tree store, with real transactions), and resolve once it prints
 * the address it listens on — it listens before printing, so it accepts
 * connections from then on.
 *
 * The server leads a process group of its own and is SIGKILLed with it by
 * `kill()`, and on this process's `exit`, `SIGINT`, `SIGTERM` and `SIGHUP`, so
 * no server outlives the run that spawned it — but a SIGKILLed vitest leaves
 * its servers running, as it leaves its backends.
 *
 * @param bin - the `pglet_server` binary
 * @returns the server
 * @throws Error when it fails to spawn, exits, or prints no listening line in time
 */
export const spawn_pglet_server = (bin: string): Promise<PgletServer> =>
	new Promise((resolve, reject) => {
		const child = spawn(bin, ['--port', '0'], {
			stdio: ['ignore', 'pipe', 'inherit'],
			detached: true
		});
		let killed = false;
		const kill = (): void => {
			if (killed) return;
			killed = true;
			live_pglet_kills.delete(kill);
			try {
				if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
			} catch {
				// already exited
			}
		};
		register_pglet_kill(kill);
		child.unref();
		let settled = false;
		const fail = (message: string, cause?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			kill();
			reject(new Error(`pglet server ${bin}: ${message}`, { cause }));
		};
		const timer = setTimeout(
			() => fail(`printed no listening line in ${PGLET_SERVER_READY_TIMEOUT_MS}ms`),
			PGLET_SERVER_READY_TIMEOUT_MS
		);
		child.once('error', (error) => fail(`failed to spawn: ${error.message}`, error));
		child.once('exit', (code, signal) =>
			fail(`exited before listening (${signal ? `signal ${signal}` : `code ${code}`})`)
		);
		const lines = createInterface({ input: child.stdout });
		lines.on('line', (line) => {
			if (settled) return;
			const address = PGLET_LISTENING_LINE.exec(line)?.[1];
			if (address === undefined) return;
			settled = true;
			clearTimeout(timer);
			// keep draining what it prints, without holding the event loop open
			(child.stdout as Socket).unref();
			resolve({ url: `postgres://pglet@${address}/pglet`, kill });
		});
	});

// The kills of the live servers, fired at process exit and on a terminating
// signal — `exit` alone misses vitest's signal-based worker teardown.
const live_pglet_kills: Set<() => void> = new Set();
let pglet_handlers_installed = false;

const register_pglet_kill = (kill: () => void): void => {
	live_pglet_kills.add(kill);
	if (pglet_handlers_installed) return;
	pglet_handlers_installed = true;
	const kill_all = (): void => {
		for (const k of [...live_pglet_kills]) k();
	};
	process.on('exit', kill_all);
	// kill, then restore the default action and re-raise, so the process still
	// ends by the signal
	const passthrough = (signal: NodeJS.Signals): void => {
		kill_all();
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	};
	process.once('SIGINT', () => passthrough('SIGINT'));
	process.once('SIGTERM', () => passthrough('SIGTERM'));
	process.once('SIGHUP', () => passthrough('SIGHUP'));
};
