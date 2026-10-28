/**
 * Tests for `postgres_database.ts` — the URL checks, the database swap, the
 * redaction a setup prints a URL through, and the owned-database wipe's name
 * guard.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	empty_owned_database,
	ensure_database,
	ensure_database_for_url,
	is_createdb_already_exists,
	is_postgres_url,
	redact_database_url,
	to_maintenance_database_url,
	with_database_name
} from '#lib/testing/cross_backend/postgres_database.ts';

describe('is_postgres_url', () => {
	test('admits postgres:// and postgresql:// URLs', () => {
		assert.ok(is_postgres_url('postgres://localhost/db'));
		assert.ok(is_postgres_url('postgresql://user:pw@db.example:5433/db?sslmode=require'));
	});

	test('refuses scheme-less, other-scheme and non-URL values', () => {
		for (const value of ['localhost:5432/db', 'memory://', 'file:///tmp/db', 'db', 'http://x/db']) {
			assert.ok(!is_postgres_url(value), value);
		}
	});
});

describe('with_database_name', () => {
	test('replaces the database and keeps the server, role and query', () => {
		assert.strictEqual(
			with_database_name('postgres://user:pw@db.local:5433/first?sslmode=disable', 'second'),
			'postgres://user:pw@db.local:5433/second?sslmode=disable'
		);
	});

	test('adds a database to a URL naming none', () => {
		assert.strictEqual(
			with_database_name('postgres://localhost', 'fuz_app_test_x'),
			'postgres://localhost/fuz_app_test_x'
		);
	});

	test('to_maintenance_database_url names the postgres database', () => {
		assert.strictEqual(
			to_maintenance_database_url('postgresql://localhost/fuz_app_test_rust_spine_stub'),
			'postgresql://localhost/postgres'
		);
	});
});

describe('redact_database_url', () => {
	test('replaces a userinfo password and a password parameter', () => {
		const redacted = redact_database_url(
			'postgres://user:hunter2@db.local/app?password=hunter3&sslmode=require'
		);
		assert.notInclude(redacted, 'hunter2');
		assert.notInclude(redacted, 'hunter3');
		assert.include(redacted, 'user:REDACTED@db.local');
		assert.include(redacted, 'password=REDACTED');
		assert.include(redacted, 'sslmode=require');
	});

	test('leaves a URL with no password as it was', () => {
		assert.strictEqual(redact_database_url('postgres://localhost/app'), 'postgres://localhost/app');
	});
});

describe('ensure_database_for_url', () => {
	test('leaves a URL that names no Postgres database alone', () => {
		assert.ok(!ensure_database_for_url('memory://'));
		assert.ok(!ensure_database_for_url('file:///tmp/some.db'));
		assert.ok(!ensure_database_for_url('postgres://localhost'));
	});
});

describe('ensure_database', () => {
	test("reads createdb's already-exists refusal as success", () => {
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

	test("reports a failure with createdb's stderr instead of swallowing it", () => {
		const warnings: Array<string> = [];
		// a port nothing listens on: the connection fails, so createdb (or its absence) reports
		const ok = ensure_database('fuz_app_ensure_database_probe', 'postgres://127.0.0.1:1/x', {
			warn: (message) => warnings.push(message)
		});
		assert.ok(!ok);
		assert.strictEqual(warnings.length, 1);
		assert.include(warnings[0], 'createdb fuz_app_ensure_database_probe failed');
	});
});

describe('empty_owned_database', () => {
	test('refuses a URL naming any database but the owned one, before connecting', async () => {
		// port 1 — a connect attempt would fail with a connect error, not the guard's
		for (const url of [
			'postgres://127.0.0.1:1/other_db',
			'postgres://127.0.0.1:1/owned_db_suffix',
			'postgres://127.0.0.1:1/'
		]) {
			await assert_rejects(
				() => empty_owned_database(url, { owned_name: 'owned_db', label: 'test setup' }),
				/^test setup: refusing to empty database ".*" — only "owned_db" is wiped$/
			);
		}
	});

	test('reports a server it cannot reach with the fix and the hint', async () => {
		const error = await assert_rejects(
			() =>
				empty_owned_database('postgres://user:secret@127.0.0.1:1/owned_db', {
					owned_name: 'owned_db',
					label: 'test setup',
					hint: 'or set SOME_ENV'
				}),
			/^test setup: the Postgres database postgres:\/\/user:REDACTED@127\.0\.0\.1:1\/owned_db could not be emptied: .*To fix: check that Postgres is running there.*, or set SOME_ENV\.$/s
		);
		assert.ok(error.cause, 'the connect error is kept as the cause');
	});
});
