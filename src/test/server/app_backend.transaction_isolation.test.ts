/**
 * Tests for the READ COMMITTED boot guard's pure check —
 * `check_transaction_isolation` and `TransactionIsolationError`. The guard over
 * each driver and `create_app_backend`'s refusal before migrating are in
 * `app_backend.transaction_isolation.db.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	check_transaction_isolation,
	REQUIRED_TRANSACTION_ISOLATION,
	TransactionIsolationError
} from '#lib/server/app_backend.ts';

describe('check_transaction_isolation', () => {
	test('only read committed passes', () => {
		assert.strictEqual(REQUIRED_TRANSACTION_ISOLATION, 'read committed');
		check_transaction_isolation('read committed');
		for (const value of [
			'repeatable read',
			'serializable',
			'read uncommitted',
			'READ COMMITTED',
			''
		]) {
			let caught: unknown = null;
			try {
				check_transaction_isolation(value);
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof TransactionIsolationError, value);
			assert.strictEqual(caught.found, value);
			assert.include(caught.message, JSON.stringify(value));
			assert.include(caught.message, `requires "read committed"`);
			assert.include(caught.message, 'default_transaction_isolation');
		}
	});
});
