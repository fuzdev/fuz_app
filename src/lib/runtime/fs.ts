/**
 * File system utilities.
 *
 * @module
 */

import type {FsWriteDeps} from './deps.js';

/**
 * Write a file atomically via temp file + rename.
 *
 * Writes to `<path>.tmp` then renames over `path` so readers either see the
 * old contents or the full new contents — never a partial write.
 *
 * @param deps - deps with file write capabilities
 * @param path - destination file path
 * @param content - file contents to write
 * @mutates filesystem - creates `<path>.tmp` then renames it to `path`
 * @throws if `write_text_file` or `rename` rejects (permissions, disk full, cross-device rename, etc.)
 */
export const write_file_atomic = async (
	deps: Pick<FsWriteDeps, 'write_text_file' | 'rename'>,
	path: string,
	content: string,
): Promise<void> => {
	const temp_path = path + '.tmp';
	await deps.write_text_file(temp_path, content);
	await deps.rename(temp_path, path);
};
