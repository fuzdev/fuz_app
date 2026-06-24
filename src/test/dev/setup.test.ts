/**
 * Tests for dev/setup.ts read helpers.
 *
 * @module
 */

import {test, describe, assert} from 'vitest';

import {read_env_var} from '$lib/dev/setup.ts';

describe('read_env_var', () => {
	test('reads a present variable', async () => {
		const deps = {
			read_text_file: (_path: string) =>
				Promise.resolve('FOO=bar\nDATABASE_URL=postgres://host:5432/db'),
		};
		assert.strictEqual(
			await read_env_var(deps, '/.env', 'DATABASE_URL'),
			'postgres://host:5432/db',
		);
	});

	test('strips surrounding quotes via the shared parser', async () => {
		const deps = {read_text_file: (_path: string) => Promise.resolve('FOO="quoted value"')};
		assert.strictEqual(await read_env_var(deps, '/.env', 'FOO'), 'quoted value');
	});

	test('returns undefined for a missing variable', async () => {
		const deps = {read_text_file: (_path: string) => Promise.resolve('FOO=bar')};
		assert.strictEqual(await read_env_var(deps, '/.env', 'NOPE'), undefined);
	});

	test('inherits `export ` tolerance and inline-comment stripping from the shared parser', async () => {
		const deps = {
			read_text_file: (_path: string) =>
				Promise.resolve('export DATABASE_URL=postgres://host/db # primary'),
		};
		assert.strictEqual(await read_env_var(deps, '/.env', 'DATABASE_URL'), 'postgres://host/db');
	});

	test('returns an empty string for an explicitly empty value', async () => {
		// `KEY=` is set-but-empty (distinct from absent → undefined); the old
		// single-var regex returned undefined here, the shared parser returns ''.
		const deps = {read_text_file: (_path: string) => Promise.resolve('FOO=')};
		assert.strictEqual(await read_env_var(deps, '/.env', 'FOO'), '');
	});

	test('returns undefined when the file is absent', async () => {
		const err: any = new Error('not found');
		err.code = 'ENOENT';
		const deps = {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			read_text_file: (_path: string): Promise<string> => Promise.reject(err),
		};
		assert.strictEqual(await read_env_var(deps, '/missing', 'FOO'), undefined);
	});

	test('propagates a read error other than the file not existing', async () => {
		const err: any = new Error('permission denied');
		err.code = 'EACCES';
		const deps = {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			read_text_file: (_path: string): Promise<string> => Promise.reject(err),
		};
		let thrown: unknown;
		try {
			await read_env_var(deps, '/denied', 'FOO');
		} catch (e) {
			thrown = e;
		}
		assert.instanceOf(thrown, Error);
		assert.match((thrown as Error).message, /permission denied/);
	});
});
