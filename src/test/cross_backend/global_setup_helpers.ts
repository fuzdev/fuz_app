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
import {
	ensure_database_for_url,
	is_postgres_url
} from '#lib/testing/cross_backend/postgres_database.ts';
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
	if (!is_postgres_url(from_env)) {
		throw new Error(
			`${RUST_SPINE_STUB_DATABASE_URL_ENV} is not a valid URL — expected the form ` +
				`postgres://user@host:port/database`
		);
	}
	return from_env;
};

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
	const workspace_dir = resolve_workspace_dir(options.workspace_dir);
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
	// the stub connects to the database its URL names, so that is the one to
	// ensure; a URL naming none leaves the choice to the server
	if (database_url !== null) ensure_database_for_url(database_url);
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
