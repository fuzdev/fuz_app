/**
 * Tests for `testing/cross_backend/test_database.ts` — the PostgreSQL name a
 * test database gets, the PostgreSQL-only refusal, and, when their servers are
 * at hand, a database on each engine: opened empty, emptied, and gone after
 * `close()`. The pglet half runs with `PGLET_SERVER_BIN`, the PostgreSQL half
 * with `FUZ_TEST_POSTGRES_URL`.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_db } from '#lib/db/create_db.ts';
import {
	open_test_database,
	PGLET_SERVER_BIN_ENV,
	to_test_database_name,
	type TestDatabase
} from '#lib/testing/cross_backend/test_database.ts';
import { FUZ_TEST_POSTGRES_URL_ENV } from '#lib/testing/db.ts';

const pglet_server_bin = process.env[PGLET_SERVER_BIN_ENV];
const postgres_url = process.env[FUZ_TEST_POSTGRES_URL_ENV];

describe('to_test_database_name', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('is fuz_testing_<repo>_<name>, the repo made a name PostgreSQL keeps', () => {
		vi.spyOn(process, 'cwd').mockReturnValue('/home/u/dev/visionesdelcaribe.org');
		assert.strictEqual(to_test_database_name('rust'), 'fuz_testing_visionesdelcaribe_org_rust');
		vi.spyOn(process, 'cwd').mockReturnValue('/home/u/dev/Fuz-App');
		assert.strictEqual(to_test_database_name('rust'), 'fuz_testing_fuz_app_rust');
	});

	test('refuses a name PostgreSQL would not keep as written, or one too long', () => {
		vi.spyOn(process, 'cwd').mockReturnValue('/home/u/dev/fuz_app');
		for (const name of [
			'',
			'Rust',
			'1st',
			'has-dash',
			'a'.repeat(64 - 'fuz_testing_fuz_app_'.length)
		]) {
			assert.throws(
				() => to_test_database_name(name),
				/test database name .* must be lowercase ASCII/,
				JSON.stringify(name)
			);
		}
		to_test_database_name('a'.repeat(63 - 'fuz_testing_fuz_app_'.length));
	});
});

describe('open_test_database', () => {
	test('a PostgreSQL-only database without a server fails naming the variable', async () => {
		await assert_rejects(
			() => open_test_database({ name: 'parity', postgres_url: undefined, pglet_server_bin: null }),
			/runs only on PostgreSQL: set FUZ_TEST_POSTGRES_URL/
		);
	});

	/** The tables in the database's `public` schema. */
	const list_tables = async (url: string): Promise<Array<string>> => {
		const { db, close } = await create_db(url);
		try {
			const rows = await db.query<{ table_name: string }>(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
			);
			return rows.map((row) => row.table_name);
		} finally {
			await close();
		}
	};

	/** Open, write, empty, and close a database, asserting each step. */
	const exercise = async (database: TestDatabase): Promise<void> => {
		try {
			assert.deepEqual(await list_tables(database.url), [], 'opened empty');
			const { db, close } = await create_db(database.url);
			try {
				await db.query('CREATE TABLE test_database_probe (id INT)');
			} finally {
				await close();
			}
			assert.deepEqual(await list_tables(database.url), ['test_database_probe']);
			await database.empty();
			assert.deepEqual(await list_tables(database.url), [], 'emptied');
		} finally {
			await database.close();
		}
	};

	test.skipIf(!pglet_server_bin)('a pglet server of its own, stopped on close()', async () => {
		const database = await open_test_database({
			name: 'test_database_probe',
			postgres_url: undefined,
			pglet_server_bin: () => pglet_server_bin!
		});
		assert.strictEqual(database.engine, 'pglet');
		await exercise(database);
		await assert_rejects(() => list_tables(database.url));
	});

	test.skipIf(!postgres_url)('a PostgreSQL database of its own, dropped on close()', async () => {
		const name = `test_database_probe_${process.pid}`;
		const database = await open_test_database({
			name,
			postgres_url,
			pglet_server_bin: () => assert.fail('a PostgreSQL run builds no pglet server')
		});
		assert.strictEqual(database.engine, 'postgres');
		assert.strictEqual(new URL(database.url).pathname, `/${to_test_database_name(name)}`);
		await exercise(database);
		const { db, close } = await create_db(postgres_url!);
		try {
			const rows = await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [
				to_test_database_name(name)
			]);
			assert.strictEqual(rows.length, 0, 'dropped');
		} finally {
			await close();
		}
	});

	test.skipIf(!postgres_url)(
		'a second open of a name another run holds fails before touching its database',
		async () => {
			const name = `test_database_lock_${process.pid}`;
			const options = {
				name,
				postgres_url,
				pglet_server_bin: () => assert.fail('a PostgreSQL run builds no pglet server')
			};
			const first = await open_test_database(options);
			try {
				const { db, close } = await create_db(first.url);
				try {
					await db.query('CREATE TABLE test_database_lock_probe (id INT)');
				} finally {
					await close();
				}
				await assert_rejects(
					() => open_test_database(options),
					new RegExp(`another run holds ${to_test_database_name(name)}`)
				);
				// the first run's database survived the attempt
				assert.deepEqual(await list_tables(first.url), ['test_database_lock_probe']);
			} finally {
				await first.close();
			}
			// closing released the lock: the name opens again
			const again = await open_test_database(options);
			await again.close();
		}
	);
});
