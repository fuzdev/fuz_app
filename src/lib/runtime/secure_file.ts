/**
 * Hardened secret-file read — the TS twin of the Rust spine's
 * `fuz_sys::secure_file::load_secure_file`.
 *
 * The file this guards is typically the highest-value credential on the host
 * (the bootstrap token mints the keeper account), so the read fails loud
 * rather than degrading: a symlink, a non-regular file (FIFO, device node,
 * directory), a group/other-accessible mode, or an oversized file is refused,
 * never returned. The deploy recipe places the token at `0600`, so the check
 * ratifies the shape zap produces; a hand-placed `0644` file fails at boot
 * instead of being read.
 *
 * The real implementation lives here (`load_secure_file_node`, wired as
 * `create_node_runtime().read_secure_file`), and the mock honors the mode/size
 * checks over its in-memory map (it has no file types). Both refuse through
 * the shared `assert_secure_mode` / `assert_secure_size` helpers, so the
 * checks — and their operator-facing messages — can't drift between them.
 *
 * @module
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import process from 'node:process';

/**
 * Maximum size for secure files. Prevents DoS from unexpectedly large files;
 * 4 KiB is generous for token/key material. Matches the Rust twin's
 * `MAX_SECURE_FILE_SIZE`.
 */
export const MAX_SECURE_FILE_SIZE = 4096;

/**
 * Whether POSIX file modes are meaningful on this platform. On Windows Node
 * synthesizes modes (always group/other-readable), so enforcing the check
 * would refuse every file; the Rust twin is Unix-only and never faces this.
 * The mock runtime checks unconditionally — its modes are simulated.
 */
const modes_apply = process.platform !== 'win32';

/**
 * Refuse any group/other-accessible mode (only `0600`/`0400` pass).
 *
 * Callers own the platform gating: `load_secure_file_node` skips the check
 * where modes aren't meaningful (Windows); the mock checks its simulated modes
 * unconditionally.
 *
 * @throws Error naming the path, the offending mode, and the `chmod` fix
 */
export const assert_secure_mode = (path: string, mode: number): void => {
	if ((mode & 0o077) !== 0) {
		throw new Error(
			`insecure permissions on ${path}: ${(mode & 0o777).toString(8)} (expected 0600) — fix with: chmod 600 ${path}`
		);
	}
};

/**
 * Refuse a byte count over `MAX_SECURE_FILE_SIZE`.
 *
 * @throws Error naming the path, the size, and the cap
 */
export const assert_secure_size = (path: string, size: number): void => {
	if (size > MAX_SECURE_FILE_SIZE) {
		throw new Error(`secure file too large: ${path} (${size} bytes, max ${MAX_SECURE_FILE_SIZE})`);
	}
};

/**
 * Read a secret file with fail-loud checks (Node implementation).
 *
 * - `O_NOFOLLOW` atomically rejects symlinks during open (no TOCTOU window)
 * - `O_NONBLOCK` keeps the open from waiting on a FIFO that has no writer (it
 *   has no effect on a regular file); the regular-file check on the open
 *   descriptor then refuses it, a device node, or a directory
 * - `O_NOCTTY` keeps a terminal device at the path from becoming the process's
 *   controlling terminal in the moment before that check refuses it
 * - the permission check runs on the open descriptor, not the path, so the
 *   file can't be swapped between check and read — any group/other access
 *   (not `0600`/`0400`) is refused
 * - a size cap bounds the read; the read itself is limited to cap + 1 so a
 *   file growing between stat and read is still caught
 *
 * @param path - path to the secret file
 * @returns the file's bytes
 * @throws Error on a missing file, symlink, non-regular file, permissive mode, oversized file, or I/O failure
 */
export const load_secure_file_node = async (path: string): Promise<Uint8Array> => {
	let handle;
	try {
		handle = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY
		);
	} catch (err) {
		// ELOOP means the path was a symlink (O_NOFOLLOW refused it).
		if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
			throw new Error(`secure file is a symlink: ${path}`);
		}
		throw err;
	}
	try {
		const s = await handle.stat();
		if (!s.isFile()) throw new Error(`not a regular file: ${path}`);
		if (modes_apply) assert_secure_mode(path, s.mode);
		assert_secure_size(path, s.size);
		// read up to cap + 1 bytes so a file growing between stat and read is
		// still caught (the stat-time size check alone races); `position: null`
		// reads sequentially from the handle's own cursor
		const buffer = new Uint8Array(MAX_SECURE_FILE_SIZE + 1);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		assert_secure_size(path, total);
		return buffer.subarray(0, total);
	} finally {
		await handle.close();
	}
};
