/**
 * Tests for dev/setup.ts — the read helpers, `setup_env_file`, the bootstrap
 * token, and the database helpers over fake `createdb` / `dropdb` program factories.
 *
 * @module
 */

import { test, describe, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	create_database,
	generate_cookie_key,
	read_env_var,
	reset_database,
	reset_bootstrap_token,
	setup_bootstrap_token,
	setup_env_file,
	type SetupLogger
} from '#lib/dev/setup.ts';
import { create_keyring } from '#lib/auth/keyring.ts';
import { parse_dotenv } from '#lib/env/dotenv.ts';
import { create_node_runtime } from '#lib/runtime/node.ts';
import {
	create_mock_program,
	create_mock_program_factory,
	create_mock_runtime,
	mock_program_exit,
	type MockProgramFactory
} from '#lib/runtime/mock.ts';
import type { ProgramOutput } from '#lib/runtime/deps.ts';

const silent_log: SetupLogger = { ok: () => {}, skip: () => {}, error: () => {} };

/** A logger recording each line as `[level] msg`. */
const create_recording_log = (): SetupLogger & { lines: Array<string> } => {
	const lines: Array<string> = [];
	return {
		lines,
		ok: (msg) => lines.push(`[ok] ${msg}`),
		skip: (msg) => lines.push(`[skip] ${msg}`),
		error: (msg) => lines.push(`[error] ${msg}`)
	};
};

/** Run `fn` against a fresh temp dir, removed afterwards. */
const with_temp_dir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
	const dir = await mkdtemp(join(tmpdir(), 'fuz_setup_env_'));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

/** A node runtime whose `HOME` is `home`, so the default state dir lands in a temp dir. */
const create_home_runtime = (home: string) => ({
	...create_node_runtime([]),
	env_get: (name: string) => (name === 'HOME' ? home : undefined)
});

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

describe('setup_bootstrap_token', () => {
	test('writes 32 random bytes as 64 lowercase hex + LF at mode 0600 under ~/.{app_name}', async () => {
		await with_temp_dir(async (dir) => {
			const result = await setup_bootstrap_token(create_home_runtime(dir), 'app', {
				log: silent_log
			});
			const state_dir = join(dir, '.app');
			const token_path = join(state_dir, 'secret_bootstrap_token');
			assert.deepStrictEqual(result, { created: true, token_path });
			assert.match(await readFile(token_path, 'utf-8'), /^[0-9a-f]{64}\n$/);
			assert.strictEqual((await stat(token_path)).mode & 0o777, 0o600);
			assert.strictEqual((await stat(state_dir)).mode & 0o777, 0o700);
			// the atomic write leaves no temp file beside the token
			assert.deepStrictEqual(await readdir(state_dir), ['secret_bootstrap_token']);
		});
	});

	test('keeps an existing token; reset mints a fresh one', async () => {
		await with_temp_dir(async (dir) => {
			const runtime = create_home_runtime(dir);
			const options = { log: silent_log };
			const state_dir = join(dir, '.app');
			const token_path = join(state_dir, 'secret_bootstrap_token');
			await setup_bootstrap_token(runtime, 'app', options);
			const first = await readFile(token_path, 'utf-8');

			const kept = await setup_bootstrap_token(runtime, 'app', options);
			assert.deepStrictEqual(kept, { created: false, token_path });
			assert.strictEqual(await readFile(token_path, 'utf-8'), first);

			const reset = await reset_bootstrap_token(runtime, 'app', options);
			assert.deepStrictEqual(reset, { created: true, token_path });
			const second = await readFile(token_path, 'utf-8');
			assert.match(second, /^[0-9a-f]{64}\n$/);
			assert.notStrictEqual(second, first);
			assert.deepStrictEqual(await readdir(state_dir), ['secret_bootstrap_token']);
		});
	});

	test('renames the token into place', async () => {
		await with_temp_dir(async (dir) => {
			const runtime = create_home_runtime(dir);
			const renamed: Array<string> = [];
			const result = await setup_bootstrap_token(
				{
					...runtime,
					rename: async (old_path, new_path) => {
						renamed.push(new_path);
						await runtime.rename(old_path, new_path);
					}
				},
				'app',
				{ log: silent_log }
			);
			assert.deepStrictEqual(renamed, [result.token_path]);
		});
	});

	test('a `state_dir` works with HOME unset, and the log names the real path', async () => {
		await with_temp_dir(async (dir) => {
			const state_dir = join(dir, 'state');
			const token_path = join(state_dir, 'secret_bootstrap_token');
			const runtime = { ...create_node_runtime([]), env_get: () => undefined };
			const log = create_recording_log();
			const created = await setup_bootstrap_token(runtime, 'app', { state_dir, log });
			assert.deepStrictEqual(created, { created: true, token_path });
			const kept = await setup_bootstrap_token(runtime, 'app', { state_dir, log });
			assert.deepStrictEqual(kept, { created: false, token_path });
			const reset = await reset_bootstrap_token(runtime, 'app', { state_dir, log });
			assert.deepStrictEqual(reset, { created: true, token_path });
			assert.deepStrictEqual(log.lines, [
				`[ok] Created ${token_path} (one-shot, deleted after first use)`,
				`[skip] ${token_path} already exists`,
				`[ok] Removed existing ${token_path}`,
				`[ok] Created ${token_path} (one-shot, deleted after first use)`
			]);
		});
	});

	test('skips with HOME unset and no `state_dir`', async () => {
		const runtime = create_mock_runtime();
		const log = create_recording_log();
		assert.deepStrictEqual(await setup_bootstrap_token(runtime, 'app', { log }), {
			created: false,
			token_path: ''
		});
		assert.deepStrictEqual(await reset_bootstrap_token(runtime, 'app', { log }), {
			created: false,
			token_path: ''
		});
		assert.strictEqual(runtime.mock_fs.size, 0);
		assert.strictEqual(runtime.mock_dirs.size, 0);
		assert.strictEqual(log.lines.length, 2);
	});

	test('a `state_dir` override replaces the HOME default', async () => {
		await with_temp_dir(async (dir) => {
			const state_dir = join(dir, 'state');
			const result = await setup_bootstrap_token(create_home_runtime(dir), 'app', {
				state_dir,
				log: silent_log
			});
			assert.deepStrictEqual(result, {
				created: true,
				token_path: join(state_dir, 'secret_bootstrap_token')
			});
			assert.deepStrictEqual(await readdir(dir), ['state']);
		});
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

/** A clean exit, an already-exists refusal, and the non-exit endings. */
const CREATEDB_EXISTS = mock_program_exit(
	1,
	'createdb: error: database creation failed: ERROR:  database "app" already exists'
);
const TIMED_OUT: ProgramOutput = {
	kind: 'timed_out',
	code: null,
	signal: 'SIGTERM',
	stdout: '',
	stderr: ''
};
const SIGNALED: ProgramOutput = { kind: 'signaled', signal: 'SIGKILL', stdout: '', stderr: '' };
const NO_PASSWORD_SUPPLIED = mock_program_exit(
	2,
	'createdb: error: connection to server at "localhost" (127.0.0.1), port 5432 failed: fe_sendauth: no password supplied'
);

/** A factory over a fake program answering `respond`. */
const factory_of = (respond?: Parameters<typeof create_mock_program>[0]) =>
	create_mock_program_factory(create_mock_program(respond));

/** The calls the program a factory hands out has seen. */
const calls_of = (factory: MockProgramFactory) => factory.program?.calls ?? [];

describe('create_database', () => {
	test('creates the database on the server the URL names, its password in the environment', async () => {
		const createdb = factory_of();
		const log = create_recording_log();
		const result = await create_database(
			{ createdb },
			'postgresql://role:s%40cret@db.local:5433/app?sslmode=require',
			{ log }
		);
		assert.deepStrictEqual(result, { kind: 'created', database: 'app' });
		assert.deepStrictEqual(createdb.envs, [{ PGPASSWORD: 's@cret' }]);
		assert.deepStrictEqual(calls_of(createdb), [
			[
				'--no-password',
				'--maintenance-db=postgresql://role@db.local:5433/postgres?sslmode=require',
				'--',
				'app'
			]
		]);
		assert.deepStrictEqual(log.lines, ['[ok] Created app database']);
	});

	test('a URL with no password makes the program with no extra environment', async () => {
		const createdb = factory_of();
		await create_database({ createdb }, 'postgres://localhost/app', { log: silent_log });
		assert.deepStrictEqual(createdb.envs, [{}]);
	});

	test('the password never reaches argv, the log, or the result, on any path', async () => {
		const password = 'Hunter2-unique-p4ss';
		const encoded = encodeURIComponent(password);
		for (const [output, url] of [
			[mock_program_exit(0), `postgres://u:${encoded}@h/app`],
			[CREATEDB_EXISTS, `postgres://u:${encoded}@h/app`],
			[
				mock_program_exit(1, 'password authentication failed for user "u"'),
				`postgres://h/app?password=${encoded}`
			],
			[TIMED_OUT, `postgres://u:x@h/app?sslmode=disable&password=${encoded}`]
		] as const) {
			const createdb = factory_of(() => output);
			const log = create_recording_log();
			const result = await create_database({ createdb }, url, { log });
			const seen = JSON.stringify([calls_of(createdb), log.lines, result]);
			assert.notInclude(seen, password, url);
			assert.notInclude(seen, encoded, url);
			assert.deepStrictEqual(createdb.envs, [{ PGPASSWORD: password }], url);
		}
	});

	test('query parameters reach createdb with their encoding intact', async () => {
		// libpq decodes only percent-escapes, so a space re-encoded as `+` would arrive as a plus
		const createdb = factory_of();
		await create_database(
			{ createdb },
			'postgres://h/app?options=-c%20search_path%3Dapp&host=/run/a%20b&password=pw',
			{ log: silent_log }
		);
		assert.strictEqual(
			calls_of(createdb)[0]![1],
			'--maintenance-db=postgres://h/postgres?options=-c%20search_path%3Dapp&host=/run/a%20b'
		);
		assert.deepStrictEqual(createdb.envs, [{ PGPASSWORD: 'pw' }]);
	});

	test('a database named postgres is created through template1', async () => {
		const createdb = factory_of();
		await create_database({ createdb }, 'postgres://h/postgres', { log: silent_log });
		assert.strictEqual(calls_of(createdb)[0]![1], '--maintenance-db=postgres://h/template1');
	});

	test('a database name that looks like a flag stays an operand', async () => {
		const createdb = factory_of();
		await create_database({ createdb }, 'postgres://localhost/-x', { log: silent_log });
		assert.deepStrictEqual(calls_of(createdb)[0]!.slice(-2), ['--', '-x']);
	});

	test('an existing database is the quiet success case', async () => {
		const createdb = factory_of(() => CREATEDB_EXISTS);
		const log = create_recording_log();
		const result = await create_database({ createdb }, 'postgres://localhost/app', { log });
		assert.deepStrictEqual(result, { kind: 'exists', database: 'app' });
		assert.deepStrictEqual(log.lines, ['[skip] app database already exists']);
	});

	test('any other failure is reported with its stderr, not as already existing', async () => {
		const createdb = factory_of(() =>
			mock_program_exit(1, 'createdb: error: permission denied to create database\n')
		);
		const log = create_recording_log();
		const result = await create_database({ createdb }, 'postgres://localhost/app', { log });
		assert.strictEqual(result.kind, 'failed');
		assert.deepStrictEqual(log.lines, [
			'[error] Failed to create database app: createdb: error: permission denied to create database'
		]);
	});

	test('a server wanting a password the URL lacks gets the hint', async () => {
		const result = await create_database(
			{ createdb: factory_of(() => NO_PASSWORD_SUPPLIED) },
			'postgres://localhost/app',
			{ log: silent_log }
		);
		assert.ok(result.kind === 'failed');
		assert.include(result.message, 'DATABASE_URL has no password');
	});

	test('no hint when the URL carried the password, or the failure is not about one', async () => {
		for (const [output, url] of [
			[
				mock_program_exit(1, 'password authentication failed for user "u"'),
				'postgres://u:pw@h/app'
			],
			[mock_program_exit(1, 'permission denied to create database'), 'postgres://h/app']
		] as const) {
			const result = await create_database({ createdb: factory_of(() => output) }, url, {
				log: silent_log
			});
			assert.ok(result.kind === 'failed');
			assert.notInclude(result.message, 'DATABASE_URL has no password', url);
		}
	});

	test('a password with a malformed percent-escape fails before anything runs', async () => {
		const createdb = factory_of();
		const result = await create_database({ createdb }, 'postgres://u:p%ZZ@h/app', {
			log: silent_log
		});
		assert.deepStrictEqual(result, {
			kind: 'failed',
			message: "DATABASE_URL's password has a malformed percent-escape"
		});
		assert.deepStrictEqual(createdb.envs, []);
	});

	test('a timeout or a signal is a failure that says how it ended', async () => {
		for (const [output, expected] of [
			[TIMED_OUT, 'timed out'],
			[SIGNALED, 'ended by SIGKILL'],
			[mock_program_exit(3), 'exited with code 3']
		] as const) {
			const result = await create_database(
				{ createdb: factory_of(() => output) },
				'postgres://localhost/app',
				{ log: silent_log }
			);
			assert.deepStrictEqual(result, {
				kind: 'failed',
				message: `Failed to create database app: ${expected}`
			});
		}
	});

	test('no createdb installed is skipped with the install hint', async () => {
		const log = create_recording_log();
		const result = await create_database(
			{ createdb: create_mock_program_factory(null) },
			'postgres://localhost/app',
			{ log }
		);
		assert.strictEqual(result.kind, 'skipped');
		assert.strictEqual(log.lines.length, 1);
		assert.match(log.lines[0]!, /^\[skip\] createdb not found — install PostgreSQL/);
	});

	test('a URL that is not Postgres makes and runs nothing', async () => {
		for (const [url, db_type] of [
			['file:///tmp/pglite', 'pglite'],
			['memory://', 'memory'],
			['', 'none'],
			['mysql://localhost/app', 'none']
		] as const) {
			const createdb = factory_of();
			const result = await create_database({ createdb }, url, { log: silent_log });
			assert.strictEqual(result.kind, 'skipped', url);
			assert.ok(result.kind === 'skipped' && result.db_type === db_type, url);
			assert.deepStrictEqual(createdb.envs, [], url);
		}
	});

	test('a Postgres URL naming no database runs nothing', async () => {
		const createdb = factory_of();
		const result = await create_database({ createdb }, 'postgres://localhost', {
			log: silent_log
		});
		assert.strictEqual(result.kind, 'failed');
		assert.deepStrictEqual(createdb.envs, []);
	});

	test('a createdb that cannot start throws', async () => {
		const createdb = factory_of(() => {
			throw new Error('launch_failed');
		});
		await assert_rejects(
			() => create_database({ createdb }, 'postgres://localhost/app', { log: silent_log }),
			/launch_failed/
		);
	});
});

describe('reset_database', () => {
	const fs_unused = {
		stat: () => Promise.reject(new Error('stat must not be called')),
		remove: () => Promise.reject(new Error('remove must not be called'))
	};

	test('drops and recreates on the server the URL names, its password in the environment', async () => {
		const createdb = factory_of();
		const dropdb = factory_of();
		const log = create_recording_log();
		const result = await reset_database(
			{ ...fs_unused, createdb, dropdb },
			'postgres://role:secret@db.local:5433/app',
			{ log }
		);
		assert.deepStrictEqual(result, { reset: true, skipped: false, db_type: 'postgres' });
		const maintenance_db = '--maintenance-db=postgres://role@db.local:5433/postgres';
		assert.deepStrictEqual(calls_of(dropdb), [
			['--if-exists', '--no-password', maintenance_db, '--', 'app']
		]);
		assert.deepStrictEqual(calls_of(createdb), [['--no-password', maintenance_db, '--', 'app']]);
		assert.deepStrictEqual(dropdb.envs, [{ PGPASSWORD: 'secret' }]);
		assert.deepStrictEqual(createdb.envs, [{ PGPASSWORD: 'secret' }]);
		assert.notInclude(JSON.stringify([calls_of(dropdb), calls_of(createdb), log.lines]), 'secret');
		assert.deepStrictEqual(log.lines, ['[ok] Dropped database: app', '[ok] Created database: app']);
	});

	test('a database named postgres is dropped and created through template1', async () => {
		const createdb = factory_of();
		const dropdb = factory_of();
		await reset_database({ ...fs_unused, createdb, dropdb }, 'postgres://h/postgres', {
			log: silent_log
		});
		assert.strictEqual(calls_of(dropdb)[0]![2], '--maintenance-db=postgres://h/template1');
		assert.strictEqual(calls_of(createdb)[0]![1], '--maintenance-db=postgres://h/template1');
	});

	test('a failed drop stops before createdb', async () => {
		const createdb = factory_of();
		const dropdb = factory_of(() =>
			mock_program_exit(1, 'dropdb: error: database "app" is being accessed by other users')
		);
		const log = create_recording_log();
		const result = await reset_database(
			{ ...fs_unused, createdb, dropdb },
			'postgres://localhost/app',
			{ log }
		);
		assert.deepStrictEqual(result, { reset: false, skipped: false, db_type: 'postgres' });
		assert.deepStrictEqual(calls_of(createdb), []);
		assert.deepStrictEqual(log.lines, [
			'[error] Failed to drop database: dropdb: error: database "app" is being accessed by other users'
		]);
	});

	test('a failed or timed-out create is not a reset', async () => {
		for (const output of [mock_program_exit(1, 'boom'), TIMED_OUT, SIGNALED]) {
			const result = await reset_database(
				{ ...fs_unused, createdb: factory_of(() => output), dropdb: factory_of() },
				'postgres://localhost/app',
				{ log: silent_log }
			);
			assert.deepStrictEqual(result, { reset: false, skipped: false, db_type: 'postgres' });
		}
	});

	test('a missing program fails before anything runs', async () => {
		for (const [has_createdb, has_dropdb, missing] of [
			[true, false, 'dropdb'],
			[false, true, 'createdb'],
			[false, false, 'dropdb and createdb']
		] as const) {
			const program = create_mock_program();
			const log = create_recording_log();
			const result = await reset_database(
				{
					...fs_unused,
					createdb: create_mock_program_factory(has_createdb ? program : null),
					dropdb: create_mock_program_factory(has_dropdb ? program : null)
				},
				'postgres://localhost/app',
				{ log }
			);
			assert.deepStrictEqual(result, { reset: false, skipped: false, db_type: 'postgres' });
			assert.deepStrictEqual(program.calls, []);
			assert.deepStrictEqual(log.lines, [
				`[error] ${missing} not found — install PostgreSQL to reset a Postgres database`
			]);
		}
	});

	test('a file:// URL removes only the named PGlite directory', async () => {
		const runtime = create_mock_runtime();
		runtime.mock_dirs.add('/data/pglite');
		runtime.mock_fs.set('/data/pglite/PG_VERSION', '17');
		const programs = { createdb: factory_of(), dropdb: factory_of() };
		const result = await reset_database(
			{ stat: runtime.stat, remove: runtime.remove, ...programs },
			'file:///data/pglite',
			{ pglite_data_dir: '/data/pglite', log: silent_log }
		);
		assert.deepStrictEqual(result, { reset: true, skipped: false, db_type: 'pglite' });
		assert.strictEqual(runtime.mock_fs.size, 0);
		assert.deepStrictEqual([...programs.createdb.envs, ...programs.dropdb.envs], []);

		const without_dir = await reset_database(
			{ stat: runtime.stat, remove: runtime.remove, ...programs },
			'file:///data/pglite',
			{ log: silent_log }
		);
		assert.deepStrictEqual(without_dir, { reset: false, skipped: true, db_type: 'pglite' });
	});

	test('memory, empty, and unsupported URLs make and run nothing', async () => {
		for (const [url, expected] of [
			['memory://', { reset: false, skipped: true, db_type: 'memory' }],
			['', { reset: false, skipped: true, db_type: 'none' }],
			['pglite', { reset: false, skipped: false, db_type: 'none' }],
			['mysql://localhost/app', { reset: false, skipped: false, db_type: 'none' }]
		] as const) {
			const programs = { createdb: factory_of(), dropdb: factory_of() };
			const result = await reset_database({ ...fs_unused, ...programs }, url, {
				log: silent_log
			});
			assert.deepStrictEqual(result, expected, url);
			assert.deepStrictEqual([...programs.createdb.envs, ...programs.dropdb.envs], [], url);
		}
	});

	test('a Postgres URL naming no database runs nothing', async () => {
		const programs = { createdb: factory_of(), dropdb: factory_of() };
		const result = await reset_database({ ...fs_unused, ...programs }, 'postgres://localhost', {
			log: silent_log
		});
		assert.deepStrictEqual(result, { reset: false, skipped: false, db_type: 'postgres' });
		assert.deepStrictEqual([...programs.createdb.envs, ...programs.dropdb.envs], []);
	});
});
