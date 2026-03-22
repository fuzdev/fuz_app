/**
 * Daemon lifecycle management.
 *
 * Provides daemon info schema, PID file management, and process lifecycle
 * operations. Separates lifecycle from presentation — `stop_daemon` returns
 * a result object instead of logging directly.
 *
 * @module
 */

import {z} from 'zod';

import {
	type CommandDeps,
	type EnvDeps,
	type FsReadDeps,
	type FsRemoveDeps,
	type FsWriteDeps,
	type LogDeps,
} from '../runtime/deps.js';
import {write_file_atomic} from '../runtime/fs.js';
import {get_app_dir} from './config.js';

/**
 * Daemon info schema for `~/.{name}/run/daemon.json`.
 */
export const DaemonInfo = z.strictObject({
	/** Schema version. */
	version: z.number(),
	/** Server process ID. */
	pid: z.number(),
	/** Port the server is listening on. */
	port: z.number(),
	/** ISO timestamp when server started. */
	started: z.string(),
	/** Package version of the application. */
	app_version: z.string(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;

/**
 * Get the daemon info file path (`~/.{name}/run/daemon.json`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name
 * @returns path to `daemon.json`, or null if `$HOME` is not set
 */
export const get_daemon_info_path = (
	runtime: Pick<EnvDeps, 'env_get'>,
	name: string,
): string | null => {
	const app_dir = get_app_dir(runtime, name);
	return app_dir ? `${app_dir}/run/daemon.json` : null;
};

/**
 * Write daemon info to the PID file, creating directories as needed.
 *
 * @param runtime - runtime with file write and env capabilities
 * @param name - application name
 * @param info - daemon info to write
 */
export const write_daemon_info = async (
	runtime: Pick<EnvDeps, 'env_get'> & FsWriteDeps,
	name: string,
	info: DaemonInfo,
): Promise<void> => {
	const app_dir = get_app_dir(runtime, name);
	if (!app_dir) {
		throw new Error('$HOME not set');
	}

	const run_dir = `${app_dir}/run`;
	await runtime.mkdir(run_dir, {recursive: true});

	const content = JSON.stringify(info, null, '\t');
	await write_file_atomic(runtime, `${run_dir}/daemon.json`, content + '\n');
};

/**
 * Read and validate daemon info from the PID file.
 *
 * @param runtime - runtime with file read and env capabilities
 * @param name - application name
 * @returns parsed daemon info, or null if missing or invalid
 */
export const read_daemon_info = async (
	runtime: Pick<EnvDeps, 'env_get'> & FsReadDeps & LogDeps,
	name: string,
): Promise<DaemonInfo | null> => {
	const daemon_path = get_daemon_info_path(runtime, name);
	if (!daemon_path) {
		return null;
	}

	const stat = await runtime.stat(daemon_path);
	if (!stat) {
		return null;
	}

	try {
		const content = await runtime.read_file(daemon_path);
		const parsed = JSON.parse(content);
		const result = DaemonInfo.safeParse(parsed);
		if (!result.success) {
			runtime.warn(`Invalid daemon.json: ${result.error.message}`);
			return null;
		}
		return result.data;
	} catch {
		runtime.warn('Failed to parse daemon.json');
		return null;
	}
};

/**
 * Check if a process is running by PID.
 *
 * @param runtime - runtime with command execution capability
 * @param pid - process ID to check
 * @returns `true` if the process is running
 */
export const is_daemon_running = async (runtime: CommandDeps, pid: number): Promise<boolean> => {
	const result = await runtime.run_command('kill', ['-0', String(pid)]);
	return result.success;
};

/**
 * Result of a `stop_daemon` operation.
 */
export interface StopDaemonResult {
	/** Whether a daemon was stopped. */
	stopped: boolean;
	/** PID of the stopped daemon, if any. */
	pid?: number;
	/** Human-readable message describing the outcome. */
	message: string;
}

/**
 * Stop a running daemon by sending SIGTERM and cleaning up the PID file.
 *
 * Returns a result object instead of logging directly, separating
 * lifecycle from presentation.
 *
 * @param runtime - runtime with command, file, and env capabilities
 * @param name - application name
 * @returns result describing the outcome
 */
export const stop_daemon = async (
	runtime: Pick<EnvDeps, 'env_get'> & FsReadDeps & FsRemoveDeps & CommandDeps & LogDeps,
	name: string,
): Promise<StopDaemonResult> => {
	const daemon_path = get_daemon_info_path(runtime, name);
	if (!daemon_path) {
		return {stopped: false, message: '$HOME not set'};
	}

	// check if daemon.json exists
	const stat = await runtime.stat(daemon_path);
	if (!stat) {
		return {stopped: false, message: 'No daemon running (no daemon.json found)'};
	}

	// read and validate daemon info
	const info = await read_daemon_info(runtime, name);
	if (!info) {
		// corrupt file, clean up
		try {
			await runtime.remove(daemon_path);
		} catch {
			// already removed
		}
		return {stopped: false, message: 'Corrupt daemon.json, removed'};
	}

	// send SIGTERM
	const result = await runtime.run_command('kill', [String(info.pid)]);
	const stopped = result.success;

	// clean up daemon.json
	try {
		await runtime.remove(daemon_path);
	} catch {
		// already removed by daemon's own shutdown handler
	}

	if (stopped) {
		return {stopped: true, pid: info.pid, message: `Stopped daemon (pid ${info.pid})`};
	}
	return {
		stopped: false,
		pid: info.pid,
		message: `Process ${info.pid} not running, cleaned up stale daemon.json`,
	};
};
