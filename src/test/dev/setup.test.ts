/**
 * Tests for dev/setup.ts — the read helpers and `setup_env_file`.
 *
 * @module
 */

import { test, describe, assert } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	generate_cookie_key,
	read_env_var,
	setup_env_file,
	type SetupLogger
} from '#lib/dev/setup.ts';
import { create_keyring } from '#lib/auth/keyring.ts';
import { parse_dotenv } from '#lib/env/dotenv.ts';
import { create_node_runtime } from '#lib/runtime/node.ts';

const silent_log: SetupLogger = { ok: () => {}, skip: () => {}, error: () => {} };

/** Run `fn` against a fresh temp dir, removed afterwards. */
const with_temp_dir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
	const dir = await mkdtemp(join(tmpdir(), 'fuz_setup_env_'));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

/** A value `String.replace` would splice and an unquoted write would truncate. */
const TRICKY_DATABASE_URL = `postgres://app:p$'a$&s$\`s "q" #x@localhost:5432/app db`;

describe('setup_env_file', () => {
	test('creates from the example: generates the cookie key, writes replacements verbatim', async () => {
		await with_temp_dir(async (dir) => {
			const example = join(dir, '.env.example');
			const env_path = join(dir, '.env');
			await writeFile(
				example,
				'# app env\nNODE_ENV=development\nSECRET_FUZ_COOKIE_KEYS=\nDATABASE_URL=\nUNSET_KEY=\n'
			);
			const result = await setup_env_file(create_node_runtime(), env_path, example, {
				replacements: { DATABASE_URL: async () => TRICKY_DATABASE_URL },
				log: silent_log
			});
			assert.deepStrictEqual(result, { created: true, updated: true, path: env_path });

			const content = await readFile(env_path, 'utf-8');
			const env = parse_dotenv(content);
			assert.strictEqual(env.DATABASE_URL, TRICKY_DATABASE_URL);
			assert.strictEqual(env.NODE_ENV, 'development');
			assert.strictEqual(env.UNSET_KEY, '', 'a key with no generator is left empty');
			assert.match(env.SECRET_FUZ_COOKIE_KEYS!, /^[0-9a-f]{64}$/);
			assert.ok(
				create_keyring(env.SECRET_FUZ_COOKIE_KEYS).ok,
				'the generated key is a valid keyring'
			);
			assert.ok(content.startsWith('# app env\nNODE_ENV=development\n'));
			assert.strictEqual((await stat(env_path)).mode & 0o777, 0o600);
		});
	});

	test('backfills only empty values in an existing file, then is a no-op', async () => {
		await with_temp_dir(async (dir) => {
			const env_path = join(dir, '.env');
			await writeFile(
				env_path,
				'SECRET_FUZ_COOKIE_KEYS=existing_key_that_is_at_least_32_chars\nDATABASE_URL= # fill me\n'
			);
			const runtime = create_node_runtime();
			const options = {
				replacements: {
					DATABASE_URL: async () => TRICKY_DATABASE_URL,
					NOT_IN_FILE: async () => 'never written'
				},
				log: silent_log
			};
			const first = await setup_env_file(runtime, env_path, join(dir, 'unused'), options);
			assert.deepStrictEqual(first, { created: false, updated: true, path: env_path });
			const content = await readFile(env_path, 'utf-8');
			assert.deepStrictEqual(parse_dotenv(content), {
				SECRET_FUZ_COOKIE_KEYS: 'existing_key_that_is_at_least_32_chars',
				DATABASE_URL: TRICKY_DATABASE_URL
			});
			assert.ok(content.includes(' # fill me'), 'the inline comment is kept');

			const second = await setup_env_file(runtime, env_path, join(dir, 'unused'), options);
			assert.deepStrictEqual(second, { created: false, updated: false, path: env_path });
			assert.strictEqual(await readFile(env_path, 'utf-8'), content);
		});
	});
});

describe('generate_cookie_key', () => {
	test('is 32 random bytes in hex, never containing the `__` key separator', () => {
		const key = generate_cookie_key();
		assert.match(key, /^[0-9a-f]{64}$/);
		assert.notStrictEqual(generate_cookie_key(), key);
	});
});

describe('read_env_var', () => {
	test('reads a present variable', async () => {
		const deps = {
			read_text_file: (_path: string) =>
				Promise.resolve('FOO=bar\nDATABASE_URL=postgres://host:5432/db')
		};
		assert.strictEqual(
			await read_env_var(deps, '/.env', 'DATABASE_URL'),
			'postgres://host:5432/db'
		);
	});

	test('strips surrounding quotes via the shared parser', async () => {
		const deps = { read_text_file: (_path: string) => Promise.resolve('FOO="quoted value"') };
		assert.strictEqual(await read_env_var(deps, '/.env', 'FOO'), 'quoted value');
	});

	test('returns undefined for a missing variable', async () => {
		const deps = { read_text_file: (_path: string) => Promise.resolve('FOO=bar') };
		assert.strictEqual(await read_env_var(deps, '/.env', 'NOPE'), undefined);
	});

	test('inherits `export ` tolerance and inline-comment stripping from the shared parser', async () => {
		const deps = {
			read_text_file: (_path: string) =>
				Promise.resolve('export DATABASE_URL=postgres://host/db # primary')
		};
		assert.strictEqual(await read_env_var(deps, '/.env', 'DATABASE_URL'), 'postgres://host/db');
	});

	test('returns an empty string for an explicitly empty value', async () => {
		// `KEY=` is set-but-empty (distinct from absent → undefined); the old
		// single-var regex returned undefined here, the shared parser returns ''.
		const deps = { read_text_file: (_path: string) => Promise.resolve('FOO=') };
		assert.strictEqual(await read_env_var(deps, '/.env', 'FOO'), '');
	});

	test('returns undefined when the file is absent', async () => {
		const err: any = new Error('not found');
		err.code = 'ENOENT';
		const deps = {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			read_text_file: (_path: string): Promise<string> => Promise.reject(err)
		};
		assert.strictEqual(await read_env_var(deps, '/missing', 'FOO'), undefined);
	});

	test('propagates a read error other than the file not existing', async () => {
		const err: any = new Error('permission denied');
		err.code = 'EACCES';
		const deps = {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			read_text_file: (_path: string): Promise<string> => Promise.reject(err)
		};
		let thrown: unknown;
		try {
			await read_env_var(deps, '/denied', 'FOO');
		} catch (e) {
			thrown = e;
		}
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /permission denied/);
	});
});
