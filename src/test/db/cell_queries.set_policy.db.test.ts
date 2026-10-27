/**
 * `query_cell_set_policy` answers the policy it replaced, read under the row
 * lock it writes with.
 *
 * Sequential sets each answer the value the previous one wrote, on every
 * driver; a contribution and a soft-deleted root match nothing. The race —
 * a set waiting on a concurrent set's lock, then answering the value that set
 * committed rather than the one its own snapshot held — needs two concurrent
 * transactions on real `pg` connections (the in-memory drivers run
 * transactions serially), so it runs against `pg_factory` only and skips when
 * `TEST_DATABASE_URL` is unset. Twin of the Rust
 * `policy_set_reads_the_previous_policy_under_its_lock` (`fuz_cell`).
 *
 * @module
 */

import { assert, test } from 'vitest';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';

import {
	query_cell_create,
	query_cell_delete,
	query_cell_set_policy
} from '#lib/db/cell_queries.ts';
import { CELL_DROP_TABLES } from '#lib/db/cell_ddl.ts';
import { FACT_DROP_TABLES } from '#lib/db/fact_ddl.ts';
import type { CellPolicy } from '#lib/auth/cell_action_specs.ts';
import { auth_integration_truncate_tables, create_describe_db } from '#lib/testing/db.ts';

import { describe_db, pg_factory } from '../cell_db_fixture.ts';

const FIRST: CellPolicy = { post: { moderation_required: true } };
const SECOND: CellPolicy = { post: { moderation_required: false } };
const THIRD: CellPolicy = { comment: { moderation_required: true } };

describe_db('query_cell_set_policy', (get_db) => {
	test('each set answers the policy the previous one wrote', async () => {
		const deps = { db: get_db() };
		const root = await query_cell_create(deps, { data: {}, policy: FIRST });

		const set = await query_cell_set_policy(deps, root.id, SECOND, { updated_by: null });
		assert.ok(set);
		assert.deepStrictEqual(set.cell.policy, SECOND);
		assert.deepStrictEqual(set.previous_policy, FIRST);
		assert.notProperty(set.cell, 'previous_policy', 'the row keeps the CellRow shape');

		const cleared = await query_cell_set_policy(deps, root.id, null, { updated_by: null });
		assert.ok(cleared);
		assert.isNull(cleared.cell.policy);
		assert.deepStrictEqual(cleared.previous_policy, SECOND);

		const again = await query_cell_set_policy(deps, root.id, THIRD, { updated_by: null });
		assert.ok(again);
		assert.isNull(again.previous_policy);
		assert.deepStrictEqual(again.cell.policy, THIRD);
	});

	test('a contribution and a deleted root match nothing', async () => {
		const deps = { db: get_db() };
		const root = await query_cell_create(deps, { data: {}, policy: FIRST });
		const child = await query_cell_create(deps, {
			data: {},
			parent_id: root.id,
			root_id: root.id
		});
		assert.isNull(await query_cell_set_policy(deps, child.id, SECOND, { updated_by: null }));
		assert.ok(await query_cell_delete(deps, root.id));
		assert.isNull(await query_cell_set_policy(deps, root.id, SECOND, { updated_by: null }));
	});
});

const describe_pg = create_describe_db(pg_factory, [
	...CELL_DROP_TABLES,
	...FACT_DROP_TABLES,
	...auth_integration_truncate_tables
]);

describe_pg('query_cell_set_policy under a concurrent set', (get_db) => {
	test('a set waiting on another answers the value that one committed', async () => {
		const db = get_db();
		const root = await query_cell_create({ db }, { data: {}, policy: FIRST });

		const written = create_deferred<void>();
		const release_first = create_deferred<void>();
		const first = db.transaction(async (tx) => {
			let set;
			try {
				set = await query_cell_set_policy({ db: tx }, root.id, SECOND, { updated_by: null });
			} finally {
				written.resolve();
			}
			assert.deepStrictEqual(set?.previous_policy, FIRST);
			await release_first.promise;
		});
		await Promise.race([written.promise, first]);

		// a failure below must still end the first transaction and settle the second, or
		// its row lock and checked-out client block the shared database's teardown
		let second: Promise<unknown> | undefined;
		let result;
		try {
			let second_done = false;
			const pending_second = db
				.transaction((tx) =>
					query_cell_set_policy({ db: tx }, root.id, THIRD, { updated_by: null })
				)
				.finally(() => {
					second_done = true;
				});
			second = pending_second;
			await wait(300);
			assert.isFalse(second_done, 'the second set waits on the first transaction');

			release_first.resolve();
			await first;
			result = await pending_second;
		} finally {
			release_first.resolve();
			await Promise.allSettled([first, second]);
		}
		assert.ok(result);
		assert.deepStrictEqual(result.previous_policy, SECOND, 'the committed value, not the snapshot');
		assert.deepStrictEqual(result.cell.policy, THIRD);
	});
});
