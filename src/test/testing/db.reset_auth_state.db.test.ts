/**
 * Tests for the shared auth reset in `testing/db.ts` — `reset_auth_state`
 * (the `_testing_reset` wipe) empties every auth row table, accepted offers
 * and their grants included, and restores the singleton rows; its table list
 * names every auth namespace table but the singletons and the migration
 * tracker, so a new auth table can't ship without joining the reset; and
 * `describe_db` restores the singletons between tests, so an `open_signup` a
 * test flips doesn't reach the next, and holds each test to the database
 * invariants.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	query_app_settings_load,
	query_app_settings_update
} from '#lib/auth/app_settings_queries.ts';
import { query_accept_offer } from '#lib/auth/role_grant_offer_queries.ts';
import { query_create_invite } from '#lib/auth/invite_queries.ts';
import { query_public_columns } from '#lib/db/schema_ready.ts';
import type { Db } from '#lib/db/db.ts';
import {
	auth_integration_truncate_tables,
	reset_auth_singletons,
	reset_auth_state
} from '#lib/testing/db.ts';
import {
	create_test_account_with_credentials,
	stub_password_deps,
	TEST_COOKIE_SECRET
} from '#lib/testing/app_server.ts';
import { create_keyring } from '#lib/auth/keyring.ts';

import { create_test_app } from '#lib/testing/test_app.ts';

import { describe_db } from '../auth_db_default.ts';
import { create_pending_offer, make_account } from '../auth/role_grant_offer_queries.fixtures.ts';

const log = new Logger('test', { level: 'off' });

/** The auth tables a reset restores rather than empties, and the migration tracker. */
const NOT_RESET_TABLES = ['app_settings', 'bootstrap_lock', 'schema_version'];

const read_lock = async (db: Db): Promise<boolean> =>
	(await db.query_one<{ bootstrapped: boolean }>('SELECT bootstrapped FROM bootstrap_lock'))!
		.bootstrapped;

const count_rows = async (db: Db, table: string): Promise<number> =>
	Number((await db.query_one<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))!.n);

describe_db(
	'reset_auth_state',
	(get_db) => {
		test('the reset list names every auth table but the singletons and the tracker', async () => {
			const tables = Object.keys(await query_public_columns(get_db()));
			assert.deepStrictEqual(
				tables.filter((t) => !NOT_RESET_TABLES.includes(t)).toSorted(),
				[...auth_integration_truncate_tables].toSorted()
			);
		});

		test('empties every auth row table, an accepted offer and its grant included', async () => {
			const db = get_db();
			const keyring_result = create_keyring(TEST_COOKIE_SECRET);
			assert.ok(keyring_result.ok);
			const keeper = await create_test_account_with_credentials({
				db,
				keyring: keyring_result.keyring,
				password: stub_password_deps,
				roles: ['keeper', 'admin']
			});
			await db.query('UPDATE bootstrap_lock SET bootstrapped = true');
			await query_app_settings_update({ db }, true, keeper.actor.id);
			const grantor = await make_account(db, 'grantor');
			const recipient = await make_account(db, 'recipient');
			const offer = await create_pending_offer(db, grantor, recipient);
			await query_accept_offer(
				{ db, log },
				{ offer_id: offer.id, to_account_id: recipient.account_id, actor_id: recipient.actor_id }
			);
			await query_create_invite({ db }, { username: 'invitee', created_by: keeper.actor.id });
			await db.query("INSERT INTO audit_log (event_type, outcome) VALUES ('login', 'success')");
			for (const table of auth_integration_truncate_tables) {
				assert.isAbove(await count_rows(db, table), 0, `${table} holds a row before the reset`);
			}

			await reset_auth_state(db);

			for (const table of auth_integration_truncate_tables) {
				assert.strictEqual(await count_rows(db, table), 0, `${table} is empty`);
			}
			const settings = await query_app_settings_load({ db });
			assert.strictEqual(settings.open_signup, false);
			assert.isNull(settings.updated_at);
			assert.isNull(settings.updated_by);
			assert.isFalse(await read_lock(db));
		});

		test('reset_auth_singletons leaves the row tables alone', async () => {
			const db = get_db();
			const account = await make_account(db, 'kept');
			await db.query('UPDATE bootstrap_lock SET bootstrapped = true');
			await reset_auth_singletons(db);
			assert.isFalse(await read_lock(db));
			assert.strictEqual(await count_rows(db, 'account'), 1);
			assert.ok(account.account_id);
		});

		// the two tests below run in order: the first leaves signup open and the
		// lock set, the second sees neither
		test('a test that opens signup and sets the lock', async () => {
			const db = get_db();
			const account = await make_account(db, 'opener');
			await query_app_settings_update({ db }, true, account.actor_id);
			await db.query('UPDATE bootstrap_lock SET bootstrapped = true');
		});

		test('the next test starts with signup closed and the lock unset', async () => {
			const db = get_db();
			const settings = await query_app_settings_load({ db });
			assert.strictEqual(settings.open_signup, false);
			assert.isNull(settings.updated_by);
			assert.isFalse(await read_lock(db));
		});
	},
	{
		exclude_db_invariants: {
			bootstrapped_without_live_keeper: 'a test sets the bootstrap lock by hand, with no keeper',
			bootstrapped_without_live_admin: 'a test sets the bootstrap lock by hand, with no admin'
		}
	}
);

describe_db(
	'describe_db invariant check',
	(get_db) => {
		// an account with no bootstrap breaks `account_without_bootstrap`, which
		// this suite opts back into
		test.fails('a test that leaves an invariant broken fails', async () => {
			await make_account(get_db(), 'unbootstrapped');
		});

		test('a test that leaves the invariants whole passes', async () => {
			assert.strictEqual(await count_rows(get_db(), 'account'), 0);
		});

		// an app on a database of its own leaves the suite's check in place
		test.fails('a test app over its own database leaves the suite check firing', async () => {
			await create_test_app({ session_cookie_name: 'test_session', create_route_specs: () => [] });
			await make_account(get_db(), 'unbootstrapped_beside_app');
		});

		// the app's own check, with its exclusion, runs instead of the suite's
		test('a test app over the suite database checks it in place of the suite', async () => {
			const db = get_db();
			await create_test_app({
				session_cookie_name: 'test_session',
				db,
				create_route_specs: () => [],
				exclude_db_invariants: {
					actor_tombstone_disagrees_with_account: 'the test tombstones an actor by query'
				}
			});
			const extra = await make_account(db, 'tombstoned_actor');
			await db.query('UPDATE actor SET deleted_at = NOW() WHERE id = $1', [extra.actor_id]);
		});
	},
	{ include_db_invariants: ['account_without_bootstrap'] }
);

test('include_db_invariants beside an exclusion of all is refused', () => {
	assert.throws(
		() =>
			describe_db('refused', () => {}, {
				exclude_db_invariants: { all: 'every invariant off' },
				include_db_invariants: ['account_without_bootstrap']
			}),
		/include_db_invariants checks nothing beside exclude_db_invariants 'all'/
	);
});
