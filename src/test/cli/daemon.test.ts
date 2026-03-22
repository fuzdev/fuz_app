import {test, assert, describe} from 'vitest';

import {
	DaemonInfo,
	get_daemon_info_path,
	read_daemon_info,
	write_daemon_info,
	is_daemon_running,
	stop_daemon,
} from '$lib/cli/daemon.js';

const MOCK_INFO: DaemonInfo = {
	version: 1,
	pid: 12345,
	port: 4460,
	started: '2026-01-01T00:00:00.000Z',
	app_version: '0.1.0',
};

describe('DaemonInfo schema', () => {
	test('validates correct data', () => {
		const result = DaemonInfo.safeParse(MOCK_INFO);
		assert.strictEqual(result.success, true);
	});

	test('rejects missing fields', () => {
		const result = DaemonInfo.safeParse({version: 1, pid: 123});
		assert.strictEqual(result.success, false);
	});

	test('rejects extra fields', () => {
		const result = DaemonInfo.safeParse({...MOCK_INFO, extra: 'field'});
		assert.strictEqual(result.success, false);
	});
});

describe('get_daemon_info_path', () => {
	test('returns ~/.name/run/daemon.json', () => {
		const runtime = {env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined)};
		assert.strictEqual(get_daemon_info_path(runtime, 'zzz'), '/home/user/.zzz/run/daemon.json');
	});

	test('returns null when HOME is not set', () => {
		const runtime = {env_get: (_name: string) => undefined};
		assert.strictEqual(get_daemon_info_path(runtime, 'zzz'), null);
	});
});

describe('write_daemon_info', () => {
	test('creates run directory and writes atomically via temp + rename', async () => {
		const calls: Array<{method: string; args: Array<unknown>}> = [];
		const runtime = {
			env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined),
			env_set: () => undefined,
			mkdir: (path: string, options?: {recursive?: boolean}) => {
				calls.push({method: 'mkdir', args: [path, options]});
				return Promise.resolve();
			},
			write_file: (path: string, content: string) => {
				calls.push({method: 'write_file', args: [path, content]});
				return Promise.resolve();
			},
			rename: (old_path: string, new_path: string) => {
				calls.push({method: 'rename', args: [old_path, new_path]});
				return Promise.resolve();
			},
		};

		await write_daemon_info(runtime, 'zzz', MOCK_INFO);

		assert.strictEqual(calls.length, 3);
		assert.strictEqual(calls[0]!.method, 'mkdir');
		assert.ok((calls[0]!.args[0] as string).endsWith('.zzz/run'));
		assert.strictEqual(calls[1]!.method, 'write_file');
		assert.ok((calls[1]!.args[0] as string).endsWith('daemon.json.tmp'));
		assert.strictEqual(calls[2]!.method, 'rename');
		assert.ok((calls[2]!.args[0] as string).endsWith('daemon.json.tmp'));
		assert.ok((calls[2]!.args[1] as string).endsWith('daemon.json'));

		const written = JSON.parse(calls[1]!.args[1] as string);
		assert.strictEqual(written.pid, 12345);
	});

	test('throws when HOME is not set', async () => {
		const runtime = {
			env_get: () => undefined,
			env_set: () => undefined,
			mkdir: () => Promise.resolve(),
			write_file: () => Promise.resolve(),
			rename: () => Promise.resolve(),
		};

		try {
			await write_daemon_info(runtime, 'zzz', MOCK_INFO);
			assert.fail('should have thrown');
		} catch (err) {
			assert.ok((err as Error).message.includes('$HOME'));
		}
	});
});

describe('read_daemon_info', () => {
	test('reads and validates daemon info', async () => {
		const runtime = {
			env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined),
			env_set: () => undefined,
			stat: (_path: string) => Promise.resolve({is_file: true, is_directory: false}),
			read_file: (_path: string) => Promise.resolve(JSON.stringify(MOCK_INFO)),
			warn: () => {},
		};

		const result = await read_daemon_info(runtime, 'zzz');
		assert.deepStrictEqual(result, MOCK_INFO);
	});

	test('returns null when file missing', async () => {
		const runtime = {
			env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined),
			env_set: () => undefined,
			stat: (_path: string) => Promise.resolve(null),
			read_file: (_path: string) => Promise.resolve(''),
			warn: () => {},
		};

		const result = await read_daemon_info(runtime, 'zzz');
		assert.strictEqual(result, null);
	});

	test('returns null for invalid JSON', async () => {
		const runtime = {
			env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined),
			env_set: () => undefined,
			stat: (_path: string) => Promise.resolve({is_file: true, is_directory: false}),
			read_file: (_path: string) => Promise.resolve('bad json'),
			warn: () => {},
		};

		const result = await read_daemon_info(runtime, 'zzz');
		assert.strictEqual(result, null);
	});
});

describe('is_daemon_running', () => {
	test('returns true when process exists', async () => {
		const runtime = {
			run_command: (_cmd: string, _args: Array<string>) =>
				Promise.resolve({
					success: true,
					code: 0,
					stdout: '',
					stderr: '',
				}),
		};
		assert.strictEqual(await is_daemon_running(runtime, 12345), true);
	});

	test('returns false when process does not exist', async () => {
		const runtime = {
			run_command: (_cmd: string, _args: Array<string>) =>
				Promise.resolve({
					success: false,
					code: 1,
					stdout: '',
					stderr: 'No such process',
				}),
		};
		assert.strictEqual(await is_daemon_running(runtime, 99999), false);
	});
});

describe('stop_daemon', () => {
	test('stops a running daemon', async () => {
		const removed: Array<string> = [];
		const runtime = {
			env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined),
			env_set: () => undefined,
			stat: (_path: string) => Promise.resolve({is_file: true, is_directory: false}),
			read_file: (_path: string) => Promise.resolve(JSON.stringify(MOCK_INFO)),
			run_command: (_cmd: string, _args: Array<string>) =>
				Promise.resolve({
					success: true,
					code: 0,
					stdout: '',
					stderr: '',
				}),
			remove: (path: string) => {
				removed.push(path);
				return Promise.resolve();
			},
			warn: () => {},
		};

		const result = await stop_daemon(runtime, 'zzz');
		assert.strictEqual(result.stopped, true);
		assert.strictEqual(result.pid, 12345);
		assert.ok(result.message.includes('Stopped'));
		assert.strictEqual(removed.length, 1);
		assert.strictEqual(removed[0], '/home/user/.zzz/run/daemon.json');
	});

	test('cleans up when process not running', async () => {
		const runtime = {
			env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined),
			env_set: () => undefined,
			stat: (_path: string) => Promise.resolve({is_file: true, is_directory: false}),
			read_file: (_path: string) => Promise.resolve(JSON.stringify(MOCK_INFO)),
			run_command: (_cmd: string, _args: Array<string>) =>
				Promise.resolve({
					success: false,
					code: 1,
					stdout: '',
					stderr: '',
				}),
			remove: (_path: string) => Promise.resolve(),
			warn: () => {},
		};

		const result = await stop_daemon(runtime, 'zzz');
		assert.strictEqual(result.stopped, false);
		assert.ok(result.message.includes('not running'));
	});

	test('returns message when no daemon.json', async () => {
		const runtime = {
			env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined),
			env_set: () => undefined,
			stat: (_path: string) => Promise.resolve(null),
			read_file: (_path: string) => Promise.resolve(''),
			run_command: () => Promise.resolve({success: false, code: 1, stdout: '', stderr: ''}),
			remove: (_path: string) => Promise.resolve(),
			warn: () => {},
		};

		const result = await stop_daemon(runtime, 'zzz');
		assert.strictEqual(result.stopped, false);
		assert.ok(result.message.includes('No daemon'));
	});

	test('returns message when HOME not set', async () => {
		const runtime = {
			env_get: () => undefined,
			env_set: () => undefined,
			stat: () => Promise.resolve(null),
			read_file: () => Promise.resolve(''),
			run_command: () => Promise.resolve({success: false, code: 1, stdout: '', stderr: ''}),
			remove: () => Promise.resolve(),
			warn: () => {},
		};

		const result = await stop_daemon(runtime, 'zzz');
		assert.strictEqual(result.stopped, false);
		assert.ok(result.message.includes('$HOME'));
	});
});
