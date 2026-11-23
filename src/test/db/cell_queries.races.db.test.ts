/**
 * A cell write naming an actor while that actor's account is purged.
 *
 * The provenance stamps `cell.updated_by` and `cell_grant.granted_by` carry no
 * foreign key, so a write stamping a purged actor neither waits on the purge
 * nor fails after it, and the purge's cascade never writes a stamp. The purge
 * is its account `DELETE` (`query_purge_account`).
 *
 * On every driver, a cell grant by a granter purged after its request was
 * authorized is written. On real `pg` only (`TEST_DATABASE_URL`), an owner's
 * first edit of their own cell across their purge: the purge's cascade pinned
 * by a third transaction holding the owner's grant, a row it reaches before
 * any cell row. The in-memory drivers have one connection, so the edit would
 * queue behind the pin whatever it locks.
 *
 * Twin of the Rust `fuz_cell` `tests/cell_purge_races.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { query_create_account_with_actor, query_purge_account } from '#lib/auth/account_queries.ts';
import { query_cell_create, query_cell_get, query_cell_update } from '#lib/db/cell_queries.ts';
import { query_cell_grant_create } from '#lib/db/cell_grant_queries.ts';
import { CELL_DROP_TABLES } from '#lib/db/cell_ddl.ts';
import { FACT_DROP_TABLES } from '#lib/db/fact_ddl.ts';
import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';
import type { Db } from '#lib/db/db.ts';

import { describe_db, pg_factory } from '../cell_db_fixture.ts';

/** How long a lock wait the test arranged may take to show, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const account = async (db: Db, username: string) => {
	const { account, actor } = await query_create_account_with_actor(
		{ db },
		{ username, password_hash: 'hash' }
	);
	return { account_id: account.id, actor_id: actor.id };
};

const lock_waiters = async (db: Db): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM pg_stat_activity
				 WHERE wait_event_type = 'Lock' AND datname = current_database()`
			)
		)[0]!.n
	);

describe_db('a cell write naming a purged actor', (get_db) => {
	// The stamp carries no foreign key, so the insert no longer fails on it
	// (`23503` with one).
	test('a cell grant by a purged granter is written', async () => {
		const db = get_db();
		const granter = await account(db, 'cell_race_granter');
		const grantee = await account(db, 'cell_race_grantee');
		const cell = await query_cell_create({ db }, { data: {}, kind: 'note' });
		assert.ok(await query_purge_account({ db }, granter.account_id), 'the granter is purged');
		const grant = await query_cell_grant_create(
			{ db },
			{
				cell_id: cell.id,
				level: 'viewer',
				principal: { kind: 'actor', actor_id: grantee.actor_id },
				granted_by: granter.actor_id
			}
		);
		assert.strictEqual(grant.granted_by, granter.actor_id, 'the stamp names the purged granter');
	});
});

const describe_pg = create_describe_db(pg_factory, [
	...CELL_DROP_TABLES,
	...FACT_DROP_TABLES,
	...auth_integration_truncate_tables
]);

describe_pg('a cell write across a purge of its actor', (get_db) => {
	// The owner's grant pinned, so the purge waits in its cascade, past its
	// delete of the owner's actor; the edit then writes the cell and stamps
	// `updated_by` with the owner's actor. With a foreign key on the stamp, the
	// edit waited on the deleted actor while holding the cell, whose `created_by`
	// the cascade then set null: a deadlock. The stamp has none, so the edit
	// commits, the cascade sets `created_by` null after it (the owner keeps its
	// foreign key), and `updated_by` keeps the purged actor's id.
	test("an owner's first edit of their cell across their purge: both commit", async () => {
		const db = get_db();
		const owner = await account(db, 'cell_race_owner');
		const pinned = (
			await db.query<{ id: string }>(
				`INSERT INTO role_grant (actor_id, role) VALUES ($1, 'cell_race_role') RETURNING id`,
				[owner.actor_id]
			)
		)[0]!.id;
		const cell = await query_cell_create(
			{ db },
			{ data: { v: 1 }, kind: 'note', created_by: owner.actor_id }
		);
		assert.strictEqual(cell.updated_by, null, "the owner's edit is the first");

		const locked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pin = db.transaction(async (tx) => {
			await tx.query(`SELECT id FROM role_grant WHERE id = $1 FOR UPDATE`, [pinned]);
			locked.resolve();
			await release.promise;
		});
		await locked.promise;
		try {
			const purged = db.transaction((tx) => query_purge_account({ db: tx }, owner.account_id));
			const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
			while ((await lock_waiters(db)) < 1) {
				assert.ok(Date.now() < deadline, 'the purge waits on the pinned grant');
				await wait(5);
			}
			const state = { settled: false };
			const edited = db
				.transaction((tx) =>
					query_cell_update({ db: tx }, cell.id, { data: { v: 2 }, updated_by: owner.actor_id })
				)
				.then(
					(value) => ({ ok: true as const, value }),
					(error: unknown) => ({ ok: false as const, error })
				)
				.finally(() => {
					state.settled = true;
				});
			while (!state.settled && (await lock_waiters(db)) < 2) {
				assert.ok(Date.now() < deadline, 'the edit neither waits nor finishes');
				await wait(5);
			}
			release.resolve();
			await pin;
			const edit = await edited;
			assert.ok(edit.ok, `the edit: ${String(edit.ok || edit.error)}`);
			assert.strictEqual(edit.value?.updated_by, owner.actor_id, 'the edit stamped the owner');
			assert.ok(await purged, 'the purge');
		} finally {
			// released on a failure too, so no later test waits on its row lock
			release.resolve();
		}
		const after = await query_cell_get({ db }, cell.id);
		assert.ok(after, 'the cell stands');
		assert.strictEqual(after.created_by, null, 'the cascade set the owner null');
		assert.strictEqual(after.updated_by, owner.actor_id, "the stamp keeps the purged actor's id");
		assert.deepStrictEqual(after.data, { v: 2 }, 'the edit stands');
	}, 30_000);
});
