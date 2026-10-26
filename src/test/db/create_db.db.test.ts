/**
 * Tests for database initialization and driver adapters.
 *
 * Runs the adapter suite (queries, transaction commit/rollback, nested
 * refusal, int8 coercion) against real PGlite and pglet instances. URL routing
 * tests verify `create_db` selects the correct driver.
 *
 * @module
 */

import { describe, assert, test, beforeAll, afterAll } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import type { Db, DbDriverResult } from '#lib/db/db.ts';
import { create_pglite_db } from '#lib/db/db_pglite.ts';
import { create_pglet_db_driver, create_pglet_instance } from '#lib/db/db_pglet.ts';
import { create_db } from '#lib/db/create_db.ts';

const ADAPTERS: Array<{ name: string; create: () => Promise<DbDriverResult> }> = [
	{
		name: 'create_pglite_db',
		create: async () => {
			const { PGlite } = await import('@electric-sql/pglite');
			return create_pglite_db(new PGlite());
		}
	},
	{
		name: 'create_pglet_db_driver',
		create: async () => create_pglet_db_driver(await create_pglet_instance())
	}
];

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		let db: Db;
		let close_db: () => Promise<void>;

		beforeAll(async () => {
			const result = await adapter.create();
			db = result.db;
			close_db = result.close;

			await db.query('CREATE TABLE test_items (id serial PRIMARY KEY, name text NOT NULL)');
		});

		test('int8 reads as a JS number, as on every driver', async () => {
			const rows = await db.query<{ big: unknown; seq: unknown }>(
				'SELECT 9007199254740991::int8 AS big, count(*) AS seq FROM test_items'
			);
			assert.strictEqual(rows[0]!.big, Number.MAX_SAFE_INTEGER);
			assert.strictEqual(typeof rows[0]!.seq, 'number');
		});

		afterAll(async () => {
			await close_db();
		});

		test('query returns rows', async () => {
			await db.query('INSERT INTO test_items (name) VALUES ($1)', ['alpha']);
			const rows = await db.query<{ id: number; name: string }>(
				'SELECT name FROM test_items WHERE name = $1',
				['alpha']
			);

			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.name, 'alpha');
		});

		test('query_one returns first row', async () => {
			const row = await db.query_one<{ name: string }>(
				'SELECT name FROM test_items WHERE name = $1',
				['alpha']
			);

			assert.ok(row);
			assert.strictEqual(row.name, 'alpha');
		});

		test('query_one returns undefined for no match', async () => {
			const row = await db.query_one('SELECT * FROM test_items WHERE name = $1', ['nonexistent']);

			assert.strictEqual(row, undefined);
		});

		test('transaction commits on success', async () => {
			await db.transaction(async (tx) => {
				await tx.query('INSERT INTO test_items (name) VALUES ($1)', ['committed']);
			});

			const rows = await db.query<{ name: string }>('SELECT name FROM test_items WHERE name = $1', [
				'committed'
			]);
			assert.strictEqual(rows.length, 1);
		});

		test('transaction rolls back on error', async () => {
			await assert_rejects(
				() =>
					db.transaction(async (tx) => {
						await tx.query('INSERT INTO test_items (name) VALUES ($1)', ['rolled_back']);
						throw new Error('abort');
					}),
				/abort/
			);

			const rows = await db.query<{ name: string }>('SELECT name FROM test_items WHERE name = $1', [
				'rolled_back'
			]);
			assert.strictEqual(rows.length, 0);
		});

		test('transaction returns callback value', async () => {
			const result = await db.transaction(async (tx) => {
				const rows = await tx.query<{ id: number }>(
					'INSERT INTO test_items (name) VALUES ($1) RETURNING id',
					['return_val']
				);
				return rows[0]!.id;
			});

			assert.ok(typeof result === 'number');
		});

		test('transaction-scoped Db rejects nested transactions', async () => {
			await assert_rejects(
				() =>
					db.transaction(async (tx) => {
						await tx.transaction(async () => {});
					}),
				/Nested transactions are not supported/
			);
		});
	});
}

describe('create_db', () => {
	// Shared instance for query and transaction tests — avoids redundant WASM cold starts.
	let shared_result: Awaited<ReturnType<typeof create_db>>;

	beforeAll(async () => {
		shared_result = await create_db('memory://');
	});

	afterAll(async () => {
		await shared_result.close();
	});

	test('memory:// URL creates in-memory pglet', () => {
		assert.strictEqual(shared_result.db_type, 'pglet-memory');
		assert.strictEqual(shared_result.db_name, '(memory)');
	});

	test('in-memory pglet can execute queries', async () => {
		await shared_result.db.query('CREATE TABLE init_test (id serial PRIMARY KEY)');
		await shared_result.db.query('INSERT INTO init_test DEFAULT VALUES');
		const rows = await shared_result.db.query<{ id: number }>('SELECT id FROM init_test');

		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.id, 1);

		await shared_result.db.query('DROP TABLE init_test');
	});

	test('in-memory pglet supports transactions', async () => {
		await shared_result.db.query('CREATE TABLE tx_test (val text)');

		await shared_result.db.transaction(async (tx) => {
			await tx.query("INSERT INTO tx_test (val) VALUES ('inside_tx')");
		});

		const rows = await shared_result.db.query<{ val: string }>('SELECT val FROM tx_test');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.val, 'inside_tx');

		await shared_result.db.query('DROP TABLE tx_test');
	});

	test('file:// URL creates file-based PGlite', async () => {
		const { mkdtemp } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const { rm } = await import('node:fs/promises');
		const temp_dir = await mkdtemp(join(tmpdir(), 'fuz-test-'));
		try {
			const result = await create_db(`file://${temp_dir}`);
			try {
				assert.strictEqual(result.db_type, 'pglite-file');
				assert.strictEqual(result.db_name, temp_dir);
			} finally {
				await result.close();
			}
		} finally {
			await rm(temp_dir, { recursive: true, force: true });
		}
	});

	test('unsupported URL scheme throws', async () => {
		await assert_rejects(() => create_db('ftp://localhost/db'), /Unsupported database URL scheme/);
	});
});
