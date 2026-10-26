/**
 * Tests for `postgres_database.ts` — the URL checks, the database swap, and
 * the redaction a setup prints a URL through.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
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
