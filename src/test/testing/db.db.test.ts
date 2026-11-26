/**
 * Tests for `testing/db.ts` — the test database factory builders.
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

// The two in-memory builders: PGlite shares one module-level instance and resets it
// per `create()`, pglet-wasm migrates a base once per `init_schema` and forks it.
const IN_MEMORY_BUILDERS: Array<{ name: string; build: DbFactoryBuilder }> = [
	{ name: 'pglite', build: create_pglite_factory },
	{ name: 'pglet-wasm', build: create_pglet_wasm_factory }
];

// Warm up both WASM instances before tests so the cold-start cost is outside individual test timers.
beforeAll(async () => {
	for (const { build } of IN_MEMORY_BUILDERS) {
		const factory = build(noop_init);
		await factory.close(await factory.create());
	}
});

/** Whether `db` has a `public` table named `table`. */
const query_has_table = async (db: Db, table: string): Promise<boolean> => {
	const [row] = await db.query<{ found: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		) AS found`,
		[table]
	);
	return row!.found;
};

for (const { name, build } of IN_MEMORY_BUILDERS) {
	describe(`the ${name} factory`, () => {
		test('creates a factory that is never skipped', () => {
			const factory = build(noop_init);
			assert.strictEqual(factory.name, name);
			assert.strictEqual(factory.skip, false);
		});

		test('creates a working in-memory database', async () => {
			const init_called: Array<unknown> = [];
			const factory = build((init_db) => {
				init_called.push(init_db);
				return Promise.resolve();
			});

			const db = await factory.create();
			assert.ok(db instanceof Db);
			assert.strictEqual(init_called.length, 1);
			assert.ok(init_called[0] instanceof Db, 'init_schema receives a Db');

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

		test('reads int8 as a number', async () => {
			const factory = build(noop_init);
			const db = await factory.create();
			const rows = await db.query<{ big: unknown }>('SELECT 9007199254740991::int8 AS big');
			assert.strictEqual(rows[0]!.big, 9007199254740991);
			await factory.close(db);
		});
	});
}

describe('the pglite factory', () => {
	test("a second factory's first create resets the shared instance", async () => {
		const first = create_pglite_factory(async (db) => {
			await db.query('CREATE TABLE only_in_first (id INT)');
		});
		const db = await first.create();
		const second = create_pglite_factory(noop_init);
		assert.strictEqual(await second.create(), db, 'the factories share one instance');
		assert.ok(!(await query_has_table(db, 'only_in_first')), 'the reset dropped it');
		await second.close(db);
	});
});

describe('the pglet-wasm factory', () => {
	test('each create forks the migrated base: a fork sees its tables, and init runs once', async () => {
		let init_calls = 0;
		const factory = create_pglet_wasm_factory(async (db) => {
			init_calls++;
			await db.query('CREATE TABLE forked_items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
			await db.query("INSERT INTO forked_items (name) VALUES ('seeded')");
		});
		const first = await factory.create();
		const second = await factory.create();
		try {
			assert.strictEqual(init_calls, 1, 'the second create forked, not re-migrated');
			assert.notStrictEqual(first, second);
			for (const db of [first, second]) {
				const rows = await db.query<{ name: string }>('SELECT name FROM forked_items');
				assert.deepEqual(rows, [{ name: 'seeded' }]);
			}
		} finally {
			await factory.close(first);
			await factory.close(second);
		}
	});

	test('forks are isolated from each other and from the base', async () => {
		const init_schema = async (db: Db): Promise<void> => {
			await db.query('CREATE TABLE isolated_items (name TEXT NOT NULL)');
		};
		const factory = create_pglet_wasm_factory(init_schema);
		const first = await factory.create();
		const second = await factory.create();
		try {
			await first.query("INSERT INTO isolated_items (name) VALUES ('first')");
			await first.query('CREATE TABLE only_in_first (id INT)');
			await second.query('DROP TABLE isolated_items');

			const first_rows = await first.query<{ name: string }>('SELECT name FROM isolated_items');
			assert.deepEqual(first_rows, [{ name: 'first' }]);
			assert.ok(!(await query_has_table(second, 'isolated_items')));
			assert.ok(!(await query_has_table(second, 'only_in_first')));

			// a later fork is of the base, which neither fork's writes reached
			const third = await factory.create();
			try {
				assert.deepEqual(await third.query('SELECT name FROM isolated_items'), []);
				assert.ok(!(await query_has_table(third, 'only_in_first')));
			} finally {
				await factory.close(third);
			}
		} finally {
			await factory.close(first);
			await factory.close(second);
		}
	});

	test('factories built with one init_schema share its base; another init_schema gets its own', async () => {
		let init_calls = 0;
		const init_schema = async (db: Db): Promise<void> => {
			init_calls++;
			await db.query('CREATE TABLE shared_base_items (id INT)');
		};
		const a = create_pglet_wasm_factory(init_schema);
		const b = create_pglet_wasm_factory(init_schema);
		const other = create_pglet_wasm_factory(noop_init);
		const [db_a, db_b, db_other] = await Promise.all([a.create(), b.create(), other.create()]);
		try {
			assert.strictEqual(init_calls, 1, 'concurrent first creates migrated one base');
			assert.ok(await query_has_table(db_a, 'shared_base_items'));
			assert.ok(await query_has_table(db_b, 'shared_base_items'));
			assert.ok(!(await query_has_table(db_other, 'shared_base_items')));
		} finally {
			await a.close(db_a);
			await b.close(db_b);
			await other.close(db_other);
		}
	});

	test('close closes the fork and a second close is a no-op; the base keeps forking', async () => {
		const factory = create_pglet_wasm_factory(noop_init);
		const db = await factory.create();
		await factory.close(db);
		await assert_rejects(() => db.query('SELECT 1'), /closed/);
		await factory.close(db);
		const next = await factory.create();
		try {
			assert.deepEqual(await next.query<{ one: number }>('SELECT 1 AS one'), [{ one: 1 }]);
		} finally {
			await factory.close(next);
		}
	});

	test('close throws on a database the factory did not create', async () => {
		const factory = create_pglet_wasm_factory(noop_init);
		const other = create_pglet_wasm_factory(noop_init);
		const db = await other.create();
		try {
			await assert_rejects(() => factory.close(db), /did not create/);
		} finally {
			await other.close(db);
		}
	});

	test('a fork of a base whose init_schema left a block open is refused with 25001', async () => {
		const factory = create_pglet_wasm_factory(async (db) => {
			await db.query('BEGIN');
			await db.query('CREATE TABLE never_committed (id INT)');
		});
		const error = await assert_rejects(() => factory.create());
		assert.strictEqual((error as { code?: unknown }).code, '25001');
	});

	test('a failed init_schema is the error every create with it reports', async () => {
		let init_calls = 0;
		const factory = create_pglet_wasm_factory(async () => {
			init_calls++;
			throw new Error('init failed');
		});
		await assert_rejects(() => factory.create(), /init failed/);
		await assert_rejects(() => factory.create(), /init failed/);
		assert.strictEqual(init_calls, 1);
	});
});

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
