import './assert_dev_env.ts';

/**
 * Daemon-info file plumbing for the testing servers — `~/.{name}/run/daemon.json`,
 * written at startup and read for stale-process detection.
 *
 * @module
 */

import {
	format_issue,
	iso_datetime,
	number,
	object,
	parse,
	pipe,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import type {
	EnvDeps,
	FsReadDeps,
	FsWriteDeps,
	LogDeps,
	ProcessProbeDeps
} from '../runtime/deps.ts';
import { write_file_atomic } from '../runtime/fs.ts';
import { is_process_id } from '../runtime/process_id.ts';

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
	/**
	 * When the server started, an RFC 3339 date and time in UTC
	 * (`2026-01-01T00:00:00.000Z`): a four-digit year, seconds required, a
	 * fraction of up to 9 digits or none, `Z` and no offset — fuz_schema's
	 * `iso_datetime`.
	 */
	started: pipe(string, iso_datetime),
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
 * Whether the daemon a `daemon.json` names is still running: its `pid` is a
 * process this process may signal (`probe_process`).
 *
 * A process another user owns (`'not_permitted'`) is not the daemon — its pid
 * was reused — so it reads as not running, as does a `pid` that names no
 * single process (0, a negative number, a non-integer, out of `pid_t` range).
 *
 * @param runtime - runtime with the process probe
 * @param pid - the process ID `daemon.json` recorded
 * @returns `true` if the process is running and this process may signal it
 */
export const is_daemon_running = (runtime: ProcessProbeDeps, pid: number): boolean =>
	is_process_id(pid) && runtime.probe_process(pid) === 'running';
