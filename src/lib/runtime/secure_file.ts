/**
 * Hardened secret-file read and burn — the TS twins of the Rust spine's
 * `fuz_sys::secure_file::load_secure_file` and `burn_secure_file`.
 *
 * The file this guards is typically the highest-value credential on the host
 * (the bootstrap token mints the keeper account), so the read fails loud
 * rather than degrading: a symlink, a non-regular file (FIFO, device node,
 * directory), a group/other-accessible mode, or an oversized file is refused,
 * never returned. The deploy recipe places the token at `0600`, so the check
 * ratifies the shape zap produces; a hand-placed `0644` file fails at boot
 * instead of being read.
 *
 * The real implementations live here (`load_secure_file_node` and
 * `burn_secure_file_node`, wired as `create_node_runtime().read_secure_file`
 * and `.burn_secure_file`), and the mock honors the mode/size
 * checks over its in-memory map (it has no file types). Both refuse through
 * the shared `assert_secure_mode` / `assert_secure_size` helpers, so the
 * checks — and their operator-facing messages — can't drift between them.
 *
 * @module
 */

import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
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

/**
 * What a burn found at the path. Both mean the postcondition holds — no
 * entry at the path, durably — so a caller that only needs the secret gone
 * treats them alike and logs the second. Twin of the Rust
 * `fuz_sys::secure_file::BurnOutcome`.
 *
 * - `'burned'` — the entry was there and is now unlinked
 * - `'already_gone'` — nothing was at the path (`ENOENT`)
 */
export type BurnOutcome = 'burned' | 'already_gone';

/**
 * Whether a directory can be opened to fsync it. Windows can't open a
 * directory, so the parent fsync is skipped there and a burn's durability
 * across a host crash rests on the filesystem; refusing the burn instead
 * would make bootstrap impossible on that platform. The Rust twin is
 * Unix-only and never faces this.
 */
const directory_fsync_applies = process.platform !== 'win32';

/**
 * Remove a one-shot secret's directory entry, durably (Node implementation)
 * — the burn a consumed credential file (the bootstrap token) gets before the
 * transaction it authorized commits, so the secret can never be presented
 * again.
 *
 * - `unlink` of the entry at `path`: a symlink there is removed itself, never
 *   followed (following would delete a file the operator never named), and a
 *   directory is refused, never recursed into — unlike `rm`, which takes
 *   `recursive`
 * - a missing entry (`ENOENT`) is `'already_gone'`, not an error: the
 *   postcondition the caller needs — no entry at `path` — holds
 * - then the parent directory is fsynced, on both outcomes, so the removal
 *   survives a host crash; without it a crash after the caller's commit can
 *   bring the entry back. A failed fsync is a failed burn. Skipped on Windows,
 *   which can't open a directory
 *
 * Twin of the Rust `fuz_sys::secure_file::burn_secure_file`.
 *
 * @param path - path to the secret file
 * @returns whether the entry was unlinked or already gone
 * @throws Error naming the path when the unlink fails for any reason but `ENOENT` (`EACCES` from a directory the process can't write, `EISDIR`/`EPERM` for a directory at the path), or naming the parent when its fsync fails
 */
export const burn_secure_file_node = async (path: string): Promise<BurnOutcome> => {
	let outcome: BurnOutcome = 'burned';
	try {
		await unlink(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(`could not delete ${path}: ${(err as Error).message}`, { cause: err });
		}
		outcome = 'already_gone';
	}
	if (directory_fsync_applies) {
		const parent = dirname(path);
		try {
			// a read handle is enough: fsync flushes the directory's entries
			// whatever the descriptor's mode
			const handle = await open(parent, 'r');
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (err) {
			throw new Error(`could not fsync ${parent}: ${(err as Error).message}`, { cause: err });
		}
	}
	return outcome;
};
