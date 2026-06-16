/**
 * Tests for `query_actors_by_ids` — batched actor → label resolver.
 *
 * Covers empty-input fast-path, single + batch resolution, the
 * info-leak audit (no `account_id` projection), and the tombstone-
 * oracle posture (unknown ids and cascade-orphaned actors drop
 * silently).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {create_uuid} from '@fuzdev/fuz_util/id.ts';

import {query_actors_by_ids} from '$lib/auth/actor_lookup_queries.ts';
import {query_purge_account} from '$lib/auth/account_queries.ts';
import {create_test_account_with_actor} from '$lib/testing/db_entities.ts';

import {describe_db} from '../db_fixture.ts';

describe_db('actor_lookup_queries', (get_db) => {
	describe('query_actors_by_ids', () => {
		test('empty input fast-paths to []', async () => {
			const db = get_db();
			const rows = await query_actors_by_ids({db}, []);
			assert.deepStrictEqual(rows, []);
		});

		test('resolves a single actor with username + display_name', async () => {
			const db = get_db();
			const {actor} = await create_test_account_with_actor(db, {username: 'alice'});
			const rows = await query_actors_by_ids({db}, [actor.id]);
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.id, actor.id);
			assert.strictEqual(rows[0]!.username, 'alice');
			// `query_create_account_with_actor` defaults `actor.name` to the username.
			assert.strictEqual(rows[0]!.display_name, 'alice');
		});

		test('resolves a batch of actors across multiple accounts', async () => {
			const db = get_db();
			const {actor: a} = await create_test_account_with_actor(db, {username: 'alice'});
			const {actor: b} = await create_test_account_with_actor(db, {username: 'bob'});
			const {actor: c} = await create_test_account_with_actor(db, {username: 'carol'});
			const rows = await query_actors_by_ids({db}, [a.id, b.id, c.id]);
			const by_id = new Map(rows.map((r) => [r.id, r]));
			assert.strictEqual(by_id.size, 3);
			assert.strictEqual(by_id.get(a.id)?.username, 'alice');
			assert.strictEqual(by_id.get(b.id)?.username, 'bob');
			assert.strictEqual(by_id.get(c.id)?.username, 'carol');
		});

		test('unknown ids drop out silently — existence-oracle by diff, not by tombstone', async () => {
			const db = get_db();
			const {actor} = await create_test_account_with_actor(db, {username: 'alice'});
			const unknown = create_uuid();
			const rows = await query_actors_by_ids({db}, [actor.id, unknown]);
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.id, actor.id);
		});

		test('cascade-orphaned actor drops out silently — no never-existed/deleted distinguisher', async () => {
			const db = get_db();
			const {account, actor} = await create_test_account_with_actor(db, {username: 'alice'});
			await query_purge_account({db}, account.id);
			const rows = await query_actors_by_ids({db}, [actor.id]);
			assert.deepStrictEqual(rows, []);
		});

		test('row shape projects only {id, username, display_name} — no account_id leak', async () => {
			const db = get_db();
			const {actor} = await create_test_account_with_actor(db, {username: 'alice'});
			const [row] = await query_actors_by_ids({db}, [actor.id]);
			assert.ok(row);
			const keys = Object.keys(row).sort();
			assert.deepStrictEqual(keys, ['display_name', 'id', 'username']);
		});

		test('duplicate ids in input collapse to one row (PK uniqueness)', async () => {
			const db = get_db();
			const {actor} = await create_test_account_with_actor(db, {username: 'alice'});
			const rows = await query_actors_by_ids({db}, [actor.id, actor.id, actor.id]);
			assert.strictEqual(rows.length, 1);
		});
	});
});
