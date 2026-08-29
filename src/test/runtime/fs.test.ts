/**
 * Tests for runtime/fs.ts - Atomic file writes.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import process from 'node:process';

import { write_file_atomic } from '$lib/runtime/fs.ts';
import type { WriteFileOptions } from '$lib/runtime/deps.ts';

interface RecordedWrite {
	path: string;
	content: string;
	options: WriteFileOptions | undefined;
}

const create_recording_deps = (): {
	writes: Array<RecordedWrite>;
	renames: Array<[string, string]>;
	removed: Array<string>;
	deps: Parameters<typeof write_file_atomic>[0];
} => {
	const writes: Array<RecordedWrite> = [];
	const renames: Array<[string, string]> = [];
	const removed: Array<string> = [];
	return {
		writes,
		renames,
		removed,
		deps: {
			write_text_file: async (path, content, options) => {
				writes.push({ path, content, options });
			},
			rename: async (old_path, new_path) => {
				renames.push([old_path, new_path]);
			},
			remove: async (path) => {
				removed.push(path);
			}
		}
	};
};

describe('write_file_atomic', () => {
	test('writes content via unique exclusive temp file then renames', async () => {
		const { writes, renames, deps } = create_recording_deps();

		await write_file_atomic(deps, '/data/config.json', '{"key":"value"}');

		assert.strictEqual(writes.length, 1);
		const write = writes[0]!;
		// unique name: `.{name}.tmp.{pid}.{counter}` in the same directory
		assert.match(write.path, new RegExp(`^/data/\\.config\\.json\\.tmp\\.${process.pid}\\.\\d+$`));
		assert.strictEqual(write.content, '{"key":"value"}');
		// exclusive create is load-bearing: a fixed reused temp would be opened
		// O_TRUNC and keep a stale (possibly permissive) mode
		assert.strictEqual(write.options?.exclusive, true);
		assert.deepStrictEqual(renames, [[write.path, '/data/config.json']]);
	});

	test('two writes to the same path use distinct temp names', async () => {
		const { writes, deps } = create_recording_deps();

		await write_file_atomic(deps, '/tmp/test', 'a');
		await write_file_atomic(deps, '/tmp/test', 'b');

		assert.strictEqual(writes.length, 2);
		assert.notStrictEqual(writes[0]!.path, writes[1]!.path);
	});

	test('threads mode through to the temp-file creation', async () => {
		const { writes, deps } = create_recording_deps();

		await write_file_atomic(deps, '/tmp/secret', 'k', { mode: 0o600 });

		assert.strictEqual(writes[0]!.options?.mode, 0o600);
	});

	test('does not rename if write_text_file fails', async () => {
		let renamed = false;

		const deps = {
			write_text_file: async () => {
				throw new Error('disk full');
			},
			rename: async () => {
				renamed = true;
			}
		};

		await assert_rejects(() => write_file_atomic(deps, '/tmp/test', 'data'), /disk full/);

		assert.strictEqual(renamed, false);
	});

	test('propagates rename errors and removes the stranded temp', async () => {
		const removed: Array<string> = [];
		let written_path = '';
		const deps = {
			write_text_file: async (path: string) => {
				written_path = path;
			},
			rename: async () => {
				throw new Error('permission denied');
			},
			remove: async (path: string) => {
				removed.push(path);
			}
		};

		await assert_rejects(() => write_file_atomic(deps, '/tmp/test', 'data'), /permission denied/);

		assert.deepStrictEqual(removed, [written_path]);
	});

	test('cleanup is best-effort — a failing remove does not mask the write error', async () => {
		const deps = {
			write_text_file: async () => {
				throw new Error('disk full');
			},
			rename: async () => {},
			remove: async () => {
				throw new Error('remove also failed');
			}
		};

		await assert_rejects(() => write_file_atomic(deps, '/tmp/test', 'data'), /disk full/);
	});
});
