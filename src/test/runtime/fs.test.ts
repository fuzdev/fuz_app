/**
 * Tests for runtime/fs.ts - Atomic file writes.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {write_file_atomic} from '$lib/runtime/fs.js';

describe('write_file_atomic', () => {
	test('writes content via temp file then renames', async () => {
		const calls: Array<{method: string; args: Array<unknown>}> = [];

		const deps = {
			write_file: async (path: string, content: string) => {
				calls.push({method: 'write_file', args: [path, content]});
			},
			rename: async (old_path: string, new_path: string) => {
				calls.push({method: 'rename', args: [old_path, new_path]});
			},
		};

		await write_file_atomic(deps, '/data/config.json', '{"key":"value"}');

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0]!.method, 'write_file');
		assert.deepStrictEqual(calls[0]!.args, ['/data/config.json.tmp', '{"key":"value"}']);
		assert.strictEqual(calls[1]!.method, 'rename');
		assert.deepStrictEqual(calls[1]!.args, ['/data/config.json.tmp', '/data/config.json']);
	});

	test('write_file is called before rename', async () => {
		const order: Array<string> = [];

		const deps = {
			write_file: async () => {
				order.push('write');
			},
			rename: async () => {
				order.push('rename');
			},
		};

		await write_file_atomic(deps, '/tmp/test', 'data');

		assert.deepStrictEqual(order, ['write', 'rename']);
	});

	test('does not rename if write_file fails', async () => {
		let renamed = false;

		const deps = {
			write_file: async () => {
				throw new Error('disk full');
			},
			rename: async () => {
				renamed = true;
			},
		};

		try {
			await write_file_atomic(deps, '/tmp/test', 'data');
			assert.ok(false, 'should have thrown');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, 'disk full');
		}

		assert.strictEqual(renamed, false);
	});

	test('propagates rename errors', async () => {
		const deps = {
			write_file: async () => {},
			rename: async () => {
				throw new Error('permission denied');
			},
		};

		try {
			await write_file_atomic(deps, '/tmp/test', 'data');
			assert.ok(false, 'should have thrown');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, 'permission denied');
		}
	});

	test('uses .tmp suffix for temp path', async () => {
		let written_path = '';

		const deps = {
			write_file: async (path: string) => {
				written_path = path;
			},
			rename: async () => {},
		};

		await write_file_atomic(deps, '/some/path/file.txt', 'content');

		assert.strictEqual(written_path, '/some/path/file.txt.tmp');
	});
});
