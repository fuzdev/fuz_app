/**
 * Tests for backend_test_db - test database factory builders.
 *
 * @module
 */

import {describe, assert, test, beforeAll, afterAll, vi} from 'vitest';

import {
	create_pglite_factory,
	create_pg_factory,
	log_db_factory_status,
	type DbFactory,
} from '$lib/testing/db.js';
import {Db, no_nested_transaction} from '$lib/db/db.js';

const noop_init = async (_db: Db): Promise<void> => {};

// Warm up PGlite WASM before tests so the cold-start cost is outside individual test timers.
beforeAll(async () => {
	const warmup = create_pglite_factory(noop_init);
	await warmup.create();
});

describe('create_pglite_factory', () => {
	test('creates a factory that is never skipped', () => {
		const factory = create_pglite_factory(noop_init);
		assert.strictEqual(factory.name, 'pglite');
		assert.strictEqual(factory.skip, false);
	});

	test('creates a working in-memory database', async () => {
		const init_called: Array<Db> = [];
		const factory = create_pglite_factory((db) => {
			init_called.push(db);
			return Promise.resolve();
		});

		const db = await factory.create();
		assert.ok(db instanceof Db);
		assert.strictEqual(init_called.length, 1);
		assert.strictEqual(init_called[0], db);

		// verify db is functional
		const rows = await db.query<{result: number}>('SELECT 1 as result');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.result, 1);

		await factory.close(db);
	});

	test('runs schema init on the created database', async () => {
		const factory = create_pglite_factory(async (db) => {
			await db.query('CREATE TABLE test_items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
		});

		const db = await factory.create();
		await db.query("INSERT INTO test_items (name) VALUES ('hello')");
		const rows = await db.query<{name: string}>('SELECT name FROM test_items');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.name, 'hello');

		await factory.close(db);
	});
});

describe('create_pg_factory', () => {
	test('skips when no test_url is provided', () => {
		const factory = create_pg_factory(noop_init);
		assert.strictEqual(factory.name, 'pg');
		assert.strictEqual(factory.skip, true);
		assert.strictEqual(factory.skip_reason, 'TEST_DATABASE_URL not set');
	});

	test('throws when create is called without test_url', async () => {
		const factory = create_pg_factory(noop_init);
		try {
			await factory.create();
			assert.fail('expected error');
		} catch (error) {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes('TEST_DATABASE_URL required'));
		}
	});
});

describe('log_db_factory_status', () => {
	let logs: Array<string>;

	beforeAll(() => {
		logs = [];
		vi.spyOn(console, 'log').mockImplementation((...args: Array<unknown>) => {
			logs.push(args.join(' '));
		});
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	test('logs enabled and skipped drivers', () => {
		const mock_db = (): Db =>
			new Db({
				client: {query: () => Promise.resolve({rows: []})},
				transaction: no_nested_transaction,
			});
		const factories: Array<DbFactory> = [
			{
				name: 'pglite',
				skip: false,
				create: () => Promise.resolve(mock_db()),
				close: () => Promise.resolve(),
			},
			{
				name: 'pg',
				skip: true,
				skip_reason: 'Skipped in CI (no postgres)',
				create: () => Promise.resolve(mock_db()),
				close: () => Promise.resolve(),
			},
		];

		log_db_factory_status(factories);

		assert.strictEqual(logs.length, 1);
		assert.ok(logs[0]!.includes('pglite'));
		assert.ok(logs[0]!.includes('pg (Skipped in CI (no postgres))'));
	});
});
