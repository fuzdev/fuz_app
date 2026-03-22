/**
 * Tests for database initialization and driver adapters.
 *
 * Uses real PGlite for adapter tests (transaction commit/rollback behavior).
 * URL routing tests verify `create_db` selects the correct driver.
 *
 * @module
 */

import {describe, assert, test, beforeAll, afterAll} from 'vitest';

import type {Db} from '$lib/db/db.js';
import {create_pglite_db} from '$lib/db/db_pglite.js';
import {create_db} from '$lib/db/create_db.js';

describe('create_pglite_db', () => {
	let db: Db;
	let close_db: () => Promise<void>;

	beforeAll(async () => {
		const {PGlite} = await import('@electric-sql/pglite');
		const pglite = new PGlite();
		const result = create_pglite_db(pglite);
		db = result.db;
		close_db = result.close;

		await db.query('CREATE TABLE test_items (id serial PRIMARY KEY, name text NOT NULL)');
	});

	afterAll(async () => {
		await close_db();
	});

	test('query returns rows', async () => {
		await db.query('INSERT INTO test_items (name) VALUES ($1)', ['alpha']);
		const rows = await db.query<{id: number; name: string}>(
			'SELECT name FROM test_items WHERE name = $1',
			['alpha'],
		);

		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.name, 'alpha');
	});

	test('query_one returns first row', async () => {
		const row = await db.query_one<{name: string}>('SELECT name FROM test_items WHERE name = $1', [
			'alpha',
		]);

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

		const rows = await db.query<{name: string}>('SELECT name FROM test_items WHERE name = $1', [
			'committed',
		]);
		assert.strictEqual(rows.length, 1);
	});

	test('transaction rolls back on error', async () => {
		try {
			await db.transaction(async (tx) => {
				await tx.query('INSERT INTO test_items (name) VALUES ($1)', ['rolled_back']);
				throw new Error('abort');
			});
			assert.fail('should have thrown');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes('abort'));
		}

		const rows = await db.query<{name: string}>('SELECT name FROM test_items WHERE name = $1', [
			'rolled_back',
		]);
		assert.strictEqual(rows.length, 0);
	});

	test('transaction returns callback value', async () => {
		const result = await db.transaction(async (tx) => {
			const rows = await tx.query<{id: number}>(
				'INSERT INTO test_items (name) VALUES ($1) RETURNING id',
				['return_val'],
			);
			return rows[0]!.id;
		});

		assert.ok(typeof result === 'number');
	});

	test('transaction-scoped Db rejects nested transactions', async () => {
		try {
			await db.transaction(async (tx) => {
				await tx.transaction(async () => {});
			});
			assert.fail('should have thrown');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes('Nested transactions are not supported'));
		}
	});
});

describe('create_db', () => {
	// Shared instance for query and transaction tests — avoids redundant WASM cold starts.
	let shared_result: Awaited<ReturnType<typeof create_db>>;

	beforeAll(async () => {
		shared_result = await create_db('memory://');
	});

	afterAll(async () => {
		await shared_result.close();
	});

	test('memory:// URL creates in-memory PGlite', () => {
		assert.strictEqual(shared_result.db_type, 'pglite-memory');
		assert.strictEqual(shared_result.db_name, '(memory)');
	});

	test('in-memory PGlite can execute queries', async () => {
		await shared_result.db.query('CREATE TABLE init_test (id serial PRIMARY KEY)');
		await shared_result.db.query('INSERT INTO init_test DEFAULT VALUES');
		const rows = await shared_result.db.query<{id: number}>('SELECT id FROM init_test');

		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.id, 1);

		await shared_result.db.query('DROP TABLE init_test');
	});

	test('in-memory PGlite supports transactions', async () => {
		await shared_result.db.query('CREATE TABLE tx_test (val text)');

		await shared_result.db.transaction(async (tx) => {
			await tx.query("INSERT INTO tx_test (val) VALUES ('inside_tx')");
		});

		const rows = await shared_result.db.query<{val: string}>('SELECT val FROM tx_test');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.val, 'inside_tx');

		await shared_result.db.query('DROP TABLE tx_test');
	});

	test('file:// URL creates file-based PGlite', async () => {
		const {mkdtemp} = await import('node:fs/promises');
		const {tmpdir} = await import('node:os');
		const {join} = await import('node:path');
		const temp_dir = await mkdtemp(join(tmpdir(), 'fuz-test-'));

		const result = await create_db(`file://${temp_dir}`);

		assert.strictEqual(result.db_type, 'pglite-file');
		assert.strictEqual(result.db_name, temp_dir);

		await result.close();

		// Clean up
		const {rm} = await import('node:fs/promises');
		await rm(temp_dir, {recursive: true, force: true});
	});

	test('unsupported URL scheme throws', async () => {
		try {
			await create_db('ftp://localhost/db');
			assert.fail('should have thrown');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes('Unsupported database URL scheme'));
		}
	});
});
