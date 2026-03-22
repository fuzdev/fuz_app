/**
 * Generic CLI configuration loader.
 *
 * Manages CLI-specific configuration stored at `~/.{name}/config.json`.
 * Consumers keep their project-specific Zod schemas locally and use
 * these generic load/save functions.
 *
 * @module
 */

import type {z} from 'zod';

import type {EnvDeps, FsReadDeps, FsWriteDeps, LogDeps} from '../runtime/deps.js';

/**
 * Get the CLI config directory path (`~/.{name}`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name (e.g., `"tx"`, `"zzz"`)
 * @returns path to config directory, or null if `$HOME` is not set
 */
export const get_app_dir = (runtime: Pick<EnvDeps, 'env_get'>, name: string): string | null => {
	const home = runtime.env_get('HOME');
	return home ? `${home}/.${name}` : null;
};

/**
 * Get the CLI config file path (`~/.{name}/config.json`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name
 * @returns path to `config.json`, or null if `$HOME` is not set
 */
export const get_config_path = (runtime: Pick<EnvDeps, 'env_get'>, name: string): string | null => {
	const app_dir = get_app_dir(runtime, name);
	return app_dir ? `${app_dir}/config.json` : null;
};

/**
 * Load CLI configuration from a JSON file with Zod schema validation.
 *
 * @param runtime - runtime with file read capability
 * @param path - path to the config JSON file
 * @param schema - Zod schema to validate against
 * @returns parsed config, or null if file doesn't exist or is invalid
 */
export const load_config = async <T>(
	runtime: FsReadDeps & LogDeps,
	path: string,
	schema: z.ZodType<T>,
): Promise<T | null> => {
	// check if file exists
	const stat = await runtime.stat(path);
	if (!stat) {
		return null;
	}

	try {
		const content = await runtime.read_file(path);
		const parsed = JSON.parse(content);
		const result = schema.safeParse(parsed);
		if (!result.success) {
			runtime.warn(`Invalid config.json: ${result.error.message}`);
			return null;
		}
		return result.data;
	} catch (error) {
		runtime.warn(`Failed to read config.json: ${(error as Error).message}`);
		return null;
	}
};

/**
 * Save CLI configuration to a JSON file.
 *
 * Creates parent directories if they don't exist.
 *
 * @param runtime - runtime with file write capability
 * @param path - path to the config JSON file
 * @param dir - directory containing the config file (created if missing)
 * @param config - configuration to save
 */
export const save_config = async <T>(
	runtime: FsWriteDeps,
	path: string,
	dir: string,
	config: T,
): Promise<void> => {
	// ensure directory exists
	await runtime.mkdir(dir, {recursive: true});

	// write with pretty formatting
	const content = JSON.stringify(config, null, '\t');
	await runtime.write_file(path, content + '\n');
};
