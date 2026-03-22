/**
 * Tests for runtime/mock.ts - MockRuntime smoke tests.
 *
 * Verifies the mock runtime behaves correctly for tests that depend on it.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	create_mock_runtime,
	reset_mock_runtime,
	set_mock_stdin,
	MockExitError,
} from '$lib/runtime/mock.js';

describe('create_mock_runtime', () => {
	test('creates a runtime with default empty state', () => {
		const rt = create_mock_runtime();

		assert.strictEqual(rt.args.length, 0);
		assert.strictEqual(rt.mock_env.size, 0);
		assert.strictEqual(rt.mock_fs.size, 0);
		assert.strictEqual(rt.mock_dirs.size, 0);
		assert.strictEqual(rt.exit_calls.length, 0);
		assert.strictEqual(rt.command_calls.length, 0);
		assert.strictEqual(rt.stdout_writes.length, 0);
	});

	test('accepts CLI args', () => {
		const rt = create_mock_runtime(['apply', 'config.ts']);

		assert.strictEqual(rt.args.length, 2);
		assert.strictEqual(rt.args[0], 'apply');
		assert.strictEqual(rt.args[1], 'config.ts');
	});
});

describe('environment', () => {
	test('env_get/env_set round-trips', () => {
		const rt = create_mock_runtime();

		rt.env_set('HOME', '/home/test');

		assert.strictEqual(rt.env_get('HOME'), '/home/test');
		assert.strictEqual(rt.env_get('MISSING'), undefined);
	});

	test('env_all returns all variables', () => {
		const rt = create_mock_runtime();
		rt.env_set('A', '1');
		rt.env_set('B', '2');

		const all = rt.env_all();

		assert.strictEqual(all.A, '1');
		assert.strictEqual(all.B, '2');
	});
});

describe('file system', () => {
	test('write_file and read_file round-trip', async () => {
		const rt = create_mock_runtime();

		await rt.write_file('/tmp/test.txt', 'hello');
		const content = await rt.read_file('/tmp/test.txt');

		assert.strictEqual(content, 'hello');
	});

	test('read_file throws ENOENT for missing files', async () => {
		const rt = create_mock_runtime();

		try {
			await rt.read_file('/nonexistent');
			assert.ok(false, 'should have thrown');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.strictEqual((err as NodeJS.ErrnoException).code, 'ENOENT');
		}
	});

	test('stat returns file info for files', async () => {
		const rt = create_mock_runtime();
		rt.mock_fs.set('/file.txt', 'content');

		const result = await rt.stat('/file.txt');

		assert.ok(result);
		assert.strictEqual(result.is_file, true);
		assert.strictEqual(result.is_directory, false);
	});

	test('stat returns dir info for directories', async () => {
		const rt = create_mock_runtime();
		rt.mock_dirs.add('/mydir');

		const result = await rt.stat('/mydir');

		assert.ok(result);
		assert.strictEqual(result.is_file, false);
		assert.strictEqual(result.is_directory, true);
	});

	test('stat returns null for nonexistent paths', async () => {
		const rt = create_mock_runtime();

		const result = await rt.stat('/nope');

		assert.strictEqual(result, null);
	});

	test('rename moves files', async () => {
		const rt = create_mock_runtime();
		rt.mock_fs.set('/old.txt', 'data');

		await rt.rename('/old.txt', '/new.txt');

		assert.strictEqual(rt.mock_fs.has('/old.txt'), false);
		assert.strictEqual(rt.mock_fs.get('/new.txt'), 'data');
	});

	test('mkdir recursive creates intermediate dirs', async () => {
		const rt = create_mock_runtime();

		await rt.mkdir('/a/b/c', {recursive: true});

		assert.ok(rt.mock_dirs.has('/a'));
		assert.ok(rt.mock_dirs.has('/a/b'));
		assert.ok(rt.mock_dirs.has('/a/b/c'));
	});

	test('remove deletes files and dirs', async () => {
		const rt = create_mock_runtime();
		rt.mock_fs.set('/file', 'x');
		rt.mock_dirs.add('/dir');

		await rt.remove('/file');
		await rt.remove('/dir');

		assert.strictEqual(rt.mock_fs.has('/file'), false);
		assert.strictEqual(rt.mock_dirs.has('/dir'), false);
	});
});

describe('process', () => {
	test('exit throws MockExitError and records code', () => {
		const rt = create_mock_runtime();

		try {
			rt.exit(1);
			assert.ok(false, 'should have thrown');
		} catch (err) {
			assert.ok(err instanceof MockExitError);
			assert.strictEqual(err.code, 1);
		}

		assert.strictEqual(rt.exit_calls.length, 1);
		assert.strictEqual(rt.exit_calls[0], 1);
	});

	test('cwd returns mock path', () => {
		const rt = create_mock_runtime();

		assert.strictEqual(rt.cwd(), '/mock/cwd');
	});
});

describe('commands', () => {
	test('run_command records calls and returns success by default', async () => {
		const rt = create_mock_runtime();

		const result = await rt.run_command('git', ['status']);

		assert.strictEqual(result.success, true);
		assert.strictEqual(result.code, 0);
		assert.strictEqual(rt.command_calls.length, 1);
		assert.strictEqual(rt.command_calls[0]!.cmd, 'git');
	});

	test('run_command returns mock result when configured', async () => {
		const rt = create_mock_runtime();
		rt.mock_command_results.set('git status', {
			success: false,
			code: 1,
			stdout: '',
			stderr: 'fatal',
		});

		const result = await rt.run_command('git', ['status']);

		assert.strictEqual(result.success, false);
		assert.strictEqual(result.code, 1);
	});

	test('run_command_inherit records calls', async () => {
		const rt = create_mock_runtime();

		const code = await rt.run_command_inherit('npm', ['install']);

		assert.strictEqual(code, 0);
		assert.strictEqual(rt.command_inherit_calls.length, 1);
	});
});

describe('terminal I/O', () => {
	test('stdout_write records output', async () => {
		const rt = create_mock_runtime();
		const data = new TextEncoder().encode('hello');

		const written = await rt.stdout_write(data);

		assert.strictEqual(written, 5);
		assert.strictEqual(rt.stdout_writes[0], 'hello');
	});

	test('stdin_read returns null when no buffer', async () => {
		const rt = create_mock_runtime();

		const result = await rt.stdin_read(new Uint8Array(10));

		assert.strictEqual(result, null);
	});

	test('stdin_read consumes buffer once', async () => {
		const rt = create_mock_runtime();
		set_mock_stdin(rt, 'y\n');
		const buf = new Uint8Array(10);

		const n = await rt.stdin_read(buf);

		assert.ok(n);
		assert.strictEqual(new TextDecoder().decode(buf.subarray(0, n)), 'y\n');

		const n2 = await rt.stdin_read(buf);
		assert.strictEqual(n2, null);
	});
});

describe('reset_mock_runtime', () => {
	test('clears all state', () => {
		const rt = create_mock_runtime(['arg']);
		rt.mock_env.set('X', '1');
		rt.mock_fs.set('/f', 'c');
		rt.mock_dirs.add('/d');
		rt.mock_command_results.set('k', {success: true, code: 0, stdout: '', stderr: ''});
		try {
			rt.exit(0);
		} catch {
			// expected
		}

		reset_mock_runtime(rt);

		assert.strictEqual(rt.mock_env.size, 0);
		assert.strictEqual(rt.mock_fs.size, 0);
		assert.strictEqual(rt.mock_dirs.size, 0);
		assert.strictEqual(rt.exit_calls.length, 0);
		assert.strictEqual(rt.command_calls.length, 0);
		assert.strictEqual(rt.stdout_writes.length, 0);
		assert.strictEqual(rt.mock_command_results.size, 0);
		assert.strictEqual(rt.stdin_buffer, null);
	});
});

describe('set_mock_stdin', () => {
	test('encodes string to stdin buffer', () => {
		const rt = create_mock_runtime();

		set_mock_stdin(rt, 'test input');

		assert.ok(rt.stdin_buffer);
		assert.strictEqual(new TextDecoder().decode(rt.stdin_buffer), 'test input');
	});
});

describe('MockExitError', () => {
	test('has correct name and code', () => {
		const err = new MockExitError(42);

		assert.strictEqual(err.name, 'MockExitError');
		assert.strictEqual(err.code, 42);
		assert.strictEqual(err.message, 'exit(42)');
		assert.ok(err instanceof Error);
	});
});
