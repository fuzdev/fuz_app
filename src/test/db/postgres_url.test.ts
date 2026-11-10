/**
 * Tests for db/postgres_url.ts — the database name, the maintenance URL, the
 * password environment, the already-exists predicate, and the client argv.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	is_createdb_already_exists,
	parse_db_name,
	rewrite_query_pairs,
	to_createdb_args,
	to_dropdb_args,
	to_maintenance_database_name,
	to_maintenance_database_url,
	to_postgres_password_env
} from '#lib/db/postgres_url.ts';

describe('parse_db_name', () => {
	test('reads and decodes the database of a Postgres URL', () => {
		assert.strictEqual(parse_db_name('postgres://localhost/app'), 'app');
		assert.strictEqual(parse_db_name('postgresql://u:p@h:5433/app%20db?sslmode=disable'), 'app db');
		assert.strictEqual(parse_db_name('postgres:///app'), 'app');
	});

	test('is null for no database, a non-Postgres URL, or a bad one', () => {
		for (const url of [
			'postgres://localhost',
			'postgres://localhost/',
			'file:///tmp/data',
			'memory://',
			'not a url',
			'postgres://localhost/%E0%A4%A'
		]) {
			assert.strictEqual(parse_db_name(url), null, url);
		}
	});
});

describe('to_maintenance_database_url', () => {
	test('swaps in the postgres database and drops the password, keeping the rest', () => {
		assert.strictEqual(
			to_maintenance_database_url(
				'postgresql://role:pw@db.local:5433/app?sslmode=require&password=pw2',
				'app'
			),
			'postgresql://role@db.local:5433/postgres?sslmode=require'
		);
	});

	test('keeps every other query pair byte for byte', () => {
		// a `URLSearchParams` rewrite would turn each `%20` into `+`, which libpq reads literally
		for (const [url, expected] of [
			[
				'postgres://h/app?options=-c%20search_path%3Dapp',
				'postgres://h/postgres?options=-c%20search_path%3Dapp'
			],
			['postgres:///app?host=/run/a%20b&password=x', 'postgres:///postgres?host=/run/a%20b'],
			['postgres://h/app?pass%77ord=x&a=1', 'postgres://h/postgres?a=1'],
			['postgres://h/app?password=x', 'postgres://h/postgres'],
			['postgres://h/app', 'postgres://h/postgres'],
			// libpq would read `#x` as part of the database name
			['postgres://h/app?a=1#x', 'postgres://h/postgres?a=1']
		] as const) {
			assert.strictEqual(to_maintenance_database_url(url, 'app'), expected, url);
		}
	});

	test('uses template1 to reach a database named postgres', () => {
		assert.strictEqual(to_maintenance_database_name('postgres'), 'template1');
		assert.strictEqual(to_maintenance_database_name('app'), 'postgres');
		assert.strictEqual(
			to_maintenance_database_url('postgres://h/postgres', 'postgres'),
			'postgres://h/template1'
		);
	});
});

describe('rewrite_query_pairs', () => {
	test('replaces and drops pairs by their decoded key, leaving the others as written', () => {
		const url = new URL('postgres://h/app?a=1%202&pass%77ord=x&&b=%2B');
		rewrite_query_pairs(url, (pair, key) =>
			key === 'password' ? 'password=REDACTED' : key === 'b' ? null : pair
		);
		assert.strictEqual(url.href, 'postgres://h/app?a=1%202&password=REDACTED');
	});

	test('a pair with a malformed escape in its key gets a null key', () => {
		const keys: Array<string | null> = [];
		rewrite_query_pairs(new URL('postgres://h/app?%ZZ=1'), (pair, key) => {
			keys.push(key);
			return pair;
		});
		assert.deepStrictEqual(keys, [null]);
	});
});

describe('to_postgres_password_env', () => {
	test('carries a userinfo password, decoded', () => {
		assert.deepStrictEqual(to_postgres_password_env('postgres://u:p%40ss%2Fw@h/app'), {
			PGPASSWORD: 'p@ss/w'
		});
		assert.deepStrictEqual(to_postgres_password_env('postgres://:only@h/app'), {
			PGPASSWORD: 'only'
		});
	});

	test('a password parameter wins over the userinfo, decoded as libpq decodes it', () => {
		assert.deepStrictEqual(to_postgres_password_env('postgres://u:a@h/app?password=b%20c+d'), {
			PGPASSWORD: 'b c+d'
		});
	});

	test('the last password parameter wins, and only the exact key `password` counts', () => {
		assert.deepStrictEqual(to_postgres_password_env('postgres://h/app?password=a&password=b'), {
			PGPASSWORD: 'b'
		});
		// libpq's keys are case-sensitive: `Password` is no password parameter
		assert.deepStrictEqual(to_postgres_password_env('postgres://u:a@h/app?Password=b'), {
			PGPASSWORD: 'a'
		});
	});

	test('is empty for a URL with no password', () => {
		assert.deepStrictEqual(to_postgres_password_env('postgres://u@h/app'), {});
		assert.deepStrictEqual(to_postgres_password_env('postgres:///app'), {});
	});

	test('is null for a malformed percent-escape', () => {
		assert.strictEqual(to_postgres_password_env('postgres://u:p%ZZ@h/app'), null);
		assert.strictEqual(to_postgres_password_env('postgres://h/app?password=%E0%A4%A'), null);
	});
});

describe('is_createdb_already_exists', () => {
	test("reads createdb's already-exists refusal of that database only", () => {
		assert.ok(
			is_createdb_already_exists(
				'createdb: error: database creation failed: ERROR:  database "app_test" already exists',
				'app_test'
			)
		);
		assert.ok(
			!is_createdb_already_exists(
				'createdb: error: database creation failed: ERROR:  database "other" already exists',
				'app_test'
			)
		);
		assert.ok(
			!is_createdb_already_exists(
				'createdb: error: connection to server on socket "/x/.s.PGSQL.5432" failed',
				'app_test'
			)
		);
	});
});

describe('client argv', () => {
	test('createdb never prompts and ends options before the name', () => {
		assert.deepStrictEqual(to_createdb_args('-x'), ['--no-password', '--', '-x']);
		assert.deepStrictEqual(to_createdb_args('app', 'postgres://u:pw@h:5433/other'), [
			'--no-password',
			'--maintenance-db=postgres://u@h:5433/postgres',
			'--',
			'app'
		]);
	});

	test('dropdb drops only an existing database, through the maintenance URL', () => {
		assert.deepStrictEqual(to_dropdb_args('postgres', 'postgres://h/postgres'), [
			'--if-exists',
			'--no-password',
			'--maintenance-db=postgres://h/template1',
			'--',
			'postgres'
		]);
	});
});
