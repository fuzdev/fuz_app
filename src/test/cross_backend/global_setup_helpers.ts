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

import type { BackendConfig } from '$lib/testing/cross_backend/backend_config.ts';
import { bootstrap_backend } from '$lib/testing/cross_backend/bootstrap_backend.ts';
import { serialize_bootstrapped_handle } from '$lib/testing/cross_backend/setup.ts';
import { RUST_SPINE_STUB_BIN_ENV } from '$lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import './cross_test_types.ts';

/** Env var skipping the Rust rebuild (set to any value for fast iteration on a known-current binary). */
export const NO_REBUILD_ENV = 'FUZ_TESTING_NO_REBUILD';

/** Env var pointing at the Cargo workspace where the spine-stub crate lives. */
export const RUST_WORKSPACE_DIR_ENV = 'FUZ_RUST_SPINE_STUB_WORKSPACE_DIR';

/** Options for `make_rust_spine_global_setup`. */
export interface RustSpineGlobalSetupOptions {
	/** Cargo package to build; also the produced `target/release/<crate>` binary name. */
	readonly crate: string;
	/** Postgres database to ensure exists (idempotent `createdb`). Omit to skip DB setup. */
	readonly database?: string;
	/**
	 * Cargo workspace directory. Defaults to `$FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`,
	 * then `~/dev/private_fuz`. This file is test-only (never shipped in the
	 * package), so the dev-machine default is a convenience, not published
	 * content — CI/operators set the env var.
	 */
	readonly workspace_dir?: string;
}

const resolve_workspace_dir = (override: string | undefined): string =>
	override ?? process.env[RUST_WORKSPACE_DIR_ENV] ?? join(homedir(), 'dev', 'private_fuz');

/**
 * Make the Rust spine binary current before it spawns — rebuild by
 * default, fold in `createdb`, and default the binary-path env so the
 * common path is one command (`npm run test:cross:rust-spine-stub`).
 *
 * Rationale: a stale prebuilt binary fails every cell/RPC case with
 * `method not found` while auth cases pass, so a lagging build reads as a
 * regression rather than "rebuild me". `cargo build` is incremental, so an
 * unconditional rebuild is cheap when nothing changed. Set `NO_REBUILD_ENV`
 * to skip the rebuild for fast iteration on a known-current binary.
 *
 * Lives in the runner wiring (test-only, Rust-aware), not the shipped
 * `$lib` harness, which stays Rust-agnostic.
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

	if (options.database != null) {
		// Idempotent: `createdb` errors when the DB already exists — ignore.
		// The harness never issues `CREATE DATABASE` itself (avoids forcing a
		// `CREATEDB` grant on the test role); this is the runner doing it once.
		try {
			execFileSync('createdb', [options.database], { stdio: 'ignore' });
		} catch {
			// already exists (or no `createdb` on PATH) — let spawn surface a
			// real connection error if the DB is genuinely missing.
		}
	}
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
