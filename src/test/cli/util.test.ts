import {test, assert, describe} from 'vitest';

import {colors, run_local, confirm} from '$lib/cli/util.js';

describe('colors', () => {
	test('has all expected color keys', () => {
		assert.ok('green' in colors);
		assert.ok('yellow' in colors);
		assert.ok('blue' in colors);
		assert.ok('red' in colors);
		assert.ok('cyan' in colors);
		assert.ok('dim' in colors);
		assert.ok('bold' in colors);
		assert.ok('reset' in colors);
	});

	test('color values are strings', () => {
		for (const value of Object.values(colors)) {
			assert.strictEqual(typeof value, 'string');
		}
	});
});

describe('run_local', () => {
	test('delegates to runtime.run_command', async () => {
		const calls: Array<{cmd: string; args: Array<string>}> = [];
		const runtime = {
			run_command: (cmd: string, args: Array<string>) => {
				calls.push({cmd, args});
				return Promise.resolve({success: true, code: 0, stdout: 'ok', stderr: ''});
			},
		};

		const result = await run_local(runtime, 'echo', ['hello']);
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.stdout, 'ok');
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.cmd, 'echo');
		assert.deepStrictEqual(calls[0]!.args, ['hello']);
	});
});

describe('confirm', () => {
	test('returns true for y', async () => {
		const encoder = new TextEncoder();
		const runtime = {
			stdout_write: (_data: Uint8Array) => Promise.resolve(_data.length),
			stdin_read: (buf: Uint8Array) => {
				const bytes = encoder.encode('y\n');
				buf.set(bytes);
				return Promise.resolve(bytes.length);
			},
		};

		const result = await confirm(runtime, 'Continue?');
		assert.strictEqual(result, true);
	});

	test('returns true for yes', async () => {
		const encoder = new TextEncoder();
		const runtime = {
			stdout_write: (_data: Uint8Array) => Promise.resolve(_data.length),
			stdin_read: (buf: Uint8Array) => {
				const bytes = encoder.encode('yes\n');
				buf.set(bytes);
				return Promise.resolve(bytes.length);
			},
		};

		const result = await confirm(runtime, 'Continue?');
		assert.strictEqual(result, true);
	});

	test('returns false for n', async () => {
		const encoder = new TextEncoder();
		const runtime = {
			stdout_write: (_data: Uint8Array) => Promise.resolve(_data.length),
			stdin_read: (buf: Uint8Array) => {
				const bytes = encoder.encode('n\n');
				buf.set(bytes);
				return Promise.resolve(bytes.length);
			},
		};

		const result = await confirm(runtime, 'Continue?');
		assert.strictEqual(result, false);
	});

	test('returns true for uppercase Y', async () => {
		const encoder = new TextEncoder();
		const runtime = {
			stdout_write: (_data: Uint8Array) => Promise.resolve(_data.length),
			stdin_read: (buf: Uint8Array) => {
				const bytes = encoder.encode('Y\n');
				buf.set(bytes);
				return Promise.resolve(bytes.length);
			},
		};

		const result = await confirm(runtime, 'Continue?');
		assert.strictEqual(result, true);
	});

	test('returns true for uppercase YES', async () => {
		const encoder = new TextEncoder();
		const runtime = {
			stdout_write: (_data: Uint8Array) => Promise.resolve(_data.length),
			stdin_read: (buf: Uint8Array) => {
				const bytes = encoder.encode('YES\n');
				buf.set(bytes);
				return Promise.resolve(bytes.length);
			},
		};

		const result = await confirm(runtime, 'Continue?');
		assert.strictEqual(result, true);
	});

	test('returns false on EOF', async () => {
		const runtime = {
			stdout_write: (_data: Uint8Array) => Promise.resolve(_data.length),
			stdin_read: (_buf: Uint8Array) => Promise.resolve(null),
		};

		const result = await confirm(runtime, 'Continue?');
		assert.strictEqual(result, false);
	});

	test('returns false on empty input (just Enter)', async () => {
		const encoder = new TextEncoder();
		const runtime = {
			stdout_write: (_data: Uint8Array) => Promise.resolve(_data.length),
			stdin_read: (buf: Uint8Array) => {
				const bytes = encoder.encode('\n');
				buf.set(bytes);
				return Promise.resolve(bytes.length);
			},
		};

		const result = await confirm(runtime, 'Continue?');
		assert.strictEqual(result, false);
	});

	test('writes prompt to stdout', async () => {
		const decoder = new TextDecoder();
		let written = '';
		const runtime = {
			stdout_write: (data: Uint8Array) => {
				written = decoder.decode(data);
				return Promise.resolve(data.length);
			},
			stdin_read: (_buf: Uint8Array) => Promise.resolve(null),
		};

		await confirm(runtime, 'Do it?');
		assert.strictEqual(written, 'Do it? [y/N] ');
	});
});
