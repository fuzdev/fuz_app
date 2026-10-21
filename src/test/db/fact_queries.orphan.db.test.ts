/**
 * Orphan-fact query tests — the `older_than` cutoff is a grace window over a
 * fact's own `created_at` and every `fact_holder` row's, so a deduplicated
 * re-put (no new `fact` row) keeps an old orphan alive, and a repeat put by
 * the same holder refreshes its row. Twin of the Rust `fuz_fact` `fact_store`
 * `orphan_cutoff_keeps_a_fact_put_within_the_window` case. Rides the
 * full-spine fixture because the orphan predicate reads `cell.refs`.
 *
 * @module
 */

import { test, assert } from 'vitest';

import { PgFactStore } from '#lib/db/fact_store.ts';
import {
	query_orphan_facts_list,
	query_orphan_facts_select_for_delete
} from '#lib/db/fact_queries.ts';
import type { Db } from '#lib/db/db.ts';
import { create_test_account_with_actor } from '#lib/testing/db_entities.ts';
import { describe_db } from '../cell_db_fixture.ts';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

const HOUR_MS = 3_600_000;

/** Backdate every `fact` and `fact_holder` row two days, past a one-hour cutoff. */
const age_fact_rows = async (db: Db): Promise<void> => {
	const aged = new Date(Date.now() - 48 * HOUR_MS);
	await db.query('UPDATE fact SET created_at = $1', [aged]);
	await db.query('UPDATE fact_holder SET created_at = $1', [aged]);
};

/**
 * The orphan hashes past a one-hour cutoff, through both the preview and the
 * select-for-delete query (asserted to agree), sorted.
 */
const orphans_past_an_hour = async (db: Db): Promise<Array<string>> => {
	const cutoff = new Date(Date.now() - HOUR_MS);
	const preview = await query_orphan_facts_list({ db }, cutoff, 20);
	const listed = preview.sample.map((s) => s.hash).sort();
	const selected = (await query_orphan_facts_select_for_delete({ db }, cutoff))
		.map((o) => o.hash)
		.sort();
	assert.deepEqual(listed, selected, 'the preview and the sweep disagree');
	assert.strictEqual(preview.count, selected.length, 'the preview count and the sweep disagree');
	return selected;
};

describe_db('orphan fact cutoff', (get_db) => {
	test('the cutoff keeps a fact put within the window', async () => {
		const db = get_db();
		const store = new PgFactStore({ deps: { db } });
		const { actor: alice } = await create_test_account_with_actor(db, {
			username: 'orphan_alice'
		});
		const { actor: bob } = await create_test_account_with_actor(db, { username: 'orphan_bob' });
		const reuploaded = await store.put(encode('re-uploaded'), { holder: alice.id });
		const repeated = await store.put(encode('repeated'), { holder: alice.id });
		const stale = await store.put(encode('stale'), { holder: alice.id });
		const seeded = await store.put(encode('seeded'), { holder: null });
		await age_fact_rows(db);

		// every row is old: all four are past the cutoff
		assert.deepEqual(await orphans_past_an_hour(db), [reuploaded, repeated, stale, seeded].sort());

		// A second actor re-uploads one (a dedup hit, a fresh holder row), and
		// the first actor repeats its own put of another (refreshing its row).
		await store.put(encode('re-uploaded'), { holder: bob.id });
		await store.put(encode('repeated'), { holder: alice.id });

		// Both are kept; the old orphan whose holders are all old, and the old
		// system-put orphan, are still swept.
		assert.deepEqual(await orphans_past_an_hour(db), [stale, seeded].sort());

		// the cutoff is the whole grace filter: the unfiltered preview counts all
		assert.strictEqual((await query_orphan_facts_list({ db }, null, 20)).count, 4);
	});
});
