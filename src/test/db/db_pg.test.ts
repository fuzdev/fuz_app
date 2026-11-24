/**
 * Unit tests for `create_pg_db`'s transaction over a stub pool — no real
 * database needed (`db_pg.db.test.ts` runs the same cases on Postgres).
 *
 * @module
 */

import { EventEmitter } from 'node:events';
import { describe, assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { create_pg_db, type DbCheckoutPool } from '#lib/db/db_pg.ts';

/** Options for `create_stub_pool`. */
interface StubPoolOptions {
	/** The command tag the client answers `COMMIT` with. */
	commit_command?: string;
	/** Statements the client rejects, each with its own error. */
	reject?: Partial<Record<string, Error>>;
}

/**
 * A pool whose one client answers `COMMIT` with `commit_command`, rejects each
 * statement in `reject`, and records every statement, its release argument,
 * and every warning on the pool's `connection_log`.
 */
const create_stub_pool = (
	options: StubPoolOptions = {}
): {
	pool: DbCheckoutPool;
	client: EventEmitter;
	statements: Array<string>;
	warnings: Array<string>;
} => {
	const { commit_command = 'COMMIT', reject = {} } = options;
	const statements: Array<string> = [];
	const client = Object.assign(new EventEmitter(), {
		query: async (text: string) => {
			statements.push(text);
			const err = reject[text];
			if (err) throw err;
			return { command: text === 'COMMIT' ? commit_command : text, rows: [] };
		},
		release: (broken?: boolean) => {
			statements.push(broken ? 'release broken' : 'release');
		}
	});
	const warnings: Array<string> = [];
	const connection_log = { warn: (...args: Array<unknown>) => warnings.push(args.join(' ')) };
	const pool = { connect: async () => client, connection_log } as unknown as DbCheckoutPool;
	return { pool, client, statements, warnings };
};

/** The error pg's client throws once its connection is gone. */
const create_connection_error = (): Error =>
	new Error('Client has encountered a connection error and is not queryable');

describe('create_pg_db transaction', () => {
	test('a COMMIT answered with COMMIT returns the result', async () => {
		const { pool, statements } = create_stub_pool();
		const { db } = create_pg_db(pool);
		assert.strictEqual(await db.transaction(async () => 'done'), 'done');
		assert.deepStrictEqual(statements, ['BEGIN', 'COMMIT', 'release']);
	});

	test('a COMMIT answered with ROLLBACK throws instead of reporting success', async () => {
		const { pool, statements } = create_stub_pool({ commit_command: 'ROLLBACK' });
		const { db } = create_pg_db(pool);
		const err = await assert_rejects(() => db.transaction(async () => 'done'));
		assert.include(err.message, 'transaction aborted before COMMIT');
		assert.strictEqual(statements.at(-1), 'release', 'the client went back to the pool');
	});

	test('a failed ROLLBACK keeps the original error, is warned, and releases the client as broken', async () => {
		const { pool, statements, warnings } = create_stub_pool({
			reject: { ROLLBACK: create_connection_error() }
		});
		const { db } = create_pg_db(pool);
		const original = new Error('the transaction body failed');
		const err = await assert_rejects(() =>
			db.transaction(async () => {
				throw original;
			})
		);
		assert.strictEqual(err, original);
		assert.deepStrictEqual(statements, ['BEGIN', 'ROLLBACK', 'release broken']);
		assert.deepStrictEqual(warnings, [
			'database transaction rollback failed: Client has encountered a connection error and is not queryable'
		]);
	});

	test('a COMMIT lost with the connection surfaces the COMMIT error, not the ROLLBACK one', async () => {
		const commit_error = create_connection_error();
		const { pool, statements } = create_stub_pool({
			reject: { COMMIT: commit_error, ROLLBACK: create_connection_error() }
		});
		const { db } = create_pg_db(pool);
		const err = await assert_rejects(() => db.transaction(async () => 'done'));
		assert.strictEqual(err, commit_error);
		assert.deepStrictEqual(statements, ['BEGIN', 'COMMIT', 'ROLLBACK', 'release broken']);
	});

	test('a ROLLBACK that succeeds releases the client for reuse', async () => {
		const { pool, statements, warnings } = create_stub_pool();
		const { db } = create_pg_db(pool);
		const original = new Error('the transaction body failed');
		const err = await assert_rejects(() =>
			db.transaction(async () => {
				throw original;
			})
		);
		assert.strictEqual(err, original);
		assert.deepStrictEqual(statements, ['BEGIN', 'ROLLBACK', 'release']);
		assert.deepStrictEqual(warnings, [], 'nothing to warn of');
	});

	test('an error event on the held client is heard, warned, and the client released broken', async () => {
		const { pool, client, statements, warnings } = create_stub_pool();
		const { db } = create_pg_db(pool);
		const result = await db.transaction(async () => {
			// unheard, `emit` would throw it here
			client.emit('error', create_connection_error());
			return 'done';
		});
		assert.strictEqual(result, 'done');
		assert.deepStrictEqual(statements, ['BEGIN', 'COMMIT', 'release broken']);
		assert.strictEqual(client.listenerCount('error'), 0, 'the listener left with the checkout');
		assert.deepStrictEqual(warnings, [
			'database connection error: Client has encountered a connection error and is not queryable'
		]);
	});

	test('the original error still rethrows when the client errors and the ROLLBACK fails', async () => {
		const { pool, client, statements, warnings } = create_stub_pool({
			reject: { ROLLBACK: create_connection_error() }
		});
		const { db } = create_pg_db(pool);
		const original = new Error('the transaction body failed');
		const err = await assert_rejects(() =>
			db.transaction(async () => {
				client.emit('error', create_connection_error());
				throw original;
			})
		);
		assert.strictEqual(err, original);
		assert.deepStrictEqual(statements, ['BEGIN', 'ROLLBACK', 'release broken']);
		assert.strictEqual(warnings.length, 2, 'the heard error and the failed rollback');
	});
});
