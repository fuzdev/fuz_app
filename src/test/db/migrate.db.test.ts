/**
 * Tests for the migration runner in isolation.
 *
 * Uses `create_pglite_factory` (not `describe_db`) to test runner behavior directly.
 *
 * @module
 */

import {describe, assert, test, beforeAll, beforeEach} from 'vitest';

import type {Db} from '$lib/db/db.js';
import {
	run_migrations,
	type Migration,
	type MigrationFn,
	type MigrationNamespace,
} from '$lib/db/migrate.js';
import {create_pglite_factory, reset_pglite} from '$lib/testing/db.js';

const noop_init = async (_db: Db): Promise<void> => {};
const factory = create_pglite_factory(noop_init);
let db: Db;

beforeAll(async () => {
	db = await factory.create();
});

beforeEach(async () => {
	await reset_pglite(db);
});

describe('run_migrations', () => {
	test('fresh DB runs all migrations', async () => {
		const calls: Array<number> = [];
		const migrations: Array<Migration> = [
			async () => {
				calls.push(0);
			},
			async () => {
				calls.push(1);
			},
		];
		const ns: MigrationNamespace = {namespace: 'test_ns', migrations};

		const results = await run_migrations(db, [ns]);

		assert.deepStrictEqual(calls, [0, 1]);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]!.namespace, 'test_ns');
		assert.strictEqual(results[0]!.from_version, 0);
		assert.strictEqual(results[0]!.to_version, 2);
		assert.strictEqual(results[0]!.migrations_applied, 2);
	});

	test('pre-existing schema skips completed migrations', async () => {
		const migrations: Array<Migration> = [
			async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS migrate_test_a (id INT)');
			},
			async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS migrate_test_b (id INT)');
			},
		];
		const ns: MigrationNamespace = {namespace: 'skip_ns', migrations};

		const first = await run_migrations(db, [ns]);
		assert.strictEqual(first.length, 1);
		assert.strictEqual(first[0]!.migrations_applied, 2);

		const second = await run_migrations(db, [ns]);
		assert.strictEqual(second.length, 0); // nothing to do
	});

	test('version-ahead throws with descriptive message', async () => {
		const migrations: Array<Migration> = [async () => {}, async () => {}];
		const ns: MigrationNamespace = {namespace: 'ahead_ns', migrations};

		// run both migrations
		await run_migrations(db, [ns]);

		// manually set version ahead
		await db.query('UPDATE schema_version SET version = 5 WHERE namespace = $1', ['ahead_ns']);

		// now run with only 2 migrations — should throw
		try {
			await run_migrations(db, [ns]);
			assert.fail('expected an error');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.startsWith('schema_version for "ahead_ns" is 5 but only 2'));
		}
	});

	test('rollback on failure preserves version at last successful migration', async () => {
		const migrations: Array<Migration> = [
			async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS rollback_test (id INT)');
			},
			async () => {
				throw new Error('intentional failure');
			},
		];
		const ns: MigrationNamespace = {namespace: 'rollback_ns', migrations};

		try {
			await run_migrations(db, [ns]);
			assert.fail('expected an error');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.startsWith('Migration rollback_ns[1] failed:'));
		}

		// version should be 1 (migration 0 committed successfully)
		const row = await db.query_one<{version: number}>(
			'SELECT version FROM schema_version WHERE namespace = $1',
			['rollback_ns'],
		);
		assert.strictEqual(row?.version, 1);

		// migration 0's DDL should have persisted
		const tables = await db.query<{tablename: string}>(
			"SELECT tablename FROM pg_tables WHERE tablename = 'rollback_test'",
		);
		assert.strictEqual(tables.length, 1);
	});

	test('first migration failure leaves no version row', async () => {
		const migrations: Array<Migration> = [
			async () => {
				throw new Error('boom');
			},
		];
		const ns: MigrationNamespace = {namespace: 'first_fail_ns', migrations};

		try {
			await run_migrations(db, [ns]);
			assert.fail('expected an error');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.startsWith('Migration first_fail_ns[0] failed:'));
		}

		// no row should exist — the INSERT was rolled back
		const row = await db.query_one<{version: number}>(
			'SELECT version FROM schema_version WHERE namespace = $1',
			['first_fail_ns'],
		);
		assert.strictEqual(row, undefined);
	});

	test('multiple namespaces tracked independently', async () => {
		const ns_a: MigrationNamespace = {
			namespace: 'ns_a',
			migrations: [async () => {}, async () => {}],
		};
		const ns_b: MigrationNamespace = {
			namespace: 'ns_b',
			migrations: [async () => {}],
		};

		const results = await run_migrations(db, [ns_a, ns_b]);

		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0]!.namespace, 'ns_a');
		assert.strictEqual(results[0]!.to_version, 2);
		assert.strictEqual(results[1]!.namespace, 'ns_b');
		assert.strictEqual(results[1]!.to_version, 1);

		// verify stored versions
		const row_a = await db.query_one<{version: number}>(
			'SELECT version FROM schema_version WHERE namespace = $1',
			['ns_a'],
		);
		const row_b = await db.query_one<{version: number}>(
			'SELECT version FROM schema_version WHERE namespace = $1',
			['ns_b'],
		);
		assert.strictEqual(row_a?.version, 2);
		assert.strictEqual(row_b?.version, 1);
	});

	test('resume after partial failure skips completed migrations', async () => {
		let migration_0_runs = 0;
		const failing_migrations: Array<Migration> = [
			async (d) => {
				migration_0_runs++;
				await d.query('CREATE TABLE IF NOT EXISTS resume_test (id INT)');
			},
			async () => {
				throw new Error('intentional failure');
			},
		];
		const ns: MigrationNamespace = {namespace: 'resume_ns', migrations: failing_migrations};

		// first run: migration 0 succeeds, migration 1 fails
		try {
			await run_migrations(db, [ns]);
			assert.fail('expected an error');
		} catch {
			// expected
		}
		assert.strictEqual(migration_0_runs, 1);

		// "fix" migration 1 and re-run — migration 0 should NOT re-run
		let migration_1_ran = false;
		const fixed_migrations: Array<Migration> = [
			failing_migrations[0]!,
			async () => {
				migration_1_ran = true;
			},
		];
		const fixed_ns: MigrationNamespace = {namespace: 'resume_ns', migrations: fixed_migrations};

		const results = await run_migrations(db, [fixed_ns]);

		assert.strictEqual(migration_0_runs, 1); // did not re-run
		assert.ok(migration_1_ran);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]!.from_version, 1);
		assert.strictEqual(results[0]!.to_version, 2);
		assert.strictEqual(results[0]!.migrations_applied, 1);
	});

	test('error wraps with cause for debuggability', async () => {
		const original = new Error('root cause');
		const migrations: Array<Migration> = [
			async () => {
				throw original;
			},
		];
		const ns: MigrationNamespace = {namespace: 'cause_ns', migrations};

		try {
			await run_migrations(db, [ns]);
			assert.fail('expected an error');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, 'Migration cause_ns[0] failed: root cause');
			assert.strictEqual(err.cause, original);
		}
	});

	test('empty migrations array produces no result', async () => {
		const ns: MigrationNamespace = {namespace: 'empty_ns', migrations: []};

		const results = await run_migrations(db, [ns]);

		assert.strictEqual(results.length, 0);
	});

	test('named migration runs normally', async () => {
		let ran = false;
		const named: Migration = {
			name: 'create_things',
			up: async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS named_test (id INT)');
				ran = true;
			},
		};
		const ns: MigrationNamespace = {namespace: 'named_ns', migrations: [named]};

		const results = await run_migrations(db, [ns]);

		assert.ok(ran);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]!.to_version, 1);
	});

	test('named migration includes name in error message on failure', async () => {
		const named: Migration = {
			name: 'broken_migration',
			up: async () => {
				throw new Error('intentional');
			},
		};
		const ns: MigrationNamespace = {namespace: 'named_fail_ns', migrations: [named]};

		try {
			await run_migrations(db, [ns]);
			assert.fail('expected an error');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes('"broken_migration"'));
			assert.ok(err.message.startsWith('Migration named_fail_ns[0]'));
		}
	});

	test('bare function migration error message omits name', async () => {
		const bare: MigrationFn = async () => {
			throw new Error('bare fail');
		};
		const ns: MigrationNamespace = {namespace: 'bare_fail_ns', migrations: [bare]};

		try {
			await run_migrations(db, [ns]);
			assert.fail('expected an error');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, 'Migration bare_fail_ns[0] failed: bare fail');
			assert.ok(!err.message.includes('"'));
		}
	});

	test('concurrent run_migrations on same namespace both complete without errors', async () => {
		const migrations: Array<Migration> = [
			async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS concurrent_test (id INT)');
			},
		];
		const ns: MigrationNamespace = {namespace: 'concurrent_ns', migrations};

		// Run two concurrent migration calls — both should complete without errors.
		// With advisory locks (real PG), one waits and finds version already applied.
		// Without advisory locks (PGlite), both may apply (IF NOT EXISTS is safe).
		const [result_a, result_b] = await Promise.all([
			run_migrations(db, [ns]),
			run_migrations(db, [ns]),
		]);

		// Final state should be correct: version 1, table exists
		const row = await db.query_one<{version: number}>(
			'SELECT version FROM schema_version WHERE namespace = $1',
			['concurrent_ns'],
		);
		assert.strictEqual(row?.version, 1);

		const tables = await db.query<{tablename: string}>(
			"SELECT tablename FROM pg_tables WHERE tablename = 'concurrent_test'",
		);
		assert.strictEqual(tables.length, 1);

		// At least one caller should report having applied the migration
		const total_applied =
			(result_a[0]?.migrations_applied ?? 0) + (result_b[0]?.migrations_applied ?? 0);
		assert.ok(total_applied >= 1);
	});
});
