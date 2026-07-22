/**
 * Tests for runtime/node.ts - the Node.js `RuntimeDeps`, focused on the file
 * I/O that touches a real disk (stream bridging + `stat().size`). The casts in
 * `read_file_stream` / `write_file_stream` cross Node's `stream/web` and the
 * global DOM stream types, so they only pay off if a real round-trip works.
 *
 * @module
 */

import { describe, assert, test, beforeEach, afterEach } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { create_node_runtime } from '$lib/runtime/node.ts';

import { collect_stream, stream_of } from './byte_stream.ts';

const rt = create_node_runtime([]);

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'fuz_app_node_runtime_'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('create_node_runtime streaming + size', () => {
	test('stat reports the byte size of a file', async () => {
		const path = join(dir, 'sized.txt');
		await rt.write_file(path, new TextEncoder().encode('héllo')); // 6 bytes UTF-8

		const result = await rt.stat(path);

		assert.ok(result);
		assert.strictEqual(result.is_file, true);
		assert.strictEqual(result.size, 6);
	});

	test('stat reports a directory as a directory (size is OS-defined, not asserted)', async () => {
		const result = await rt.stat(dir);

		assert.ok(result);
		assert.strictEqual(result.is_directory, true);
		assert.strictEqual(result.is_file, false);
		// `size` for a directory is the OS-reported entry size (filesystem-dependent),
		// not necessarily 0 — see `StatResult.size`. Only assert it is a number.
		assert.strictEqual(typeof result.size, 'number');
	});

	test('write_file_stream then read_file_stream round-trips a multi-chunk stream', async () => {
		const path = join(dir, 'rt.bin');
		const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];

		await rt.write_file_stream(path, stream_of(chunks));
		const result = await collect_stream(await rt.read_file_stream(path));

		assert.deepStrictEqual(result, new Uint8Array([1, 2, 3, 4, 5, 6]));
		assert.strictEqual((await rt.stat(path))?.size, 6);
	});

	test('read_file_stream throws eagerly for a missing file', async () => {
		const err = await assert_rejects(() => rt.read_file_stream(join(dir, 'nope.bin')));
		assert.strictEqual((err as NodeJS.ErrnoException).code, 'ENOENT');
	});
});
