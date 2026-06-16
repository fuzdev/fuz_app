/**
 * Unit tests for account_queries SQL shape — no real database needed.
 *
 * Guards the account-lookup fail-loud invariant: the by-id / username / email
 * lookups must select named columns (never `SELECT *`) so a dropped column raises a
 * Postgres error instead of silently reading back as `undefined`. A missing
 * `deleted_at` under `SELECT *` once turned every login into a silent 401 —
 * `query_account_by_username_or_email` filters on `account.deleted_at === null`,
 * and `undefined === null` is `false`, so every credential resolved to
 * "not found." See ../auth/account_queries.db.test.ts for behavior coverage.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {Db, no_nested_transaction, type DbClient} from '$lib/db/db.ts';
import {
	query_account_by_id,
	query_account_by_username,
	query_account_by_email,
} from '$lib/auth/account_queries.ts';

/** Create a mock `DbClient` that records every issued query and returns no rows. */
const create_mock_client = (): DbClient & {
	calls: Array<{text: string; values?: Array<unknown>}>;
} => {
	const calls: Array<{text: string; values?: Array<unknown>}> = [];
	return {
		calls,
		query: async <T>(text: string, values?: Array<unknown>) => {
			calls.push({text, values});
			return {rows: [] as Array<T>};
		},
	};
};

describe('account_queries SQL shape', () => {
	test('auth-resolution lookups select named columns (never SELECT *) so a dropped column fails loud', async () => {
		const client = create_mock_client();
		const deps = {db: new Db({client, transaction: no_nested_transaction})};

		await query_account_by_id(deps, '00000000-0000-0000-0000-000000000001');
		await query_account_by_username(deps, 'alice');
		await query_account_by_email(deps, 'alice@example.com');

		assert.strictEqual(client.calls.length, 3);
		for (const call of client.calls) {
			assert.ok(
				!/select\s+\*/i.test(call.text),
				`account lookup must not use SELECT *, got: ${call.text}`,
			);
			// The column whose absence caused the silent-401 outage must be
			// requested by name so PG raises on schema drift.
			assert.ok(
				call.text.includes('deleted_at'),
				`account lookup must reference deleted_at by name, got: ${call.text}`,
			);
		}
	});
});
