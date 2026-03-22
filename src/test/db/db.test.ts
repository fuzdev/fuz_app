/**
 * Unit tests for the Db wrapper class.
 *
 * Tests query delegation, query_one semantics, and transaction wiring
 * using a mock client — no real database needed.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {Db, no_nested_transaction, type DbClient} from '$lib/db/db.js';

/** Create a mock DbClient that returns the given rows. */
const create_mock_client = (
	rows: Array<unknown> = [],
): DbClient & {calls: Array<{text: string; values?: Array<unknown>}>} => {
	const calls: Array<{text: string; values?: Array<unknown>}> = [];
	return {
		calls,
		query: async <T>(text: string, values?: Array<unknown>) => {
			calls.push({text, values});
			return {rows: rows as Array<T>};
		},
	};
};

describe('Db', () => {
	describe('query', () => {
		test('returns rows from client', async () => {
			const client = create_mock_client([{id: 1}, {id: 2}]);
			const db = new Db({client, transaction: no_nested_transaction});

			const result = await db.query('SELECT * FROM t');

			assert.deepStrictEqual(result, [{id: 1}, {id: 2}]);
		});

		test('returns empty array for no rows', async () => {
			const client = create_mock_client([]);
			const db = new Db({client, transaction: no_nested_transaction});

			const result = await db.query('SELECT * FROM t WHERE false');

			assert.deepStrictEqual(result, []);
		});

		test('passes text and values to client', async () => {
			const client = create_mock_client([]);
			const db = new Db({client, transaction: no_nested_transaction});

			await db.query('SELECT * FROM t WHERE id = $1 AND name = $2', [42, 'test']);

			assert.strictEqual(client.calls.length, 1);
			const call = client.calls[0]!;
			assert.strictEqual(call.text, 'SELECT * FROM t WHERE id = $1 AND name = $2');
			assert.deepStrictEqual(call.values, [42, 'test']);
		});

		test('passes undefined values when omitted', async () => {
			const client = create_mock_client([]);
			const db = new Db({client, transaction: no_nested_transaction});

			await db.query('SELECT 1');

			assert.strictEqual(client.calls[0]!.values, undefined);
		});

		test('propagates client errors', async () => {
			const client: DbClient = {
				query: async () => {
					throw new Error('connection lost');
				},
			};
			const db = new Db({client, transaction: no_nested_transaction});

			try {
				await db.query('SELECT 1');
				assert.fail('should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('connection lost'));
			}
		});
	});

	describe('query_one', () => {
		test('returns first row when rows exist', async () => {
			const client = create_mock_client([{id: 1}, {id: 2}]);
			const db = new Db({client, transaction: no_nested_transaction});

			const result = await db.query_one('SELECT * FROM t');

			assert.deepStrictEqual(result, {id: 1});
		});

		test('returns undefined for no rows', async () => {
			const client = create_mock_client([]);
			const db = new Db({client, transaction: no_nested_transaction});

			const result = await db.query_one('SELECT * FROM t WHERE false');

			assert.strictEqual(result, undefined);
		});

		test('passes values through', async () => {
			const client = create_mock_client([{id: 5}]);
			const db = new Db({client, transaction: no_nested_transaction});

			await db.query_one('SELECT * FROM t WHERE id = $1', [5]);

			assert.deepStrictEqual(client.calls[0]!.values, [5]);
		});
	});

	describe('transaction', () => {
		test('delegates to injected transaction function', async () => {
			const client = create_mock_client([]);
			let transaction_called = false;

			const db = new Db({
				client,
				transaction: async (fn) => {
					transaction_called = true;
					const tx_db = new Db({client, transaction: no_nested_transaction});
					return fn(tx_db);
				},
			});

			await db.transaction(async (tx) => {
				await tx.query('INSERT INTO t VALUES ($1)', [1]);
			});

			assert.ok(transaction_called);
		});

		test('returns value from callback', async () => {
			const client = create_mock_client([]);
			const db = new Db({
				client,
				transaction: async (fn) => {
					const tx_db = new Db({client, transaction: no_nested_transaction});
					return fn(tx_db);
				},
			});

			const result = await db.transaction(async () => 'hello');

			assert.strictEqual(result, 'hello');
		});

		test('propagates callback errors', async () => {
			const client = create_mock_client([]);
			const db = new Db({
				client,
				transaction: async (fn) => {
					const tx_db = new Db({client, transaction: no_nested_transaction});
					return fn(tx_db);
				},
			});

			try {
				await db.transaction(async () => {
					throw new Error('rollback me');
				});
				assert.fail('should have thrown');
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes('rollback me'));
			}
		});
	});
});

describe('no_nested_transaction', () => {
	test('throws immediately', () => {
		assert.throws(
			() => no_nested_transaction(async () => {}),
			/Nested transactions are not supported/,
		);
	});

	test('throws with any callback', () => {
		assert.throws(
			() =>
				no_nested_transaction(async () => {
					return 42;
				}),
			/Nested transactions are not supported/,
		);
	});
});
