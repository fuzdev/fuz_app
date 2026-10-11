/**
 * Tests for backend_test_db - test database factory builders.
 *
 * @module
 */

import { describe, assert, test, beforeAll, afterAll, vi } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	create_default_db_factory,
	create_pglet_wasm_factory,
	create_pglite_factory,
	create_pg_factory,
	log_db_factory_status,
	set_default_db_factory,
	type DbFactory,
	type DbFactoryBuilder
} from '#lib/testing/db.ts';
import { Db, no_nested_transaction } from '#lib/db/db.ts';

const noop_init = async (_db: Db): Promise<void> => {};

// The two in-memory builders share one shape: a module-level instance per driver,
// reset and re-initialized on every `create()`.
const IN_MEMORY_BUILDERS: Array<{ name: string; build: DbFactoryBuilder }> = [
	{ name: 'pglite', build: create_pglite_factory },
	{ name: 'pglet-wasm', build: create_pglet_wasm_factory }
];

// Warm up both WASM instances before tests so the cold-start cost is outside individual test timers.
beforeAll(async () => {
	for (const { build } of IN_MEMORY_BUILDERS) await build(noop_init).create();
});

for (const { name, build } of IN_MEMORY_BUILDERS) {
	describe(`the ${name} factory`, () => {
		test('creates a factory that is never skipped', () => {
			const factory = build(noop_init);
			assert.strictEqual(factory.name, name);
			assert.strictEqual(factory.skip, false);
		});

		test('creates a working in-memory database', async () => {
			const init_called: Array<Db> = [];
			const factory = build((db) => {
				init_called.push(db);
				return Promise.resolve();
			});

			const db = await factory.create();
			assert.ok(db instanceof Db);
			assert.strictEqual(init_called.length, 1);
			assert.strictEqual(init_called[0], db);

			// verify db is functional
			const rows = await db.query<{ result: number }>('SELECT 1 as result');
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.result, 1);

			await factory.close(db);
		});

		test('runs schema init on the created database', async () => {
			const factory = build(async (db) => {
				await db.query('CREATE TABLE test_items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
			});

			const db = await factory.create();
			await db.query("INSERT INTO test_items (name) VALUES ('hello')");
			const rows = await db.query<{ name: string }>('SELECT name FROM test_items');
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.name, 'hello');

			await factory.close(db);
		});

		test("a second factory's first create resets the shared instance", async () => {
			const first = build(async (db) => {
				await db.query('CREATE TABLE only_in_first (id INT)');
			});
			const db = await first.create();
			const second = build(noop_init);
			assert.strictEqual(await second.create(), db, 'the factories share one instance');
			const rows = await db.query<{ table_name: string }>(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
			);
			assert.deepEqual(rows, []);
		});

		test('reads int8 as a number', async () => {
			const db = await build(noop_init).create();
			const rows = await db.query<{ big: unknown }>('SELECT 9007199254740991::int8 AS big');
			assert.strictEqual(rows[0]!.big, 9007199254740991);
		});
	});
}

describe('set_default_db_factory', () => {
	// The only automated check on the default-driver seam. A run that installs no
	// override never takes the installed branch, so without this a regression in
	// either direction — the override stops applying, or the explicit builders stop
	// pinning their driver — passes every suite in the repo.
	test('applies at a default call site and never at an explicit one', () => {
		const sentinel: DbFactory = {
			name: 'sentinel',
			skip: false,
			create: () => Promise.reject(new Error('the sentinel factory is never created')),
			close: () => Promise.resolve()
		};
		const received: Array<(db: Db) => Promise<void>> = [];
		const build_sentinel: DbFactoryBuilder = (init_schema) => {
			received.push(init_schema);
			return sentinel;
		};
		const previous = set_default_db_factory(build_sentinel);
		try {
			// default: the builder is called with this call site's `init_schema`
			assert.strictEqual(create_default_db_factory(noop_init), sentinel);
			assert.deepEqual(received, [noop_init]);
			// explicit: their own driver, and the builder is not called again
			assert.strictEqual(create_pglite_factory(noop_init).name, 'pglite');
			assert.strictEqual(create_pglet_wasm_factory(noop_init).name, 'pglet-wasm');
			assert.strictEqual(received.length, 1);
		} finally {
			// put back the run's selected driver (`db_default.ts`) for the rest of the file
			assert.strictEqual(set_default_db_factory(previous), build_sentinel);
		}
	});

	test('`null` restores pglet-wasm', () => {
		const previous = set_default_db_factory(null);
		try {
			assert.strictEqual(create_default_db_factory(noop_init).name, 'pglet-wasm');
		} finally {
			set_default_db_factory(previous);
		}
	});
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe('create_pg_factory', () => {
	test('skips when no test_url is provided', () => {
		const factory = create_pg_factory(noop_init);
		assert.strictEqual(factory.name, 'pg');
		assert.strictEqual(factory.skip, true);
		assert.strictEqual(factory.skip_reason, 'TEST_DATABASE_URL not set');
	});

	test('throws when create is called without test_url', async () => {
		const factory = create_pg_factory(noop_init);
		await assert_rejects(() => factory.create(), /TEST_DATABASE_URL required/);
	});

	describe.skipIf(!TEST_DATABASE_URL)('against a live server', () => {
		test('resets the public schema on every create()', async () => {
			const factory = create_pg_factory(noop_init, TEST_DATABASE_URL);
			const first = await factory.create();
			await first.query('CREATE TABLE pg_factory_stale (id INT)');
			await factory.close(first);
			const db = await factory.create();
			try {
				const rows = await db.query(
					`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pg_factory_stale'`
				);
				assert.strictEqual(rows.length, 0);
			} finally {
				await factory.close(db);
			}
		});

		test('a missing database gets the createdb hint', async () => {
			const url = new URL(TEST_DATABASE_URL!);
			url.pathname = '/fuz_app_test_db_that_does_not_exist';
			const factory = create_pg_factory(noop_init, url.href);
			await assert_rejects(() => factory.create(), /does not exist\. Create it with: createdb/);
		});

		test('an init_schema "does not exist" error passes through unchanged', async () => {
			const factory = create_pg_factory(async (db) => {
				await db.query('SELECT * FROM pg_factory_missing_relation');
			}, TEST_DATABASE_URL);
			const error = await assert_rejects(() => factory.create());
			assert.include(error.message, 'pg_factory_missing_relation');
			assert.notInclude(error.message, 'createdb');
		});
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
				client: { query: () => Promise.resolve({ rows: [] }) },
				transaction: no_nested_transaction
			});
		const factories: Array<DbFactory> = [
			{
				name: 'pglite',
				skip: false,
				create: () => Promise.resolve(mock_db()),
				close: () => Promise.resolve()
			},
			{
				name: 'pg',
				skip: true,
				skip_reason: 'Skipped in CI (no postgres)',
				create: () => Promise.resolve(mock_db()),
				close: () => Promise.resolve()
			}
		];

		log_db_factory_status(factories);

		assert.strictEqual(logs.length, 1);
		assert.ok(logs[0]!.includes('pglite'));
		assert.ok(logs[0]!.includes('pg (Skipped in CI (no postgres))'));
	});
});
