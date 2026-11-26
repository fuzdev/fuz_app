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

const silent_log: SetupLogger = { ok: () => {}, skip: () => {}, warn: () => {}, error: () => {} };

/** A logger recording only its `warn` lines. */
const create_warn_log = (): SetupLogger & { warns: Array<string> } => {
	const warns: Array<string> = [];
	return { ...silent_log, warns, warn: (msg) => warns.push(msg) };
};

/** The warning naming each builtin role no live account holds. */
const no_live_role_warning = (missing: string): string =>
	`bootstrap is closed and no live account holds the ${missing} role — bootstrap refuses, so nothing will grant it; seed an account with roles: ['keeper', 'admin'] or reset the database`;

describe_db(
	'seed_dev_account',
	(get_db) => {
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

		test('warns naming each builtin role the seed leaves with no live holder', async () => {
			const db = get_db();
			await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
			const deps = { db, hash_password: async (password: string) => `hash:${password}` };

			const none_log = create_warn_log();
			await seed_dev_account(deps, { username: 'no_roles', password: 'pw' }, { log: none_log });
			assert.deepEqual(none_log.warns, [no_live_role_warning("'keeper' or 'admin'")]);

			const admin_log = create_warn_log();
			await seed_dev_account(
				deps,
				{ username: 'admin_only', password: 'pw', roles: ['admin'] },
				{ log: admin_log }
			);
			assert.deepEqual(admin_log.warns, [no_live_role_warning("'keeper'")]);
		});

		test('warns naming admin after a keeper-only seed', async () => {
			const db = get_db();
			await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
			const deps = { db, hash_password: async (password: string) => `hash:${password}` };

			const log = create_warn_log();
			await seed_dev_account(
				deps,
				{ username: 'keeper_only', password: 'pw', roles: ['keeper'] },
				{ log }
			);
			assert.deepEqual(log.warns, [no_live_role_warning("'admin'")]);
		});

		test('does not warn for a keeper and admin seed, nor for a later member seed', async () => {
			const db = get_db();
			await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
			const deps = { db, hash_password: async (password: string) => `hash:${password}` };

			const keeper_log = create_warn_log();
			await seed_dev_account(
				deps,
				{ username: 'seeded_keeper', password: 'pw', roles: ['keeper', 'admin'] },
				{ log: keeper_log }
			);
			assert.deepEqual(keeper_log.warns, [], 'the seed holds both roles');

			const member_log = create_warn_log();
			await seed_dev_account(
				deps,
				{ username: 'seeded_member', password: 'pw' },
				{ log: member_log }
			);
			assert.deepEqual(member_log.warns, [], 'another account holds both roles');
		});

		test('a rerun granting the missing roles to the existing account clears the warning', async () => {
			const db = get_db();
			await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
			const deps = { db, hash_password: async (password: string) => `hash:${password}` };

			const first_log = create_warn_log();
			const first = await seed_dev_account(
				deps,
				{ username: 'regranted', password: 'pw' },
				{ log: first_log }
			);
			assert.deepEqual(first_log.warns, [no_live_role_warning("'keeper' or 'admin'")]);

			const partial_log = create_warn_log();
			await seed_dev_account(
				deps,
				{ username: 'regranted', password: 'pw', roles: ['admin'] },
				{ log: partial_log }
			);
			assert.deepEqual(partial_log.warns, [no_live_role_warning("'keeper'")]);

			const rerun_log = create_warn_log();
			const rerun = await seed_dev_account(
				deps,
				{ username: 'regranted', password: 'pw', roles: ['keeper', 'admin'] },
				{ log: rerun_log }
			);
			assert.strictEqual(rerun.created, false);
			assert.strictEqual(rerun.account_id, first.account_id);
			assert.deepEqual(rerun_log.warns, []);
		});

		test('a seed that fails leaves the lock as it was', async () => {
			const db = get_db();
			await db.query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
			// an account with no actor makes the seed throw inside its transaction
			await db.query(
				"INSERT INTO account (username, password_hash) VALUES ('actorless', 'hash:pw')"
			);
			const deps = { db, hash_password: async (password: string) => `hash:${password}` };

			let threw = false;
			try {
				await seed_dev_account(
					deps,
					{ username: 'actorless', password: 'pw' },
					{ log: silent_log }
				);
			} catch {
				threw = true;
			}
			assert.ok(threw, 'an actorless account refuses the seed');
			assert.strictEqual(await read_lock(db), false, 'the flip rolled back with the seed');
		});
	},
	{
		exclude_db_invariants: {
			bootstrapped_without_live_keeper:
				'seed_dev_account flips the lock for a seed given no keeper role, as these tests seed',
			bootstrapped_without_live_admin:
				'seed_dev_account flips the lock for a seed given no admin role, as these tests seed'
		}
	}
);
