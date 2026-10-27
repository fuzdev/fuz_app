/**
 * `query_count_active_accounts_with_global_role_for_update` locks what it
 * counted.
 *
 * A second last-admin guard counting while the first's transaction removes an
 * admin waits for that commit, then counts one — so two removals racing for
 * the last two admins can't both pass. Row-lock serialization needs two
 * concurrent transactions on real `pg` connections (the in-memory drivers run
 * transactions serially), so this runs against `pg_factory` only and skips
 * when `TEST_DATABASE_URL` is unset. Twin of the Rust
 * `the_admin_count_locks_what_it_counted` (`fuz_auth`).
 *
 * @module
 */

import { assert, test } from 'vitest';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import {
	query_count_active_accounts_with_global_role_for_update,
	query_create_role_grant
} from '#lib/auth/role_grant_queries.ts';
import { query_account_soft_delete } from '#lib/auth/account_queries.ts';
import { create_describe_db, auth_integration_truncate_tables } from '#lib/testing/db.ts';

import { pg_factory } from '../db_fixture.ts';
import { make_account } from './role_grant_offer_queries.fixtures.ts';

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg('query_count_active_accounts_with_global_role_for_update', (get_db) => {
	test('a second count waits on the rows the first locked, then counts one', async () => {
		const db = get_db();
		const one = await make_account(db, 'racing_admin_one');
		const two = await make_account(db, 'racing_admin_two');
		for (const a of [one, two]) {
			await query_create_role_grant(
				{ db },
				{ actor_id: a.actor_id, role: ROLE_ADMIN, granted_by: null }
			);
		}

		const removed = create_deferred<void>();
		const release_first = create_deferred<void>();
		const first = db.transaction(async (tx) => {
			assert.strictEqual(
				await query_count_active_accounts_with_global_role_for_update({ db: tx }, ROLE_ADMIN),
				2
			);
			assert.ok(await query_account_soft_delete({ db: tx }, two.account_id, null));
			removed.resolve();
			await release_first.promise;
		});
		await removed.promise;

		let second_done = false;
		const second = db
			.transaction((tx) =>
				query_count_active_accounts_with_global_role_for_update({ db: tx }, ROLE_ADMIN)
			)
			.finally(() => {
				second_done = true;
			});
		await wait(300);
		assert.isFalse(second_done, 'the second count waits on the first transaction');

		release_first.resolve();
		await first;
		assert.strictEqual(await second, 1, 'after the first commits, one admin is left');
	});
});
