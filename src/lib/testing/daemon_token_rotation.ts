import './assert_dev_env.ts';

/**
 * Daemon-token **producer** — rotation + file persistence, test-harness only.
 *
 * No production assembly mints daemon tokens: the credential's only remaining
 * role is the cross-process test harness's keeper channel (`_testing_reset`
 * etc.), so the producer lives here behind `assert_dev_env` where it cannot
 * reach a production bundle. The *consumer* half — validating a presented
 * `X-Daemon-Token` — stays in `auth/daemon_token_middleware.ts`, mirroring
 * the Rust spine, whose producer is confined to `fuz_testing`.
 *
 * The token file is written atomically at mode `0600` via
 * `write_file_atomic` (unique temp name + exclusive create), so it never
 * exists group/other-readable — the old optional-`chmod` pattern let a
 * default umask land it at `0644`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { EnvDeps, FsWriteDeps, FsRemoveDeps } from '../runtime/deps.ts';
import { write_file_atomic } from '../runtime/fs.ts';
import { get_app_dir } from '../cli/config.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { generate_daemon_token, type DaemonTokenState } from '../auth/daemon_token.ts';
import { resolve_keeper_account_id } from '../auth/daemon_token_middleware.ts';

/** Default rotation interval in milliseconds (30 seconds). */
export const DEFAULT_ROTATION_INTERVAL_MS = 30_000;

/** Deps for writing the daemon token to disk. */
export type DaemonTokenWriteDeps = Pick<EnvDeps, 'env_get'> &
	Pick<FsWriteDeps, 'mkdir' | 'write_text_file' | 'rename'>;

/**
 * Get the daemon token file path (`~/.{name}/run/daemon_token`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name
 * @returns path to `daemon_token`, or `null` if `$HOME` is not set
 */
export const get_daemon_token_path = (
	runtime: Pick<EnvDeps, 'env_get'>,
	name: string
): string | null => {
	const app_dir = get_app_dir(runtime, name);
	return app_dir ? `${app_dir}/run/daemon_token` : null;
};

/**
 * Write the current token to disk atomically at mode `0600`.
 *
 * On-disk format is JSON `{"token": "..."}` — the wrapper leaves room for
 * future fields (rotated_at, version) without changing every reader. Both
 * the TS cross-backend harness reader (`spawn_backend.read_daemon_token`)
 * and the Rust daemon-token writer match this shape.
 *
 * @param runtime - runtime with file write capabilities
 * @param token_path - path to write the token
 * @param token - the raw token string
 * @mutates filesystem - writes `token_path` atomically at mode `0600`
 */
export const write_daemon_token = async (
	runtime: DaemonTokenWriteDeps,
	token_path: string,
	token: string
): Promise<void> => {
	await write_file_atomic(runtime, token_path, JSON.stringify({ token }) + '\n', {
		mode: 0o600
	});
};

/** Options for daemon token rotation. */
export interface DaemonTokenRotationOptions {
	/**
	 * Absolute path the token file is written to. Caller computes from
	 * its own conventions — e.g. `get_daemon_token_path(runtime, app_name)`
	 * for the standard `~/.{name}/run/daemon_token` layout, or a path
	 * derived from `PUBLIC_<APP>_DIR` for cross-process test setups that
	 * isolate the app dir to a tmpdir.
	 */
	token_path: string;
	/** Rotation interval in ms. Default: `30000` (30s). */
	rotation_interval_ms?: number;
}

/** Result of starting daemon token rotation. */
export interface DaemonTokenRotation {
	/** The mutable runtime state. Pass to `create_daemon_token_middleware`. */
	state: DaemonTokenState;
	/** Stop rotation, clean up the interval, and delete the token file. Call on graceful shutdown. */
	stop: () => Promise<void>;
}

/**
 * Start daemon token rotation.
 *
 * Generates an initial token, writes it to disk, resolves the keeper account,
 * and sets up periodic rotation. Returns the mutable state object and a stop function.
 *
 * @param runtime - runtime with file and remove capabilities
 * @param deps - query dependencies for resolving keeper account
 * @param options - rotation configuration
 * @param log - the logger instance
 * @returns rotation state and stop function
 * @mutates filesystem - writes the token file on each rotation; `stop` removes it
 */
export const start_daemon_token_rotation = async (
	runtime: DaemonTokenWriteDeps & FsRemoveDeps,
	deps: QueryDeps,
	options: DaemonTokenRotationOptions,
	log: Logger
): Promise<DaemonTokenRotation> => {
	const { token_path, rotation_interval_ms = DEFAULT_ROTATION_INTERVAL_MS } = options;

	// ensure parent directory exists
	const last_slash = token_path.lastIndexOf('/');
	if (last_slash > 0) {
		await runtime.mkdir(token_path.slice(0, last_slash), { recursive: true });
	}

	// resolve keeper account (may be null pre-bootstrap; the middleware
	// lazily refreshes on the first null hit to cover the
	// rotation-starts-before-bootstrap case)
	const keeper_account_id = await resolve_keeper_account_id(deps);

	// generate initial token and write to disk
	const initial_token = generate_daemon_token();
	await write_daemon_token(runtime, token_path, initial_token);

	const state: DaemonTokenState = {
		current_token: initial_token,
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id
	};

	let writing = false;

	const interval_id = setInterval(async () => {
		if (writing) return; // skip if previous rotation write still in progress
		writing = true;
		try {
			const new_token = generate_daemon_token();
			state.previous_token = state.current_token;
			state.current_token = new_token;
			state.rotated_at = new Date();
			await write_daemon_token(runtime, token_path, new_token);
		} catch (err) {
			log.error('Failed to write rotated token:', err);
		} finally {
			writing = false;
		}
	}, rotation_interval_ms);

	const stop = async (): Promise<void> => {
		clearInterval(interval_id);
		try {
			await runtime.remove(token_path);
		} catch {
			// already removed or never written
		}
	};

	return { state, stop };
};
