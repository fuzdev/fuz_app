/**
 * Unit tests for `create_pg_db`'s transaction over a stub pool — no real
 * database needed (`db_pg.db.test.ts` runs the same case on Postgres).
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { create_pg_db, type DbCheckoutPool } from '#lib/db/db_pg.ts';

/** A pool whose one client answers `COMMIT` with `commit_command` and records every statement. */
const create_stub_pool = (
	commit_command: string
): { pool: DbCheckoutPool; statements: Array<string> } => {
	const statements: Array<string> = [];
	const client = {
		query: async (text: string) => {
			statements.push(text);
			return { command: text === 'COMMIT' ? commit_command : text, rows: [] };
		},
		release: () => {
			statements.push('release');
		}
	};
	const pool = { connect: async () => client } as unknown as DbCheckoutPool;
	return { pool, statements };
};

describe('create_pg_db transaction', () => {
	test('a COMMIT answered with COMMIT returns the result', async () => {
		const { pool, statements } = create_stub_pool('COMMIT');
		const { db } = create_pg_db(pool);
		assert.strictEqual(await db.transaction(async () => 'done'), 'done');
		assert.deepStrictEqual(statements, ['BEGIN', 'COMMIT', 'release']);
	});

	test('a COMMIT answered with ROLLBACK throws instead of reporting success', async () => {
		const { pool, statements } = create_stub_pool('ROLLBACK');
		const { db } = create_pg_db(pool);
		const err = await assert_rejects(() => db.transaction(async () => 'done'));
		assert.include(err.message, 'transaction aborted before COMMIT');
		assert.strictEqual(statements.at(-1), 'release', 'the client went back to the pool');
	});
});
