/**
 * Tests for runtime/secure_file.ts — the hardened secret read (Node impl)
 * plus the real-file crash-leftover pin on `write_file_atomic`.
 *
 * Twin of the Rust `fuz_sys::secure_file` test suite: owner-only reads
 * verbatim, group/world-readable refused, symlink refused, size cap held.
 * Real files in a tmpdir — the mock can't exercise `O_NOFOLLOW` or fd-level
 * stat.
 *
 * @module
 */

import { describe, assert, test, beforeEach, afterEach } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { load_secure_file_node, MAX_SECURE_FILE_SIZE } from '$lib/runtime/secure_file.ts';
import { write_file_atomic } from '$lib/runtime/fs.ts';
import { create_node_runtime } from '$lib/runtime/node.ts';

const posix = process.platform !== 'win32';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fuz-secure-file-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const write_token = (name: string, contents: string, mode: number): string => {
	const path = join(dir, name);
	writeFileSync(path, contents);
	chmodSync(path, mode);
	return path;
};

describe('load_secure_file_node', () => {
	test('reads an owner-only token verbatim (no trimming)', async () => {
		const path = write_token('token', 'secret-token-value\n', 0o600);
		const bytes = await load_secure_file_node(path);
		assert.strictEqual(new TextDecoder().decode(bytes), 'secret-token-value\n');
	});

	test('accepts read-only 0400', async () => {
		const path = write_token('token', 'ro', 0o400);
		const bytes = await load_secure_file_node(path);
		assert.strictEqual(new TextDecoder().decode(bytes), 'ro');
	});

	test.runIf(posix)('refuses group- or world-readable modes', async () => {
		// The P1 regression pin: a bare read accepted any readable file, so a
		// token left at 0644 — what `echo … > file` produces under the default
		// umask — was read and honored, handing keeper-account creation to
		// every local user.
		for (const mode of [0o644, 0o640]) {
			const path = write_token(`token-${mode.toString(8)}`, 'secret', mode);
			await assert_rejects(() => load_secure_file_node(path), /insecure permissions/);
		}
	});

	test.runIf(posix)('refuses a symlinked token', async () => {
		const target = write_token('target', 'secret', 0o600);
		const link = join(dir, 'link');
		symlinkSync(target, link);
		await assert_rejects(() => load_secure_file_node(link), /symlink/);
	});

	test('missing file is an error, not an empty read', async () => {
		await assert_rejects(() => load_secure_file_node(join(dir, 'absent')));
	});

	test('refuses a file over the size cap; accepts one exactly at it', async () => {
		const at_limit = write_token('at-limit', 'x'.repeat(MAX_SECURE_FILE_SIZE), 0o600);
		const loaded = await load_secure_file_node(at_limit);
		assert.strictEqual(loaded.length, MAX_SECURE_FILE_SIZE);

		const over = write_token('over', 'x'.repeat(MAX_SECURE_FILE_SIZE + 1), 0o600);
		await assert_rejects(() => load_secure_file_node(over), /too large/);
	});
});

describe.runIf(posix)('write_file_atomic against real files', () => {
	test('a crash-leftover permissive temp is never reused — the published mode holds', async () => {
		// The defect neither spine pinned: with a FIXED `<path>.tmp` name a
		// crash-leftover temp was reopened O_TRUNC, kept its old permissive
		// mode (O_CREAT mode applies only at creation), and the rename
		// published the stale inode. The unique `.{name}.tmp.{pid}.{counter}`
		// + exclusive create make that impossible; this proves it end-to-end.
		const runtime = create_node_runtime();
		const path = join(dir, 'secret');
		// simulate the crash leftover at the OLD fixed temp name, world-readable
		writeFileSync(path + '.tmp', 'stale');
		chmodSync(path + '.tmp', 0o644);

		await write_file_atomic(runtime, path, 'fresh-secret', { mode: 0o600 });

		const mode = statSync(path).mode & 0o777;
		assert.strictEqual(mode, 0o600, 'published file must carry the requested mode');
		const bytes = await load_secure_file_node(path);
		assert.strictEqual(new TextDecoder().decode(bytes), 'fresh-secret');
	});

	test('concurrent writes to the same path all succeed (unique temp names)', async () => {
		const runtime = create_node_runtime();
		const path = join(dir, 'concurrent');
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				write_file_atomic(runtime, path, `writer ${i}`, { mode: 0o600 })
			)
		);
		const bytes = await load_secure_file_node(path);
		assert.match(new TextDecoder().decode(bytes), /^writer \d$/);
	});
});
