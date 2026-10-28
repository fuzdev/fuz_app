import './assert_dev_env.ts';

/**
 * Daemon-info file plumbing for the testing servers — `~/.{name}/run/daemon.json`,
 * written at startup and read for stale-process detection.
 *
 * @module
 */

import {
	format_issue,
	number,
	object,
	parse,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import type { CommandDeps, EnvDeps, FsReadDeps, FsWriteDeps, LogDeps } from '../runtime/deps.ts';
import { write_file_atomic } from '../runtime/fs.ts';

/**
 * Get an app's home directory path (`~/.{name}`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name (e.g., `"tx"`, `"zzz"`)
 * @returns path to the app directory, or null if `$HOME` is not set
 */
export const get_app_dir = (runtime: Pick<EnvDeps, 'env_get'>, name: string): string | null => {
	const home = runtime.env_get('HOME');
	return home ? `${home}/.${name}` : null;
};

/**
 * Daemon info schema for `~/.{name}/run/daemon.json`, a strict
 * `@fuzdev/fuz_schema` object schema.
 */
export const DaemonInfo = object({
	/** Schema version. */
	version: number,
	/** Server process ID. */
	pid: number,
	/** Port the server is listening on. */
	port: number,
	/** ISO timestamp when server started. */
	started: string,
	/** Package version of the application. */
	app_version: string
});
export type DaemonInfo = Infer<typeof DaemonInfo>;

/**
 * Get the daemon info file path (`~/.{name}/run/daemon.json`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name
 * @returns path to `daemon.json`, or null if `$HOME` is not set
 */
export const get_daemon_info_path = (
	runtime: Pick<EnvDeps, 'env_get'>,
	name: string
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
 * @mutates filesystem - creates `~/.{name}/run/` and atomically writes `daemon.json`
 * @throws Error if `$HOME` is not set
 */
export const write_daemon_info = async (
	runtime: Pick<EnvDeps, 'env_get'> & Pick<FsWriteDeps, 'mkdir' | 'write_text_file' | 'rename'>,
	name: string,
	info: DaemonInfo
): Promise<void> => {
	const app_dir = get_app_dir(runtime, name);
	if (!app_dir) {
		throw new Error('$HOME not set');
	}

	const run_dir = `${app_dir}/run`;
	await runtime.mkdir(run_dir, { recursive: true });

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
	runtime: Pick<EnvDeps, 'env_get'> & Pick<FsReadDeps, 'stat' | 'read_text_file'> & LogDeps,
	name: string
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
		const content = await runtime.read_text_file(daemon_path);
		const parsed = JSON.parse(content);
		const result = parse(DaemonInfo, parsed);
		if (!result.ok) {
			runtime.warn(`Invalid daemon.json: ${result.issues.map(format_issue).join('; ')}`);
			return null;
		}
		return result.value;
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
