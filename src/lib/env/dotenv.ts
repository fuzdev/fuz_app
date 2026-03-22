/**
 * Dotenv file parsing and loading.
 *
 * Provides `parse_dotenv` for parsing dotenv-format strings
 * and `load_env_file` for reading and parsing env files from disk.
 *
 * @module
 */

import type {FsReadDeps} from '../runtime/deps.js';

/**
 * Parse a dotenv-format string into a record.
 *
 * @param content - dotenv file content
 * @returns parsed key-value pairs
 */
export const parse_dotenv = (content: string): Record<string, string> => {
	const result: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		// skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq_index = trimmed.indexOf('=');
		if (eq_index === -1) continue;
		const key = trimmed.slice(0, eq_index).trim();
		let value = trimmed.slice(eq_index + 1).trim();
		// remove surrounding quotes if present (need at least 2 chars for open+close)
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
};

/**
 * Load and parse an env file.
 *
 * @param runtime - runtime with `read_file` capability
 * @param path - path to env file
 * @returns parsed env record, or null if file doesn't exist
 */
export const load_env_file = async (
	runtime: Pick<FsReadDeps, 'read_file'>,
	path: string,
): Promise<Record<string, string> | null> => {
	try {
		const content = await runtime.read_file(path);
		return parse_dotenv(content);
	} catch {
		return null;
	}
};
