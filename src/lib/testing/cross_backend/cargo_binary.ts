import '../assert_dev_env.ts';

/**
 * Cargo-built test binaries for cross-backend projects — build before the
 * spawn, then spawn the binary itself.
 *
 * A config that spawns `cargo run` builds inside `spawn_backend`'s health
 * window, so a cold build can outlast the startup timeout, and the build's
 * output is held in the spawn's stderr tail rather than shown.
 * `prepare_cargo_binary` runs the build first, with its output inherited, as a
 * pre-spawn hook (`create_cross_backend_global_setup`'s `before_spawn`), and
 * the config's `start_command` names the built binary
 * (`resolve_cargo_binary_path`), so the spawn starts at once.
 *
 * The binary's path comes from `cargo metadata`: under the workspace's
 * resolved `target_directory`, so `CARGO_TARGET_DIR` and `build.target-dir`
 * are honoured, in the profile's output directory.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Env var skipping the build, for iteration on a known-current binary: `1` or
 * `true` skips it, any other value (`0`, `false`, empty) builds.
 */
export const NO_REBUILD_ENV = 'FUZ_TESTING_NO_REBUILD';

/**
 * Whether an `NO_REBUILD_ENV` value asks to skip the build — only an explicit
 * `1` / `true`, so `FUZ_TESTING_NO_REBUILD=0` still builds.
 *
 * @param value - the variable's value, `undefined` when unset
 */
export const is_no_rebuild_requested = (value: string | undefined): boolean =>
	value === '1' || value?.toLowerCase() === 'true';

/** Options naming one Cargo-built binary. */
export interface CargoBinaryOptions {
	/** The Cargo workspace (or package) directory the build runs in. */
	readonly workspace_dir: string;
	/** The Cargo package holding the binary (`cargo build -p`). */
	readonly package: string;
	/** The binary target (`cargo build --bin`). Default the package name. */
	readonly bin?: string;
	/** The Cargo profile. Default `'dev'`, whose output is `debug/`. */
	readonly profile?: string;
}

/**
 * The directory under the target directory a profile's output lands in —
 * `debug` for `dev`, the profile's own name otherwise (`release`, a custom
 * `cross-test`).
 *
 * @param profile - the Cargo profile
 */
export const to_cargo_profile_dir = (profile: string): string =>
	profile === 'dev' ? 'debug' : profile;

/**
 * The binary path `cargo build --profile <profile> --bin <bin>` writes, from
 * `cargo metadata --no-deps --format-version 1` output.
 *
 * @param metadata_json - the `cargo metadata` output
 * @param bin - the binary's name
 * @param profile - the Cargo profile
 * @returns the binary's absolute path
 * @throws Error when the output carries no `target_directory`
 */
export const to_cargo_binary_path = (
	metadata_json: string,
	bin: string,
	profile: string
): string => {
	const metadata = JSON.parse(metadata_json) as { target_directory?: unknown };
	if (typeof metadata.target_directory !== 'string' || !metadata.target_directory) {
		throw new Error('`cargo metadata` output has no `target_directory`');
	}
	return join(metadata.target_directory, to_cargo_profile_dir(profile), bin);
};

/**
 * Per-process memo of each workspace's target directory metadata. On
 * `globalThis` rather than in module scope, so every project's `globalSetup` in
 * one vitest process shares it whether or not they share this module's
 * instance.
 */
const CARGO_METADATA_MEMO_KEY = '__fuz_app_cargo_metadata_memo';

const get_metadata_memo = (): Map<string, string> => {
	const holder = globalThis as unknown as Record<string, Map<string, string> | undefined>;
	return (holder[CARGO_METADATA_MEMO_KEY] ??= new Map());
};

/**
 * How long `cargo metadata` may take (ms). Usually well under a second, but
 * the first run in a checkout can have rustup install the pinned toolchain.
 */
const CARGO_METADATA_TIMEOUT_MS = 120_000;

/**
 * Throw naming the workspace when its directory is missing — a spawn with a
 * missing `cwd` otherwise fails as `spawnSync cargo ENOENT`, which reads as
 * cargo not being installed.
 */
const assert_workspace_dir = (workspace_dir: string): void => {
	if (!existsSync(workspace_dir)) {
		throw new Error(`the Cargo workspace ${workspace_dir} does not exist`);
	}
};

const read_cargo_metadata = (workspace_dir: string): string => {
	const memo = get_metadata_memo();
	let metadata_json = memo.get(workspace_dir);
	if (metadata_json === undefined) {
		assert_workspace_dir(workspace_dir);
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
		memo.set(workspace_dir, metadata_json);
	}
	return metadata_json;
};

/**
 * The path of a Cargo-built binary, without building it — what a config's
 * `start_command` names. Runs `cargo metadata` once per process per workspace,
 * so it needs cargo on PATH.
 *
 * @param options - the workspace, package, binary and profile
 * @returns the binary's absolute path
 * @throws Error when the workspace is missing or `cargo metadata` fails
 */
export const resolve_cargo_binary_path = (options: CargoBinaryOptions): string => {
	const { workspace_dir, package: pkg, bin = pkg, profile = 'dev' } = options;
	return to_cargo_binary_path(read_cargo_metadata(workspace_dir), bin, profile);
};

/**
 * Build a Cargo binary before its backend spawns, unless `NO_REBUILD_ENV`
 * asks to skip it, and return its path. The build's output is inherited, so a
 * cold build shows its progress, and a failed build throws — the project fails
 * loudly rather than spawning a stale binary. `cargo build` is incremental, so
 * a build with nothing changed is quick.
 *
 * Synchronous: vitest awaits each project's `globalSetup` in turn, so one
 * invocation selecting several projects builds once, then finds the build
 * current.
 *
 * @param options - the workspace, package, binary and profile
 * @returns the binary's absolute path (`resolve_cargo_binary_path`)
 * @throws Error when the workspace is missing, the build fails, or `cargo metadata` fails
 */
export const prepare_cargo_binary = (options: CargoBinaryOptions): string => {
	const { workspace_dir, package: pkg, bin = pkg, profile = 'dev' } = options;
	if (!is_no_rebuild_requested(process.env[NO_REBUILD_ENV])) {
		assert_workspace_dir(workspace_dir);
		execFileSync('cargo', ['build', '-p', pkg, '--bin', bin, '--profile', profile], {
			cwd: workspace_dir,
			stdio: 'inherit'
		});
	}
	return resolve_cargo_binary_path(options);
};
