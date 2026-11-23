/**
 * Tests for `testing/stubs.ts` — the stub `Db` the stub deps carry.
 *
 * `create_stub_app_deps().db` is `create_stub_db()`, so a handler run on stub
 * deps reaches its transaction callback and reads the pool-level `Db` as
 * outside a transaction, as production does.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	create_stub_app_backend,
	create_stub_app_deps,
	create_stub_db
} from '#lib/testing/stubs.ts';

describe('create_stub_db', () => {
	test('a transaction runs its callback on a transaction-scoped db', async () => {
		const db = create_stub_db();
		assert.strictEqual(db.in_transaction, false, 'the pool-level db is outside a transaction');
		const result = await db.transaction(async (tx) => {
			assert.strictEqual(tx.in_transaction, true, 'the callback gets a transaction db');
			assert.deepStrictEqual(await tx.query('SELECT 1'), []);
			await assert_rejects(() => tx.transaction(async () => {}));
			return 'ran';
		});
		assert.strictEqual(result, 'ran');
	});
});

describe('create_stub_app_deps', () => {
	test('its db is a stub db: transactions run their callbacks', async () => {
		const { db } = create_stub_app_deps();
		assert.strictEqual(db.in_transaction, false);
		let ran = false;
		await db.transaction(async (tx) => {
			ran = true;
			assert.strictEqual(tx.in_transaction, true);
		});
		assert.ok(ran, 'the transaction callback ran');
		assert.deepStrictEqual(await db.query('SELECT 1'), []);
		assert.strictEqual(await db.query_one('SELECT 1'), undefined);
	});

	test('each call has a db of its own', () => {
		assert.notStrictEqual(create_stub_app_deps().db, create_stub_app_deps().db);
		assert.notStrictEqual(create_stub_app_backend().deps.db, create_stub_app_backend().deps.db);
	});
});
