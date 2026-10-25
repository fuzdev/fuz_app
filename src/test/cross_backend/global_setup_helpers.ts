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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { bootstrap_backend } from '#lib/testing/cross_backend/bootstrap_backend.ts';
import { serialize_bootstrapped_handle } from '#lib/testing/cross_backend/setup.ts';
import {
	RUST_SPINE_STUB_BIN_ENV,
	RUST_SPINE_STUB_DATABASE_URL_ENV,
	RUST_SPINE_STUB_DEFAULT_DATABASE_URL
} from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import {
	probe_bootstrap_token_file,
	type BootstrapTokenProbeResult
} from './bootstrap_token_probe.ts';
import './cross_test_types.ts';

/**
 * Env var skipping the Rust rebuild, for fast iteration on a known-current
 * binary: `1` or `true` skips it, any other value (`0`, `false`, empty)
 * rebuilds.
 */
export const NO_REBUILD_ENV = 'FUZ_TESTING_NO_REBUILD';

/** The Cargo package the fuz_app Rust projects build and spawn — the Rust spine stub. */
export const RUST_SPINE_STUB_CRATE = 'testing_spine_stub';

/**
 * The Cargo profile the stub is built with — the workspace's `cross-test`:
 * release optimization without LTO, with parallel codegen and incremental
 * compilation, so the rebuild after a spine edit takes seconds rather than a
 * full LTO relink. Its output lands in `cross-test/` under the target directory.
 */
export const RUST_SPINE_STUB_CARGO_PROFILE = 'cross-test';

/**
 * Whether an `NO_REBUILD_ENV` value asks to skip the rebuild — only an
 * explicit `1` / `true`, so `FUZ_TESTING_NO_REBUILD=0` still rebuilds.
 *
 * @param value - the variable's value, `undefined` when unset
 */
export const is_no_rebuild_requested = (value: string | undefined): boolean =>
	value === '1' || value?.toLowerCase() === 'true';

/** Env var pointing at the Cargo workspace where the spine-stub crate lives. */
export const RUST_WORKSPACE_DIR_ENV = 'FUZ_RUST_SPINE_STUB_WORKSPACE_DIR';

/** Options for `rebuild_rust_spine_stub`. */
export interface RustSpineRebuildOptions {
	/** Cargo package to build; also the produced `target/cross-test/<crate>` binary name. */
	readonly crate: string;
	/**
	 * Cargo workspace directory. Defaults to `$FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`,
	 * then `~/dev/private_fuz`. This file is test-only (never shipped in the
	 * package), so the dev-machine default is a convenience, not published
	 * content — CI/operators set the env var.
	 */
	readonly workspace_dir?: string;
}

/** Options for `prepare_rust_spine_backend` and `make_rust_spine_global_setup`. */
export interface RustSpineGlobalSetupOptions extends RustSpineRebuildOptions {
	/**
	 * The Postgres URL the binary connects to. The database it names is created
	 * when missing (idempotent `createdb`), on the server it names. Defaults to
	 * `resolve_rust_spine_stub_database_url()` — the URL
	 * `rust_spine_stub_backend_config` hands the stub. `null` skips database setup.
	 */
	readonly database_url?: string | null;
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
 * `database_url` with its database replaced by `database` — how a project
 * that spawns a backend of its own beside the single-backend stub lands on
 * the same server under a database nothing else uses, so one env var moves
 * every project to another server and no two share a database.
 *
 * @param database_url - a `postgres://` URL on the target server
 * @param database - the database name to put in it
 * @returns the URL naming `database` on the same server
 */
export const with_database_name = (database_url: string, database: string): string => {
	const url = new URL(database_url);
	url.pathname = `/${database}`;
	return url.href;
};

/**
 * The binary `cargo build -p <crate> --profile cross-test` writes, read from
 * `cargo metadata --no-deps --format-version 1` output: under the workspace's
 * resolved `target_directory`, so `CARGO_TARGET_DIR` and `build.target-dir`
 * are honoured.
 *
 * @param metadata_json - the `cargo metadata` output
 * @param crate - the Cargo package, also the binary's name
 * @returns the binary's absolute path
 * @throws Error when the output carries no `target_directory`
 */
export const to_rust_spine_stub_bin_path = (metadata_json: string, crate: string): string => {
	const metadata = JSON.parse(metadata_json) as { target_directory?: unknown };
	if (typeof metadata.target_directory !== 'string' || !metadata.target_directory) {
		throw new Error('`cargo metadata` output has no `target_directory`');
	}
	return join(metadata.target_directory, RUST_SPINE_STUB_CARGO_PROFILE, crate);
};

/**
 * Per-process memo of the built binary paths (keyed by workspace and crate)
 * and of the pins already warned about. On `globalThis` rather than in module
 * scope, so every project's `globalSetup` in one vitest process shares it
 * whether or not they share this module's instance.
 */
interface RustSpineStubMemo {
	readonly bin_paths: Map<string, string>;
	readonly warned_pins: Set<string>;
}

const RUST_SPINE_STUB_MEMO_KEY = '__fuz_app_rust_spine_stub_memo';

const get_memo = (): RustSpineStubMemo => {
	const holder = globalThis as unknown as Record<string, RustSpineStubMemo | undefined>;
	return (holder[RUST_SPINE_STUB_MEMO_KEY] ??= { bin_paths: new Map(), warned_pins: new Set() });
};

/**
 * How long `cargo metadata` may take (ms). Usually well under a second, but
 * the first run in a checkout can have rustup install the pinned toolchain.
 */
const CARGO_METADATA_TIMEOUT_MS = 120_000;

/**
 * Throw naming the workspace and its env var when the workspace directory is
 * missing — a spawn with a missing `cwd` otherwise fails as `spawnSync cargo
 * ENOENT`, which reads as cargo not being installed.
 */
const assert_workspace_dir = (workspace_dir: string): void => {
	if (!existsSync(workspace_dir)) {
		throw new Error(
			`the Rust spine stub's Cargo workspace ${workspace_dir} does not exist — set ` +
				`${RUST_WORKSPACE_DIR_ENV} to the checkout that holds the stub crate`
		);
	}
};

/** The built binary's path, from `cargo metadata` once per process per workspace and crate. */
const resolve_built_bin_path = (workspace_dir: string, crate: string): string => {
	const { bin_paths } = get_memo();
	const key = JSON.stringify([workspace_dir, crate]);
	let path = bin_paths.get(key);
	if (path === undefined) {
		assert_workspace_dir(workspace_dir);
		let metadata_json: string;
		try {
			metadata_json = execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
				cwd: workspace_dir,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'inherit'],
				maxBuffer: 64 * 1024 * 1024,
				timeout: CARGO_METADATA_TIMEOUT_MS
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			throw new Error(
				code === 'ETIMEDOUT'
					? `\`cargo metadata\` in ${workspace_dir} took over ${CARGO_METADATA_TIMEOUT_MS}ms`
					: `\`cargo metadata\` in ${workspace_dir} failed: ${(error as Error).message}`,
				{ cause: error }
			);
		}
		path = to_rust_spine_stub_bin_path(metadata_json, crate);
		bin_paths.set(key, path);
	}
	return path;
};

/**
 * Rebuild the Rust spine binary unless `NO_REBUILD_ENV` asks to skip it, and
 * default the binary-path env the backend config reads to the build's output
 * (`to_rust_spine_stub_bin_path`) when the operator didn't pin one. When they
 * did and a rebuild ran, a pin elsewhere gets a one-line warning: the rebuilt
 * binary is not the one that spawns. Resolving the default runs
 * `cargo metadata`, so `NO_REBUILD_ENV=1` with no pinned binary still needs
 * cargo on PATH.
 *
 * Runs at most one build at a time without any lock: vitest awaits each
 * project's `globalSetup` in turn and the build is synchronous, so one
 * invocation selecting several Rust-backed projects builds, then finds the
 * build current. `npm run test:cross` (`run_cross.ts`) calls this once before
 * its concurrent invocations and hands each `NO_REBUILD_ENV=1` and the path.
 */
export const rebuild_rust_spine_stub = (options: RustSpineRebuildOptions): void => {
	const workspace_dir = resolve_workspace_dir(options.workspace_dir);
	const rebuild = !is_no_rebuild_requested(process.env[NO_REBUILD_ENV]);

	if (rebuild) {
		assert_workspace_dir(workspace_dir);
		// `stdio: 'inherit'` surfaces build output; a failed build throws and
		// fails the project loudly (the point — never spawn a stale binary).
		execFileSync(
			'cargo',
			['build', '-p', options.crate, '--profile', RUST_SPINE_STUB_CARGO_PROFILE],
			{
				cwd: workspace_dir,
				stdio: 'inherit'
			}
		);
	}

	const pinned = process.env[RUST_SPINE_STUB_BIN_ENV];
	if (pinned == null) {
		process.env[RUST_SPINE_STUB_BIN_ENV] = resolve_built_bin_path(workspace_dir, options.crate);
		return;
	}
	if (!rebuild) return;
	const built = resolve_built_bin_path(workspace_dir, options.crate);
	const { warned_pins } = get_memo();
	if (resolve(pinned) !== built && !warned_pins.has(pinned)) {
		warned_pins.add(pinned);
		console.warn(
			`${RUST_SPINE_STUB_BIN_ENV} pins ${pinned}, so the binary just rebuilt at ${built} ` +
				`is not the one spawned`
		);
	}
};

/**
 * Make the Rust spine binary current before it spawns — rebuild by
 * default (`rebuild_rust_spine_stub`), fold in `createdb`, and default the
 * binary-path env so the common path is one command
 * (`npm run test:cross:rust-spine-stub`).
 *
 * The database created is the one the binary's URL names, on the server that
 * URL names — so `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` alone moves the
 * run to another server or another database.
 *
 * Rationale: a stale prebuilt binary fails every cell/RPC case with
 * `method not found` while auth cases pass, so a lagging build reads as a
 * regression rather than "rebuild me". `cargo build` is incremental, so an
 * unconditional rebuild is cheap when nothing changed. Set `NO_REBUILD_ENV`
 * to `1` to skip the rebuild for fast iteration on a known-current binary.
 *
 * Lives in the runner wiring (test-only, Rust-aware), not the shipped
 * `src/lib` harness, which stays Rust-agnostic.
 */
export const prepare_rust_spine_backend = (options: RustSpineGlobalSetupOptions): void => {
	rebuild_rust_spine_stub(options);

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
export const to_maintenance_database_url = (server_url: string): string =>
	with_database_name(server_url, 'postgres');

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
 * In the window before the keeper bootstrap it runs the bootstrap token-file
 * probe (`bootstrap_token_probe.ts`) and provides its results as
 * `bootstrap_token_probe`.
 *
 * `config_factory` is invoked lazily (inside setup) so a config that throws
 * when its prerequisites are missing (e.g. `rust_spine_stub_backend_config`
 * without `FUZ_TESTING_RUST_SPINE_STUB_BIN`) only fails the project that uses it.
 */
export const make_spine_global_setup =
	(config_factory: () => BackendConfig) =>
	async (project: TestProject): Promise<() => Promise<void>> => {
		const config = config_factory();
		let probe: Array<BootstrapTokenProbeResult> = [];
		const bootstrapped = await bootstrap_backend(config, {
			before_bootstrap: async (c) => {
				probe = await probe_bootstrap_token_file(c);
			}
		});
		project.provide('bootstrap_token_probe', probe);
		// vitest 4's `provide` hard-rejects non-serializable values, so strip the
		// live `child` / `teardown` / `keeper_transport`; test files rebuild a
		// usable handle via `reconstruct_bootstrapped_handle`.
		project.provide('backend_handle', serialize_bootstrapped_handle(bootstrapped));
		return async () => {
			await bootstrapped.teardown();
		};
	};
