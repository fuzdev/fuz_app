import {test, assert, describe} from 'vitest';
import {z} from 'zod';

import {get_app_dir, get_config_path, load_config, save_config} from '$lib/cli/config.js';

describe('get_app_dir', () => {
	test('returns ~/.name when HOME is set', () => {
		const runtime = {env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined)};
		assert.strictEqual(get_app_dir(runtime, 'myapp'), '/home/user/.myapp');
	});

	test('returns null when HOME is not set', () => {
		const runtime = {env_get: (_name: string) => undefined};
		assert.strictEqual(get_app_dir(runtime, 'myapp'), null);
	});
});

describe('get_config_path', () => {
	test('returns ~/.name/config.json', () => {
		const runtime = {env_get: (name: string) => (name === 'HOME' ? '/home/user' : undefined)};
		assert.strictEqual(get_config_path(runtime, 'myapp'), '/home/user/.myapp/config.json');
	});

	test('returns null when HOME is not set', () => {
		const runtime = {env_get: (_name: string) => undefined};
		assert.strictEqual(get_config_path(runtime, 'myapp'), null);
	});
});

describe('load_config', () => {
	const TestSchema = z.strictObject({
		name: z.string(),
		port: z.number(),
	});

	test('loads and validates valid config', async () => {
		const runtime = {
			stat: (_path: string) => Promise.resolve({is_file: true, is_directory: false}),
			read_file: (_path: string) => Promise.resolve(JSON.stringify({name: 'test', port: 8080})),
			warn: () => {},
		};
		const result = await load_config(runtime, '/config.json', TestSchema);
		assert.deepStrictEqual(result, {name: 'test', port: 8080});
	});

	test('returns null for missing file', async () => {
		const runtime = {
			stat: (_path: string) => Promise.resolve(null),
			read_file: (_path: string) => Promise.resolve(''),
			warn: () => {},
		};
		const result = await load_config(runtime, '/missing.json', TestSchema);
		assert.strictEqual(result, null);
	});

	test('returns null and warns for invalid JSON', async () => {
		const warnings: Array<string> = [];
		const runtime = {
			stat: (_path: string) => Promise.resolve({is_file: true, is_directory: false}),
			read_file: (_path: string) => Promise.resolve('not json'),
			warn: (...args: Array<unknown>) => {
				warnings.push(args[0] as string);
			},
		};
		const result = await load_config(runtime, '/bad.json', TestSchema);
		assert.strictEqual(result, null);
		assert.strictEqual(warnings.length, 1);
		assert.ok(warnings[0]!.includes('Failed to read config.json'));
	});

	test('returns null and warns for schema mismatch', async () => {
		const warnings: Array<string> = [];
		const runtime = {
			stat: (_path: string) => Promise.resolve({is_file: true, is_directory: false}),
			read_file: (_path: string) => Promise.resolve(JSON.stringify({wrong: 'shape'})),
			warn: (...args: Array<unknown>) => {
				warnings.push(args[0] as string);
			},
		};
		const result = await load_config(runtime, '/wrong.json', TestSchema);
		assert.strictEqual(result, null);
		assert.strictEqual(warnings.length, 1);
		assert.ok(warnings[0]!.includes('Invalid config.json'));
	});
});

describe('save_config', () => {
	test('creates directory and writes JSON with tabs', async () => {
		const calls: Array<{method: string; args: Array<unknown>}> = [];
		const runtime = {
			mkdir: (path: string, options?: {recursive?: boolean}) => {
				calls.push({method: 'mkdir', args: [path, options]});
				return Promise.resolve();
			},
			write_file: (path: string, content: string) => {
				calls.push({method: 'write_file', args: [path, content]});
				return Promise.resolve();
			},
			rename: () => Promise.resolve(),
		};

		await save_config(runtime, '/home/user/.myapp/config.json', '/home/user/.myapp', {
			name: 'test',
		});

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0]!.method, 'mkdir');
		assert.strictEqual(calls[0]!.args[0] as string, '/home/user/.myapp');
		assert.strictEqual(calls[1]!.method, 'write_file');
		assert.strictEqual(calls[1]!.args[0] as string, '/home/user/.myapp/config.json');

		const written = calls[1]!.args[1] as string;
		assert.ok(written.includes('\t')); // uses tabs
		assert.ok(written.endsWith('\n')); // trailing newline

		// roundtrip: written JSON parses back to the original config
		assert.deepStrictEqual(JSON.parse(written), {name: 'test'});
	});
});
