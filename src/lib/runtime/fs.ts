/**
 * File system utilities.
 *
 * @module
 */

import type {FsWriteDeps} from './deps.js';

/**
 * Write a file atomically via temp file + rename.
 *
 * @param deps - deps with file write capabilities
 * @param path - destination file path
 * @param content - file contents to write
 */
export const write_file_atomic = async (
	deps: Pick<FsWriteDeps, 'write_file' | 'rename'>,
	path: string,
	content: string,
): Promise<void> => {
	const temp_path = path + '.tmp';
	await deps.write_file(temp_path, content);
	await deps.rename(temp_path, path);
};
