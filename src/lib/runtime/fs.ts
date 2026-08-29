/**
 * File system utilities.
 *
 * @module
 */

import process from 'node:process';

import type { FsRemoveDeps, FsWriteDeps } from './deps.ts';

/** Options for `write_file_atomic`. */
export interface WriteFileAtomicOptions {
	/**
	 * POSIX mode for the written file (e.g. `0o600` for secrets). Applied at
	 * temp-file creation, so the published file never exists with a laxer
	 * mode. Omitted = the runtime default (umask).
	 */
	mode?: number;
}

/** Per-process counter for unique temp names (concurrent same-path writes). */
let temp_file_counter = 0;

/**
 * Write a file atomically via temp file + rename.
 *
 * Writes to a unique `.{name}.tmp.{pid}.{counter}` sibling with exclusive
 * create (`O_EXCL`), then renames over `path` so readers either see the old
 * contents or the full new contents — never a partial write. The unique name
 * + exclusive create are load-bearing for secret files: a fixed temp name
 * would let a crash-leftover temp be reopened `O_TRUNC` with its old
 * (possibly permissive) mode — `mode` only applies at creation — and the
 * rename would publish that stale inode. Twin of the Rust spine's
 * `fuz_sys::secure_file::write_secure_file` naming scheme.
 *
 * @param deps - write capabilities; pass `remove` too for best-effort temp cleanup on failure
 * @param path - destination path
 * @param content - full file content
 * @param options - optional `mode` applied at creation
 * @mutates filesystem - creates the unique temp file then renames it to `path`
 * @throws Error if `write_text_file` or `rename` rejects (permissions, disk full, cross-device rename, etc.)
 */
export const write_file_atomic = async (
	deps: Pick<FsWriteDeps, 'write_text_file' | 'rename'> & Partial<FsRemoveDeps>,
	path: string,
	content: string,
	options?: WriteFileAtomicOptions
): Promise<void> => {
	const slash = path.lastIndexOf('/');
	const dir = slash === -1 ? '' : path.slice(0, slash + 1);
	const name = slash === -1 ? path : path.slice(slash + 1);
	const temp_path = `${dir}.${name}.tmp.${process.pid}.${temp_file_counter++}`;
	try {
		await deps.write_text_file(temp_path, content, {
			mode: options?.mode,
			exclusive: true
		});
		await deps.rename(temp_path, path);
	} catch (err) {
		// best-effort cleanup so a failed write doesn't strand the temp
		try {
			await deps.remove?.(temp_path);
		} catch {
			// already gone or not removable — the original error wins
		}
		throw err;
	}
};
