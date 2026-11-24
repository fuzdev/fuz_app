/**
 * Tests for backend_test_db - test database factory builders.
 *
 * @module
 */

import { threadId } from 'node:worker_threads';
import { describe, assert, test, beforeAll, afterAll, vi } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	create_default_db_factory,
	create_pglet_wasm_factory,
	create_pglite_factory,
	create_pg_factory,
	FUZ_TEST_POSTGRES_URL_ENV,
	log_db_factory_status,
	set_default_db_factory,
	TEST_DATABASE_PREFIX,
	type DbFactory,
	type DbFactoryBuilder
} from '#lib/testing/db.ts';
import { create_db } from '#lib/db/create_db.ts';
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

const postgres_url = process.env[FUZ_TEST_POSTGRES_URL_ENV];

/** The databases named `prefix…` on the server, through the admin connection. */
const list_databases = async (prefix: string): Promise<Array<string>> => {
	const { db, close } = await create_db(postgres_url!);
	try {
		const rows = await db.query<{ datname: string }>(
			'SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname',
			[prefix]
		);
		return rows.map((row) => row.datname);
	} finally {
		await close();
	}
};

describe('create_pg_factory', () => {
	test('skips when no postgres_url is provided', () => {
		const factory = create_pg_factory(noop_init, undefined, { suite: 'pg_factory' });
		assert.strictEqual(factory.name, 'pg');
		assert.strictEqual(factory.skip, true);
		assert.strictEqual(factory.skip_reason, 'FUZ_TEST_POSTGRES_URL not set');
	});

	test('throws when create is called without postgres_url', async () => {
		const factory = create_pg_factory(noop_init, undefined, { suite: 'pg_factory' });
		await assert_rejects(() => factory.create(), /FUZ_TEST_POSTGRES_URL required/);
	});

	test('refuses a suite name PostgreSQL would not keep as written', () => {
		for (const suite of ['', 'Upper', '1st', 'has-dash', 'a'.repeat(25)]) {
			assert.throws(
				() => create_pg_factory(noop_init, undefined, { suite }),
				/test suite name .* must be lowercase ASCII/,
				JSON.stringify(suite)
			);
		}
		create_pg_factory(noop_init, undefined, { suite: 'a'.repeat(24) });
	});

	describe.skipIf(!postgres_url)('against a live server', () => {
		// the thread id beside the pid, so worker threads sharing a pid never collide
		const prefix = `${TEST_DATABASE_PREFIX}pg_factory_${process.pid}_${threadId}_`;

		test('each create() is a database of its own, dropped on close()', async () => {
			const factory = create_pg_factory(noop_init, postgres_url, { suite: 'pg_factory' });
			const first = await factory.create();
			const second = await factory.create();
			try {
				await first.query('CREATE TABLE pg_factory_own (id INT)');
				const rows = await second.query(
					`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pg_factory_own'`
				);
				assert.strictEqual(rows.length, 0, "the second database doesn't see the first's table");
				assert.lengthOf(await list_databases(prefix), 2);
			} finally {
				await factory.close(first);
				await factory.close(second);
			}
			assert.deepEqual(await list_databases(prefix), []);
		});

		test('a failed init_schema drops its database and passes the error through', async () => {
			const factory = create_pg_factory(
				async (db) => {
					await db.query('SELECT * FROM pg_factory_missing_relation');
				},
				postgres_url,
				{ suite: 'pg_factory' }
			);
			const error = await assert_rejects(() => factory.create());
			assert.include(error.message, 'pg_factory_missing_relation');
			assert.deepEqual(await list_databases(prefix), []);
		});

		test('an unreachable server is named by its variable', async () => {
			const url = new URL(postgres_url!);
			url.pathname = '/fuz_testing_no_such_admin_database';
			const factory = create_pg_factory(noop_init, url.href, { suite: 'pg_factory' });
			await assert_rejects(() => factory.create(), /connect through FUZ_TEST_POSTGRES_URL/);
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
