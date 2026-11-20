/**
 * `seed_dev_account` against a migrated database: a mixed-case username is
 * stored lowercased, for the account and its actor, as the
 * `account_username_lowercase` CHECK requires, and a rerun in another case
 * reuses that account; the seed flips `bootstrap_lock` in the transaction
 * that writes the account, so an account never exists beside an open
 * bootstrap window.
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

	const read_lock = async (db: ReturnType<typeof get_db>): Promise<boolean> => {
		const row = await db.query_one<{ bootstrapped: boolean }>(
			'SELECT bootstrapped FROM bootstrap_lock WHERE id = 1'
		);
		assert.ok(row, 'the lock row exists');
		return row.bootstrapped;
	};

	test('flips the bootstrap lock with the account it writes', async () => {
		const db = get_db();
		await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
		const deps = { db, hash_password: async (password: string) => `hash:${password}` };

		await seed_dev_account(deps, { username: 'lock_seed', password: 'pw' }, { log: silent_log });

		assert.strictEqual(await read_lock(db), true, 'a seeded account closes bootstrap');
	});

	test('a seed that fails leaves the lock as it was', async () => {
		const db = get_db();
		await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
		// an account with no actor makes the seed throw inside its transaction
		await db.query("INSERT INTO account (username, password_hash) VALUES ('actorless', 'hash:pw')");
		const deps = { db, hash_password: async (password: string) => `hash:${password}` };

		let threw = false;
		try {
			await seed_dev_account(deps, { username: 'actorless', password: 'pw' }, { log: silent_log });
		} catch {
			threw = true;
		}
		assert.ok(threw, 'an actorless account refuses the seed');
		assert.strictEqual(await read_lock(db), false, 'the flip rolled back with the seed');
	});
});
