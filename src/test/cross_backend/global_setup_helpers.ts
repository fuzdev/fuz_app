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

import { existsSync } from 'node:fs';
import process from 'node:process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { bootstrap_backend } from '#lib/testing/cross_backend/bootstrap_backend.ts';
import {
	is_no_rebuild_requested,
	NO_REBUILD_ENV,
	prepare_cargo_binary
} from '#lib/testing/cross_backend/cargo_binary.ts';
import { serialize_bootstrapped_handle } from '#lib/testing/cross_backend/setup.ts';
import { RUST_SPINE_STUB_BIN_ENV } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import {
	open_test_database,
	prepare_pglet_server_binary,
	type PgletServerBinaryOptions,
	type TestDatabase
} from '#lib/testing/cross_backend/test_database.ts';
import { FUZ_TEST_POSTGRES_URL_ENV } from '#lib/testing/db.ts';

import { with_backend_log_allowances } from '#lib/testing/cross_backend/backend_log.ts';

import {
	BOOTSTRAP_TOKEN_PROBE_BACKEND_ERRORS,
	probe_bootstrap_token_file,
	token_file_gone,
	type BootstrapTokenProbe
} from './bootstrap_token_probe.ts';
import './cross_test_types.ts';

/** The Cargo package the fuz_app Rust projects build and spawn — the Rust spine stub. */
export const RUST_SPINE_STUB_CRATE = 'testing_spine_stub';

/**
 * The Cargo profile the stub is built with — the workspace's `cross-test`:
 * release optimization without LTO, with parallel codegen and incremental
 * compilation, so the rebuild after a spine edit takes seconds rather than a
 * full LTO relink. Its output lands in `cross-test/` under the target directory.
 */
export const RUST_SPINE_STUB_CARGO_PROFILE = 'cross-test';

/** Env var pointing at the Cargo workspace where the spine-stub crate lives. */
export const RUST_WORKSPACE_DIR_ENV = 'FUZ_RUST_SPINE_STUB_WORKSPACE_DIR';

/** Options for `rebuild_rust_spine_stub`. */
export interface RustSpineRebuildOptions {
	/** Cargo package to build; also the produced `target/cross-test/<crate>` binary name. */
	readonly crate: string;
	/**
	 * Cargo workspace directory. Defaults to `$FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`,
	 * then a `fuz` checkout beside this one (`~/dev/fuz`), a dev-machine
	 * convenience — CI/operators set the env var.
	 */
	readonly workspace_dir?: string;
}

/** Options for `make_rust_spine_global_setup`. */
export interface RustSpineGlobalSetupOptions extends RustSpineRebuildOptions {
	/** Names the stub's database (`open_rust_spine_database`). */
	readonly database: string;
}

/**
 * The Cargo workspace the Rust spine stub is built from:
 * `$FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`, else a `fuz` checkout beside this one
 * (`~/dev/fuz`).
 *
 * @param override - a workspace directory that takes precedence over both
 */
export const resolve_rust_spine_stub_workspace_dir = (override?: string): string =>
	override ?? process.env[RUST_WORKSPACE_DIR_ENV] ?? join(homedir(), 'dev', 'fuz');

/**
 * Where the Rust stub's `pglet_server` is built: the stub's own Cargo
 * workspace and profile, so the pglet library the stub links is built once.
 */
export const to_rust_spine_pglet_server = (workspace_dir?: string): PgletServerBinaryOptions => ({
	workspace_dir: resolve_rust_spine_stub_workspace_dir(workspace_dir),
	profile: RUST_SPINE_STUB_CARGO_PROFILE
});

/** Options for `open_rust_spine_database`. */
export interface OpenRustSpineDatabaseOptions {
	/**
	 * Whether the database must be PostgreSQL — a gate pglet can't answer. Unset
	 * `FUZ_TEST_POSTGRES_URL` then fails the setup naming the variable.
	 */
	readonly postgres_only?: boolean;
	/** The stub's Cargo workspace, as `RustSpineRebuildOptions.workspace_dir`. */
	readonly workspace_dir?: string;
}

/**
 * Open a database for a backend of fuz_app's cross projects
 * (`open_test_database`): a `pglet_server` built in the stub's workspace, or
 * under `FUZ_TEST_POSTGRES_URL` a PostgreSQL database of its own.
 *
 * @param name - the database's name (`CROSS_PROJECT_RESOURCES`' `database`)
 * @param options - whether it must be PostgreSQL, and the stub's workspace
 * @returns the database; close it after the backends' teardown
 */
export const open_rust_spine_database = (
	name: string,
	options: OpenRustSpineDatabaseOptions = {}
): Promise<TestDatabase> =>
	open_test_database({
		name,
		postgres_url: process.env[FUZ_TEST_POSTGRES_URL_ENV],
		pglet_server_bin: options.postgres_only
			? null
			: () => prepare_pglet_server_binary(to_rust_spine_pglet_server(options.workspace_dir))
	});

/** Pins `rebuild_rust_spine_stub` already warned about, shared across one vitest process. */
const WARNED_PINS_KEY = '__fuz_app_rust_spine_stub_warned_pins';

const get_warned_pins = (): Set<string> => {
	const holder = globalThis as unknown as Record<string, Set<string> | undefined>;
	return (holder[WARNED_PINS_KEY] ??= new Set());
};

/**
 * Throw naming the workspace and its env var when the workspace directory is
 * missing, before cargo is asked to run there.
 */
const assert_workspace_dir = (workspace_dir: string): void => {
	if (!existsSync(workspace_dir)) {
		throw new Error(
			`the Rust spine stub's Cargo workspace ${workspace_dir} does not exist — set ` +
				`${RUST_WORKSPACE_DIR_ENV} to the checkout that holds the stub crate`
		);
	}
};

/**
 * Rebuild the Rust spine binary unless `NO_REBUILD_ENV` asks to skip it
 * (`prepare_cargo_binary`, in the `cross-test` profile), and default the
 * binary-path env the backend config reads to the build's output when the
 * operator didn't pin one. When they did and a rebuild ran, a pin elsewhere
 * gets a one-line warning: the rebuilt binary is not the one that spawns.
 * Resolving the path runs `cargo metadata`, so `NO_REBUILD_ENV=1` with no
 * pinned binary still needs cargo on PATH.
 *
 * Runs at most one build at a time without any lock: vitest awaits each
 * project's `globalSetup` in turn and the build is synchronous, so one
 * invocation selecting several Rust-backed projects builds, then finds the
 * build current. `npm run test:cross` (`run_cross.ts`) calls this once before
 * its concurrent invocations and hands each `NO_REBUILD_ENV=1` and the path.
 */
export const rebuild_rust_spine_stub = (options: RustSpineRebuildOptions): void => {
	const rebuild = !is_no_rebuild_requested(process.env[NO_REBUILD_ENV]);
	const pinned = process.env[RUST_SPINE_STUB_BIN_ENV];
	// a pinned binary and no rebuild: nothing to build or resolve
	if (pinned != null && !rebuild) return;
	const workspace_dir = resolve_rust_spine_stub_workspace_dir(options.workspace_dir);
	assert_workspace_dir(workspace_dir);
	const built = prepare_cargo_binary({
		workspace_dir,
		package: options.crate,
		profile: RUST_SPINE_STUB_CARGO_PROFILE
	});
	if (pinned == null) {
		process.env[RUST_SPINE_STUB_BIN_ENV] = built;
		return;
	}
	const warned_pins = get_warned_pins();
	if (resolve(pinned) !== built && !warned_pins.has(pinned)) {
		warned_pins.add(pinned);
		console.warn(
			`${RUST_SPINE_STUB_BIN_ENV} pins ${pinned}, so the binary just rebuilt at ${built} ` +
				`is not the one spawned`
		);
	}
};

/**
 * Like `make_spine_global_setup`, but first makes the Rust spine binary
 * current (`rebuild_rust_spine_stub`) and opens its database
 * (`open_rust_spine_database`), whose URL `config_factory` gets; the
 * teardown closes the database after the backend's. Use for the
 * `cross_backend_rust_spine_stub` project; the TS-spine projects need no
 * rebuild and run on `memory://`.
 *
 * Rationale for the rebuild: a stale prebuilt binary fails every cell/RPC
 * case with `method not found` while auth cases pass, so a lagging build
 * reads as a regression rather than "rebuild me". `cargo build` is
 * incremental, so an unconditional rebuild is cheap when nothing changed. Set
 * `NO_REBUILD_ENV` to `1` to skip it for fast iteration on a known-current
 * binary.
 *
 * Lives in the runner wiring (test-only, Rust-aware), not the shipped
 * `src/lib` harness, which stays Rust-agnostic.
 */
export const make_rust_spine_global_setup =
	(config_factory: (database_url: string) => BackendConfig, options: RustSpineGlobalSetupOptions) =>
	(project: TestProject): Promise<() => Promise<void>> =>
		with_legible_setup_failure('rust spine', async () => {
			rebuild_rust_spine_stub(options);
			const database = await open_rust_spine_database(options.database, options);
			let teardown: () => Promise<void>;
			try {
				// `config_factory` reads the binary-path env the rebuild just set
				teardown = await make_spine_global_setup(() => config_factory(database.url))(project);
			} catch (error) {
				await database.close().catch((close_error: unknown) => console.error(close_error));
				throw error;
			}
			return async () => {
				try {
					await teardown();
				} finally {
					await database.close();
				}
			};
		})();

/**
 * Build a vitest `globalSetup` default export that spawns + bootstraps the
 * backend produced by `config_factory` and provides the serialized handle.
 * In the window before the keeper bootstrap it runs the bootstrap token-file
 * probe (`bootstrap_token_probe.ts`), and after it checks the token file is
 * gone, providing both as `bootstrap_token_probe`; the errors the probe makes
 * the backend log are allowed in its log (`BOOTSTRAP_TOKEN_PROBE_BACKEND_ERRORS`).
 *
 * `config_factory` is invoked lazily (inside setup) so a config that throws
 * when its prerequisites are missing (e.g. `rust_spine_stub_backend_config`
 * without `FUZ_TESTING_RUST_SPINE_STUB_BIN`) only fails the project that uses it.
 */
export const make_spine_global_setup =
	(config_factory: () => BackendConfig) =>
	(project: TestProject): Promise<() => Promise<void>> =>
		with_legible_setup_failure('spine', spine_global_setup)(config_factory, project);

const spine_global_setup = async (
	config_factory: () => BackendConfig,
	project: TestProject
): Promise<() => Promise<void>> => {
	const config = with_backend_log_allowances(
		config_factory(),
		BOOTSTRAP_TOKEN_PROBE_BACKEND_ERRORS
	);
	const probed: { result?: Awaited<ReturnType<typeof probe_bootstrap_token_file>> } = {};
	const bootstrapped = await bootstrap_backend(config, {
		before_bootstrap: async (c) => {
			probed.result = await probe_bootstrap_token_file(c);
		}
	});
	if (!probed.result) throw new Error('the bootstrap token probe did not run');
	const probe: BootstrapTokenProbe = {
		...probed.result,
		token_file_gone_after_bootstrap: await token_file_gone(config.bootstrap.token_path)
	};
	project.provide('bootstrap_token_probe', probe);
	// vitest 4's `provide` hard-rejects non-serializable values, so strip the
	// live `child` / `teardown` / `keeper_transport`; test files rebuild a
	// usable handle via `reconstruct_bootstrapped_handle`.
	project.provide('backend_handle', serialize_bootstrapped_handle(bootstrapped));
	return async () => {
		await bootstrapped.teardown();
	};
};

/** An error's message and its `cause` chain, one per line. */
const format_error_chain = (err: unknown): string => {
	const lines: Array<string> = [];
	let current: unknown = err;
	while (current !== undefined && lines.length < 8) {
		lines.push(current instanceof Error ? current.message : JSON.stringify(current));
		current = current instanceof Error ? current.cause : undefined;
	}
	return lines.join('\n  caused by: ');
};

/**
 * Wrap a global setup so a failure says what failed. Vitest prints a global
 * setup's thrown error by mapping its stack through vite's module runner,
 * which throws on the setup module's frames (`code.charCodeAt is not a
 * function`, then "No test files found") and hides the error itself. The
 * wrapper writes the error and its cause chain to stderr, then rethrows it as
 * a plain `Error` carrying that text and no frames to map.
 *
 * @param label - names the setup in the message
 * @param setup - the global setup to wrap
 * @returns the setup, its failures legible
 */
export const with_legible_setup_failure =
	<A extends Array<unknown>, R>(label: string, setup: (...args: A) => Promise<R>) =>
	async (...args: A): Promise<R> => {
		try {
			return await setup(...args);
		} catch (err) {
			const message = `${label} global setup failed: ${format_error_chain(err)}`;
			process.stderr.write(`${message}\n`);
			const legible = new Error(message);
			legible.stack = message;
			throw legible;
		}
	};
