/**
 * Shared `globalSetup` maker for the cross-process self-test projects.
 *
 * Each `cross_backend_*` vitest project points at a one-line `global_setup_*.ts`
 * that calls `make_spine_global_setup` with its backend config factory.
 * The maker spawns + bootstraps the backend and `provide`s a serializable
 * handle (`*.cross.test.ts` files rebuild it via
 * `reconstruct_bootstrapped_handle`).
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { bootstrap_backend } from '#lib/testing/cross_backend/bootstrap_backend.ts';
import { serialize_bootstrapped_handle } from '#lib/testing/cross_backend/setup.ts';
import {
	RUST_SPINE_STUB_BIN_ENV,
	RUST_SPINE_STUB_DATABASE_URL_ENV,
	RUST_SPINE_STUB_DEFAULT_DATABASE_URL
} from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import './cross_test_types.ts';

/** Env var skipping the Rust rebuild (set to any value for fast iteration on a known-current binary). */
export const NO_REBUILD_ENV = 'FUZ_TESTING_NO_REBUILD';

/** Env var pointing at the Cargo workspace where the spine-stub crate lives. */
export const RUST_WORKSPACE_DIR_ENV = 'FUZ_RUST_SPINE_STUB_WORKSPACE_DIR';

/** Options for `make_rust_spine_global_setup`. */
export interface RustSpineGlobalSetupOptions {
	/** Cargo package to build; also the produced `target/release/<crate>` binary name. */
	readonly crate: string;
	/**
	 * The Postgres URL the binary connects to. The database it names is created
	 * when missing (idempotent `createdb`), on the server it names. Defaults to
	 * `resolve_rust_spine_stub_database_url()` — the URL
	 * `rust_spine_stub_backend_config` hands the stub. `null` skips database setup.
	 */
	readonly database_url?: string | null;
	/**
	 * Cargo workspace directory. Defaults to `$FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`,
	 * then `~/dev/private_fuz`. This file is test-only (never shipped in the
	 * package), so the dev-machine default is a convenience, not published
	 * content — CI/operators set the env var.
	 */
	readonly workspace_dir?: string;
}

/** The URL protocols a Postgres connection string carries. */
const POSTGRES_URL_PROTOCOLS: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);

const resolve_workspace_dir = (override: string | undefined): string =>
	override ?? process.env[RUST_WORKSPACE_DIR_ENV] ?? join(homedir(), 'dev', 'private_fuz');

/**
 * The Postgres URL the Rust stub connects to, as `rust_spine_stub_backend_config`
 * resolves it: `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` when set, else the
 * local default.
 *
 * @returns the URL, known to parse as a `postgres:` / `postgresql:` URL
 * @throws Error when the env var is set to something that is not a Postgres
 * URL — named by its variable, and without echoing a value that may hold a
 * password
 */
export const resolve_rust_spine_stub_database_url = (): string => {
	const from_env = process.env[RUST_SPINE_STUB_DATABASE_URL_ENV];
	if (!from_env) return RUST_SPINE_STUB_DEFAULT_DATABASE_URL;
	// `URL.canParse` alone admits a scheme-less `localhost:5432/db`, which it
	// reads as protocol `localhost:` — the stub then refuses it as no
	// connection string at all
	if (!URL.canParse(from_env) || !POSTGRES_URL_PROTOCOLS.has(new URL(from_env).protocol)) {
		throw new Error(
			`${RUST_SPINE_STUB_DATABASE_URL_ENV} is not a valid URL — expected the form ` +
				`postgres://user@host:port/database`
		);
	}
	return from_env;
};

/**
 * Make the Rust spine binary current before it spawns — rebuild by
 * default, fold in `createdb`, and default the binary-path env so the
 * common path is one command (`npm run test:cross:rust-spine-stub`).
 *
 * The database created is the one the binary's URL names, on the server that
 * URL names — so `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` alone moves the
 * run to another server or another database.
 *
 * Rationale: a stale prebuilt binary fails every cell/RPC case with
 * `method not found` while auth cases pass, so a lagging build reads as a
 * regression rather than "rebuild me". `cargo build` is incremental, so an
 * unconditional rebuild is cheap when nothing changed. Set `NO_REBUILD_ENV`
 * to skip the rebuild for fast iteration on a known-current binary.
 *
 * Lives in the runner wiring (test-only, Rust-aware), not the shipped
 * `src/lib` harness, which stays Rust-agnostic.
 */
export const prepare_rust_spine_backend = (options: RustSpineGlobalSetupOptions): void => {
	const workspace_dir = resolve_workspace_dir(options.workspace_dir);

	if (process.env[NO_REBUILD_ENV] == null) {
		// `stdio: 'inherit'` surfaces build output; a failed build throws and
		// fails the project loudly (the point — never spawn a stale binary).
		execFileSync('cargo', ['build', '-p', options.crate, '--release'], {
			cwd: workspace_dir,
			stdio: 'inherit'
		});
	}

	// Default the binary path the config reads, when the operator didn't pin one.
	if (process.env[RUST_SPINE_STUB_BIN_ENV] == null) {
		process.env[RUST_SPINE_STUB_BIN_ENV] = join(workspace_dir, 'target', 'release', options.crate);
	}

	const database_url =
		options.database_url === undefined
			? resolve_rust_spine_stub_database_url()
			: options.database_url;
	if (database_url !== null) {
		// the stub connects to the database its URL names, so that is the one to
		// ensure; a URL naming none leaves the choice to the server, and nothing
		// here knows what to create
		const database = decodeURIComponent(new URL(database_url).pathname.slice(1));
		if (database) ensure_database(database, database_url);
	}
};

/**
 * Create a Postgres database when it is missing, with `createdb`.
 *
 * Which server it lands on depends on `server_url`. Given one, the database is
 * created on the server that URL names: `createdb` connects through the URL
 * with its database swapped for the `postgres` maintenance database, so host,
 * port, role and query parameters all come from the URL. Without one,
 * `createdb` reads the libpq environment (`PGHOST` / `PGPORT` / `PGUSER`), and
 * the caller is responsible for that environment naming the server its URL
 * does.
 *
 * Idempotent and silent: `createdb` errors when the database already exists,
 * and that error is ignored along with every other (no `createdb` on PATH, no
 * server, a role that may not create databases) — whatever connects next
 * reports a database that is really missing. The shipped harness never issues
 * `CREATE DATABASE` itself (avoids forcing a `CREATEDB` grant on the test
 * role); this is the runner doing it once.
 *
 * @param database - the database name
 * @param server_url - a `postgres://` URL on the server to create it on; its database name is ignored
 */
export const ensure_database = (database: string, server_url?: string): void => {
	const args = [database];
	const env = { ...process.env };
	if (server_url !== undefined) {
		const url = new URL(to_maintenance_database_url(server_url));
		// a password goes to `createdb` in its environment, not its arguments,
		// which any local user can read from the process list
		const password = url.searchParams.get('password') ?? decodeURIComponent(url.password);
		if (password) env.PGPASSWORD = password;
		url.password = '';
		url.searchParams.delete('password');
		args.unshift(`--maintenance-db=${url.href}`);
	}
	try {
		execFileSync('createdb', args, { stdio: 'ignore', env });
	} catch {
		// already exists, or it could not be created — see the doc above
	}
};

/**
 * The URL `createdb` connects through to create a database on the server
 * `server_url` names — the same URL with its database replaced by `postgres`.
 *
 * @param server_url - a `postgres://` URL on the target server
 * @returns the URL of that server's `postgres` maintenance database
 */
export const to_maintenance_database_url = (server_url: string): string => {
	const url = new URL(server_url);
	url.pathname = '/postgres';
	return url.href;
};

/**
 * Like `make_spine_global_setup`, but first makes the Rust spine
 * binary current (rebuild + `createdb` + binary-path default) via
 * `prepare_rust_spine_backend`. Use for the `cross_backend_rust_spine_stub`
 * project; the TS-spine projects need no rebuild.
 */
export const make_rust_spine_global_setup =
	(config_factory: () => BackendConfig, options: RustSpineGlobalSetupOptions) =>
	(project: TestProject): Promise<() => Promise<void>> => {
		prepare_rust_spine_backend(options);
		// Delegate to the standard maker — `config_factory` reads the now-set
		// binary-path env when it runs inside.
		return make_spine_global_setup(config_factory)(project);
	};

/**
 * Build a vitest `globalSetup` default export that spawns + bootstraps the
 * backend produced by `config_factory` and provides the serialized handle.
 *
 * `config_factory` is invoked lazily (inside setup) so a config that throws
 * when its prerequisites are missing (e.g. `rust_spine_stub_backend_config`
 * without `FUZ_TESTING_RUST_SPINE_STUB_BIN`) only fails the project that uses it.
 */
export const make_spine_global_setup =
	(config_factory: () => BackendConfig) =>
	async (project: TestProject): Promise<() => Promise<void>> => {
		const config = config_factory();
		const bootstrapped = await bootstrap_backend(config);
		// vitest 4's `provide` hard-rejects non-serializable values, so strip the
		// live `child` / `teardown` / `keeper_transport`; test files rebuild a
		// usable handle via `reconstruct_bootstrapped_handle`.
		project.provide('backend_handle', serialize_bootstrapped_handle(bootstrapped));
		return async () => {
			await bootstrapped.teardown();
		};
	};
