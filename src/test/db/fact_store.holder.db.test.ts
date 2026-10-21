/**
 * `PgFactStore` holder tests — every put that names a holder records
 * `(actor, hash)` in `fact_holder`, a fresh insert and a dedup hit alike, in
 * the transaction that writes the fact row; the rows go with their actor or
 * fact. Twin of the Rust `fuz_fact` `fact_store` holder cases.
 *
 * @module
 */

import { test, assert, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { PgFactStore } from '#lib/db/fact_store.ts';
import type { Db } from '#lib/db/db.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';
import { create_node_runtime } from '#lib/runtime/node.ts';
import { create_test_account_with_actor } from '#lib/testing/db_entities.ts';
import { describe_db } from '../fact_db_fixture.ts';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

const runtime = create_node_runtime();
const temp_dirs: Array<string> = [];
afterEach(async () => {
	for (const dir of temp_dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The hashes `actor_id` holds, sorted. */
const held_by = async (db: Db, actor_id: Uuid): Promise<Array<string>> =>
	(
		await db.query<{ hash: string }>(
			'SELECT hash FROM fact_holder WHERE actor_id = $1 ORDER BY hash',
			[actor_id]
		)
	).map((r) => r.hash);

const stream_of = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

describe_db('pg_fact_store holders', (get_db) => {
	const seed_actor = async (username: string): Promise<{ account_id: Uuid; actor_id: Uuid }> => {
		const { account, actor } = await create_test_account_with_actor(get_db(), { username });
		return { account_id: account.id, actor_id: actor.id };
	};

	test('put records the holder on a fresh insert and on a dedup hit', async () => {
		const db = get_db();
		const store = new PgFactStore({ deps: { db } });
		const { actor_id: first } = await seed_actor('holder_first');
		const { actor_id: second } = await seed_actor('holder_second');

		// A system put records nobody.
		await store.put(encode('seeded'), { holder: null });
		assert.deepEqual(await held_by(db, first), []);
		const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM fact_holder');
		assert.strictEqual(rows[0]!.n, 0, 'a system put recorded a holder');

		// The first actor's put of new bytes makes it a holder.
		const hash = await store.put(encode('shared bytes'), { holder: first });
		assert.deepEqual(await held_by(db, first), [hash]);
		assert.deepEqual(await held_by(db, second), []);

		// The second actor brings identical bytes: the fact dedups, and the
		// second actor becomes a holder too.
		assert.strictEqual(await store.put(encode('shared bytes'), { holder: second }), hash);
		assert.deepEqual(await held_by(db, second), [hash]);

		// A repeat put by a holder is idempotent.
		await store.put(encode('shared bytes'), { holder: first });
		assert.deepEqual(await held_by(db, first), [hash]);
	});

	test('put_stream records the holder, through a disk spill and a dedup hit', async () => {
		const db = get_db();
		const facts_dir = await mkdtemp(join(tmpdir(), 'fuz_fact_holder_'));
		temp_dirs.push(facts_dir);
		const store = new PgFactStore({
			deps: { db },
			disk_root: facts_dir,
			fs: runtime,
			embedded_threshold: 16
		});
		const { actor_id } = await seed_actor('holder_streamer');
		const system = await store.put(encode('system seeded'), { holder: null });
		const spilled = await store.put_stream(
			stream_of(encode('a body past the sixteen byte threshold')),
			1_000_000,
			{ holder: actor_id }
		);
		const deduped = await store.put_stream(stream_of(encode('system seeded')), 1_000_000, {
			holder: actor_id
		});
		assert.strictEqual(deduped.hash, system);
		assert.deepEqual(await held_by(db, actor_id), [spilled.hash, system].sort());
	});

	test('a failed holder insert rolls back the fact row it rode with', async () => {
		const db = get_db();
		const store = new PgFactStore({ deps: { db } });
		// No actor has this id, so the holder insert fails its FK.
		await assert_rejects(() =>
			store.put(encode('orphaned by the rollback'), { holder: create_uuid() })
		);
		const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM fact');
		assert.strictEqual(rows[0]!.n, 0, 'the fact row survived its transaction');
	});

	test('holder rows cascade with the actor and with the fact', async () => {
		const db = get_db();
		const store = new PgFactStore({ deps: { db } });
		const leaver = await seed_actor('holder_leaver');
		const { actor_id: keeper } = await seed_actor('holder_keeper');
		const kept = await store.put(encode('kept'), { holder: leaver.actor_id });
		await store.put(encode('kept'), { holder: keeper });
		const dropped = await store.put(encode('dropped'), { holder: keeper });

		// Deleting the account deletes its actor, and the actor's possession with it.
		await db.query('DELETE FROM account WHERE id = $1', [leaver.account_id]);
		assert.deepEqual(await held_by(db, leaver.actor_id), []);
		assert.ok(await store.has(kept), 'the fact itself stays');

		// Deleting a fact drops its holder rows.
		assert.ok(await store.delete(dropped));
		assert.deepEqual(await held_by(db, keeper), [kept]);
	});
});
