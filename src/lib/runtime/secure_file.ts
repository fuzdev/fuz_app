/**
 * Hardened secret-file read — the TS twin of the Rust spine's
 * `fuz_sys::secure_file::load_secure_file`.
 *
 * The file this guards is typically the highest-value credential on the host
 * (the bootstrap token mints the keeper account), so the read fails loud
 * rather than degrading: a symlink, a group/other-accessible mode, or an
 * oversized file is refused, never returned. The deploy recipe places the
 * token at `0600`, so the check ratifies the shape zap produces; a
 * hand-placed `0644` file fails at boot instead of being read.
 *
 * The Node implementation lives here (`load_secure_file_node`, wired as
 * `create_node_runtime().read_secure_file`); the Deno runtime implements the
 * same contract over `Deno.open` in `runtime/deno.ts`, and the mock honors
 * the mode/size checks over its in-memory map. All three refuse through the
 * shared `assert_secure_mode` / `assert_secure_size` / `read_secure_bounded`
 * helpers so the checks — and their operator-facing messages — can't drift
 * between runtimes.
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
 * Callers own the platform gating: the real runtimes skip the check where
 * modes aren't meaningful (Node on Windows, a `null` Deno mode); the mock
 * checks its simulated modes unconditionally.
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
 * Drain `read_chunk` into a cap-bounded buffer.
 *
 * Reads up to cap + 1 bytes so a file growing between stat and read is still
 * caught (the stat-time size check alone races). `read_chunk` fills the given
 * target from the file's current position and returns the bytes read
 * (`null`/`0` = EOF) — the seam that lets the Node and Deno handle APIs share
 * one loop.
 *
 * @throws Error when more than `MAX_SECURE_FILE_SIZE` bytes arrive
 */
export const read_secure_bounded = async (
	path: string,
	read_chunk: (target: Uint8Array) => Promise<number | null>
): Promise<Uint8Array> => {
	const buffer = new Uint8Array(MAX_SECURE_FILE_SIZE + 1);
	let total = 0;
	while (total < buffer.length) {
		const n = await read_chunk(buffer.subarray(total));
		if (n === null || n === 0) break;
		total += n;
	}
	assert_secure_size(path, total);
	return buffer.subarray(0, total);
};

/**
 * Read a secret file with fail-loud checks (Node implementation).
 *
 * - `O_NOFOLLOW` atomically rejects symlinks during open (no TOCTOU window)
 * - the permission check runs on the open descriptor, not the path, so the
 *   file can't be swapped between check and read — any group/other access
 *   (not `0600`/`0400`) is refused
 * - a size cap bounds the read; the read itself is limited to cap + 1 so a
 *   file growing between stat and read is still caught
 *
 * @param path - path to the secret file
 * @returns the file's bytes
 * @throws Error on a missing file, symlink, permissive mode, oversized file, or I/O failure
 */
export const load_secure_file_node = async (path: string): Promise<Uint8Array> => {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (err) {
		// ELOOP means the path was a symlink (O_NOFOLLOW refused it).
		if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
			throw new Error(`secure file is a symlink: ${path}`);
		}
		throw err;
	}
	try {
		const s = await handle.stat();
		if (modes_apply) assert_secure_mode(path, s.mode);
		assert_secure_size(path, s.size);
		// `position: null` reads sequentially from the handle's own cursor.
		return await read_secure_bounded(path, async (target) => {
			const { bytesRead } = await handle.read(target, 0, target.length, null);
			return bytesRead;
		});
	} finally {
		await handle.close();
	}
};
