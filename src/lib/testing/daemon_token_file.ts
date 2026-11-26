import './assert_dev_env.ts';

/**
 * Daemon-token **producer** — one static token, written to a file, test-harness
 * only.
 *
 * No production assembly mints daemon tokens: the credential's only remaining
 * role is the cross-process test harness's keeper channel (`_testing_reset`
 * etc.), so the producer lives here behind `assert_dev_env` where it cannot
 * reach a production bundle. The *consumer* half — validating a presented
 * `X-Daemon-Token` — stays in `auth/daemon_token_middleware.ts`, mirroring
 * the Rust spine, whose producer is confined to `fuz_testing`. The token never
 * rotates: the harness reads the file once at spawn, as the Rust testing
 * binary's token is static too.
 *
 * The token file is written atomically at mode `0600` via
 * `write_file_atomic` (unique temp name + exclusive create), so it never
 * exists group/other-readable.
 *
 * @module
 */

import type { FsWriteDeps, FsRemoveDeps } from '../runtime/deps.ts';
import { write_file_atomic } from '../runtime/fs.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { generate_daemon_token, type DaemonTokenState } from '../auth/daemon_token.ts';
import { resolve_keeper_account_id } from '../auth/daemon_token_middleware.ts';

/** Deps for writing the daemon token to disk. */
export type DaemonTokenWriteDeps = Pick<FsWriteDeps, 'mkdir' | 'write_text_file' | 'rename'>;

/**
 * Write a token to disk atomically at mode `0600`.
 *
 * On-disk format is JSON `{"token": "..."}` — the wrapper leaves room for
 * future fields without changing every reader. Both the TS cross-backend
 * harness reader (`spawn_backend.read_daemon_token`) and the Rust
 * daemon-token writer match this shape.
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

/** A daemon token written to its file, and the state the server reads. */
export interface DaemonTokenFile {
	/** The runtime state. Pass to `create_app_server` as `daemon_token_state`. */
	state: DaemonTokenState;
	/** Remove the token file. Call on shutdown; a second call does nothing more. */
	stop: () => Promise<void>;
}

/**
 * Generate a daemon token, write it to `token_path` (creating the parent
 * directory), and resolve the keeper account — `null` before bootstrap; the
 * bootstrap route sets it once its account commits, given this state on
 * `create_app_server`.
 *
 * @param runtime - runtime with file write and remove capabilities
 * @param deps - the database the keeper is resolved from
 * @param token_path - absolute path of the token file
 * @returns the daemon-token state and the `stop` that removes the file — a
 *   file already gone counts as removed, and any other failure rejects
 * @mutates filesystem - writes `token_path`; `stop` removes it
 */
export const create_daemon_token_file = async (
	runtime: DaemonTokenWriteDeps & FsRemoveDeps,
	deps: QueryDeps,
	token_path: string
): Promise<DaemonTokenFile> => {
	const last_slash = token_path.lastIndexOf('/');
	if (last_slash > 0) {
		await runtime.mkdir(token_path.slice(0, last_slash), { recursive: true });
	}

	const keeper_account_id = await resolve_keeper_account_id(deps);

	const token = generate_daemon_token();
	await write_daemon_token(runtime, token_path, token);

	const state: DaemonTokenState = {
		current_token: token,
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id
	};

	// one removal, however many callers stop; a file already gone is removed
	let stopped: Promise<void> | null = null;
	const stop = (): Promise<void> =>
		(stopped ??= runtime.remove(token_path).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}));

	return { state, stop };
};
