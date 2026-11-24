/**
 * Unit tests for `create_pglite_db`'s transaction over a stub PGlite whose
 * `transaction` runs the callback and, on a throw, issues its own `ROLLBACK`
 * before rethrowing — the shape of PGlite's native `transaction()`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import type { PGlite } from '@electric-sql/pglite';

import { create_pglite_db } from '#lib/db/db_pglite.ts';

/** A PGlite whose `ROLLBACK` throws `rollback_error` when given one, as a closed instance's does. */
const create_stub_pglite = (rollback_error?: Error): PGlite => {
	const tx = { query: async () => ({ rows: [] }) };
	return {
		transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
			try {
				return await callback(tx);
			} catch (err) {
				if (rollback_error) throw rollback_error;
				throw err;
			}
		}
	} as unknown as PGlite;
};

describe('create_pglite_db transaction', () => {
	test('a failed ROLLBACK keeps the error the transaction threw', async () => {
		const { db } = create_pglite_db(create_stub_pglite(new Error('PGlite is closed')));
		const original = new Error('the transaction body failed');
		const err = await assert_rejects(() =>
			db.transaction(async () => {
				throw original;
			})
		);
		assert.strictEqual(err, original);
	});

	test('a failure outside the callback is PGlite’s own error', async () => {
		const commit_error = new Error('COMMIT failed');
		const pglite = {
			transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
				await callback({ query: async () => ({ rows: [] }) });
				throw commit_error;
			}
		} as unknown as PGlite;
		const { db } = create_pglite_db(pglite);
		const err = await assert_rejects(() => db.transaction(async () => 'done'));
		assert.strictEqual(err, commit_error);
	});

	test('a successful transaction returns the callback’s result', async () => {
		const { db } = create_pglite_db(create_stub_pglite());
		assert.strictEqual(await db.transaction(async () => 'done'), 'done');
	});
});
