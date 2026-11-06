/**
 * `seed_dev_account` against a migrated database: a mixed-case username is
 * stored lowercased, for the account and its actor, as the
 * `account_username_lowercase` CHECK requires, and a rerun in another case
 * reuses that account.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { query_actors_by_account } from '#lib/auth/account_queries.ts';
import { seed_dev_account, type SetupLogger } from '#lib/dev/setup.ts';

import { describe_db } from '../db_fixture.ts';

const silent_log: SetupLogger = { ok: () => {}, skip: () => {}, error: () => {} };

describe_db('seed_dev_account', (get_db) => {
	test('stores a mixed-case username lowercased and reuses it in any case', async () => {
		const db = get_db();
		const deps = { db, hash_password: async (password: string) => `hash:${password}` };

		const seeded = await seed_dev_account(
			deps,
			{ username: 'Dev_Seed_User', password: 'pw' },
			{ log: silent_log }
		);
		assert.strictEqual(seeded.created, true);
		const rows = await db.query<{ username: string }>(
			'SELECT username FROM account WHERE id = $1',
			[seeded.account_id]
		);
		assert.deepEqual(
			rows.map((r) => r.username),
			['dev_seed_user']
		);
		const actors = await query_actors_by_account({ db }, seeded.account_id);
		assert.deepEqual(
			actors.map((a) => a.name),
			['dev_seed_user']
		);

		const again = await seed_dev_account(
			deps,
			{ username: 'DEV_SEED_USER', password: 'pw' },
			{ log: silent_log }
		);
		assert.strictEqual(again.created, false);
		assert.strictEqual(again.account_id, seeded.account_id);
		assert.strictEqual(again.actor_id, seeded.actor_id);
	});
});
