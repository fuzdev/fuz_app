/**
 * Tests for `query_actor_search` — case-insensitive prefix search over
 * `actor.name`, optionally filtered by `scope_ids` against active
 * role_grants.
 *
 * Covers the prefix-only contract (LIKE wildcards in input are escaped),
 * the scope_ids JOIN (active-only role_grants, multi-grant DISTINCT
 * collapse), the empty-result fail-soft posture, and the wire-shape
 * audit (no `account_id` projection).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Uuid, create_uuid } from '@fuzdev/fuz_util/id.ts';

import { query_actor_search } from '$lib/auth/actor_search_queries.ts';
import { query_create_role_grant } from '$lib/auth/role_grant_queries.ts';
import { create_test_account_with_actor } from '$lib/testing/db_entities.ts';
import type { Db } from '$lib/db/db.ts';

import { describe_db } from '../db_fixture.ts';

const set_actor_name = async (db: Db, actor_id: Uuid, name: string): Promise<void> => {
	await db.query(`UPDATE actor SET name = $1 WHERE id = $2`, [name, actor_id]);
};

describe_db('actor_search_queries', (get_db) => {
	describe('prefix match', () => {
		test('case-insensitive prefix matches on actor.name', async () => {
			const db = get_db();
			const { actor } = await create_test_account_with_actor(db, { username: 'alice' });
			await set_actor_name(db, actor.id, 'Alice Anderson');

			const rows = await query_actor_search({ db }, { query: 'ali', limit: 10 });
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.id, actor.id);
			assert.strictEqual(rows[0]!.display_name, 'Alice Anderson');
		});

		test('uppercase query matches lowercase name', async () => {
			const db = get_db();
			const { actor } = await create_test_account_with_actor(db, { username: 'bob' });
			await set_actor_name(db, actor.id, 'bob smith');

			const rows = await query_actor_search({ db }, { query: 'BOB', limit: 10 });
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.id, actor.id);
		});

		test('only prefix matches — not infix or suffix', async () => {
			const db = get_db();
			const { actor: a } = await create_test_account_with_actor(db, { username: 'aaa' });
			await set_actor_name(db, a.id, 'Alice');
			const { actor: b } = await create_test_account_with_actor(db, { username: 'bbb' });
			await set_actor_name(db, b.id, 'Malice'); // contains "alice" but not prefix

			const rows = await query_actor_search({ db }, { query: 'ali', limit: 10 });
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.id, a.id);
		});

		test('no match returns empty array — fail-soft posture', async () => {
			const db = get_db();
			await create_test_account_with_actor(db, { username: 'alice' });

			const rows = await query_actor_search({ db }, { query: 'zzz', limit: 10 });
			assert.deepStrictEqual(rows, []);
		});
	});

	describe('LIKE wildcard escaping', () => {
		test('% in query does not widen to full-LIKE', async () => {
			const db = get_db();
			const { actor: a } = await create_test_account_with_actor(db, { username: 'aaa' });
			await set_actor_name(db, a.id, 'a%b'); // literal % in name
			const { actor: b } = await create_test_account_with_actor(db, { username: 'bbb' });
			await set_actor_name(db, b.id, 'axb');

			// "%b" must NOT match arbitrary "_b" — only literal "%b" prefix.
			const rows = await query_actor_search({ db }, { query: '%b', limit: 10 });
			assert.strictEqual(rows.length, 0);

			// Searching for the literal "a%" prefix matches "a%b".
			const literal_rows = await query_actor_search({ db }, { query: 'a%', limit: 10 });
			assert.strictEqual(literal_rows.length, 1);
			assert.strictEqual(literal_rows[0]!.id, a.id);
		});

		test('_ in query does not match any character', async () => {
			const db = get_db();
			const { actor: a } = await create_test_account_with_actor(db, { username: 'aaa' });
			await set_actor_name(db, a.id, 'a_b');
			const { actor: b } = await create_test_account_with_actor(db, { username: 'bbb' });
			await set_actor_name(db, b.id, 'axb');

			// "_b" must NOT match "xb" — only literal "_b" prefix.
			const rows = await query_actor_search({ db }, { query: '_b', limit: 10 });
			assert.strictEqual(rows.length, 0);

			// Literal "a_" prefix matches "a_b" only.
			const literal_rows = await query_actor_search({ db }, { query: 'a_', limit: 10 });
			assert.strictEqual(literal_rows.length, 1);
			assert.strictEqual(literal_rows[0]!.id, a.id);
		});

		test('backslash in query is treated literally', async () => {
			const db = get_db();
			const { actor: a } = await create_test_account_with_actor(db, { username: 'aaa' });
			await set_actor_name(db, a.id, 'a\\b');

			const rows = await query_actor_search({ db }, { query: 'a\\', limit: 10 });
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.id, a.id);
		});
	});

	describe('scope_ids filtering', () => {
		test('filters to actors holding an active role_grant on supplied scopes', async () => {
			const db = get_db();
			const scope_a = create_uuid();
			const scope_b = create_uuid();
			const { actor: in_scope } = await create_test_account_with_actor(db, { username: 'a1' });
			await set_actor_name(db, in_scope.id, 'alpha');
			await query_create_role_grant(
				{ db },
				{
					actor_id: in_scope.id,
					role: 'classroom_student',
					scope_kind: 'classroom',
					scope_id: scope_a,
					granted_by: null
				}
			);
			const { actor: other_scope } = await create_test_account_with_actor(db, { username: 'a2' });
			await set_actor_name(db, other_scope.id, 'alpha-other');
			await query_create_role_grant(
				{ db },
				{
					actor_id: other_scope.id,
					role: 'classroom_student',
					scope_kind: 'classroom',
					scope_id: scope_b,
					granted_by: null
				}
			);
			const { actor: unscoped } = await create_test_account_with_actor(db, { username: 'a3' });
			await set_actor_name(db, unscoped.id, 'alpha-unscoped');

			const rows = await query_actor_search(
				{ db },
				{
					query: 'alp',
					scope_ids: [scope_a],
					limit: 10
				}
			);
			const ids = rows.map((r) => r.id);
			assert.deepStrictEqual(ids, [in_scope.id]);
		});

		test('revoked role_grant does not confer membership', async () => {
			const db = get_db();
			const scope = create_uuid();
			const { actor } = await create_test_account_with_actor(db, { username: 'alice' });
			await set_actor_name(db, actor.id, 'alice');
			const role_grant = await query_create_role_grant(
				{ db },
				{
					actor_id: actor.id,
					role: 'classroom_student',
					scope_kind: 'classroom',
					scope_id: scope,
					granted_by: null
				}
			);
			await db.query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [role_grant.id]);

			const rows = await query_actor_search(
				{ db },
				{
					query: 'ali',
					scope_ids: [scope],
					limit: 10
				}
			);
			assert.deepStrictEqual(rows, []);
		});

		test('expired role_grant does not confer membership', async () => {
			const db = get_db();
			const scope = create_uuid();
			const { actor } = await create_test_account_with_actor(db, { username: 'alice' });
			await set_actor_name(db, actor.id, 'alice');
			const role_grant = await query_create_role_grant(
				{ db },
				{
					actor_id: actor.id,
					role: 'classroom_student',
					scope_kind: 'classroom',
					scope_id: scope,
					granted_by: null
				}
			);
			await db.query(`UPDATE role_grant SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [
				role_grant.id
			]);

			const rows = await query_actor_search(
				{ db },
				{
					query: 'ali',
					scope_ids: [scope],
					limit: 10
				}
			);
			assert.deepStrictEqual(rows, []);
		});

		test('actor holding multiple matching role_grants collapses to one row', async () => {
			const db = get_db();
			const scope_a = create_uuid();
			const scope_b = create_uuid();
			const { actor } = await create_test_account_with_actor(db, { username: 'alice' });
			await set_actor_name(db, actor.id, 'alice');
			for (const scope_id of [scope_a, scope_b]) {
				await query_create_role_grant(
					{ db },
					{
						actor_id: actor.id,
						role: 'classroom_student',
						scope_kind: 'classroom',
						scope_id,
						granted_by: null
					}
				);
			}

			const rows = await query_actor_search(
				{ db },
				{
					query: 'ali',
					scope_ids: [scope_a, scope_b],
					limit: 10
				}
			);
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.id, actor.id);
		});

		test('limit applies on the scoped path', async () => {
			const db = get_db();
			const scope = create_uuid();
			for (let i = 0; i < 10; i++) {
				const { actor } = await create_test_account_with_actor(db, { username: `scope_lim_${i}` });
				await set_actor_name(db, actor.id, `Scoped Match ${i}`);
				await query_create_role_grant(
					{ db },
					{
						actor_id: actor.id,
						role: 'classroom_student',
						scope_kind: 'classroom',
						scope_id: scope,
						granted_by: null
					}
				);
			}
			const rows = await query_actor_search(
				{ db },
				{ query: 'scoped match', scope_ids: [scope], limit: 3 }
			);
			assert.strictEqual(rows.length, 3);
		});

		test('non-matching scope_id returns empty even when actor matches prefix', async () => {
			const db = get_db();
			const real_scope = create_uuid();
			const random_scope = create_uuid();
			const { actor } = await create_test_account_with_actor(db, { username: 'alice' });
			await set_actor_name(db, actor.id, 'alice');
			await query_create_role_grant(
				{ db },
				{
					actor_id: actor.id,
					role: 'classroom_student',
					scope_kind: 'classroom',
					scope_id: real_scope,
					granted_by: null
				}
			);

			const rows = await query_actor_search(
				{ db },
				{
					query: 'ali',
					scope_ids: [random_scope],
					limit: 10
				}
			);
			assert.deepStrictEqual(rows, []);
		});
	});

	describe('limit + ordering', () => {
		test('respects limit', async () => {
			const db = get_db();
			for (const username of ['alice1', 'alice2', 'alice3']) {
				const { actor } = await create_test_account_with_actor(db, { username });
				await set_actor_name(db, actor.id, username);
			}
			const rows = await query_actor_search({ db }, { query: 'ali', limit: 2 });
			assert.strictEqual(rows.length, 2);
		});

		test('orders deterministically by lowercased name then id', async () => {
			const db = get_db();
			const names = ['alpha-c', 'alpha-a', 'alpha-b'];
			for (const username of names) {
				const { actor } = await create_test_account_with_actor(db, { username });
				await set_actor_name(db, actor.id, username);
			}
			const rows = await query_actor_search({ db }, { query: 'alp', limit: 10 });
			const found = rows.map((r) => r.display_name);
			assert.deepStrictEqual(found, ['alpha-a', 'alpha-b', 'alpha-c']);
		});

		test('orders ties on display_name deterministically by id', async () => {
			const db = get_db();
			const { actor: a } = await create_test_account_with_actor(db, { username: 'tie_a' });
			await set_actor_name(db, a.id, 'samename');
			const { actor: b } = await create_test_account_with_actor(db, { username: 'tie_b' });
			await set_actor_name(db, b.id, 'samename');

			const rows = await query_actor_search({ db }, { query: 'samename', limit: 10 });
			assert.strictEqual(rows.length, 2);
			const actual = rows.map((r) => r.id);
			const expected = [a.id, b.id].sort();
			assert.deepStrictEqual(actual, expected);
		});
	});

	describe('wire shape', () => {
		test('row shape omits account_id', async () => {
			const db = get_db();
			const { actor } = await create_test_account_with_actor(db, { username: 'alice' });
			await set_actor_name(db, actor.id, 'Alice');
			const rows = await query_actor_search({ db }, { query: 'ali', limit: 10 });
			assert.ok(rows[0]);
			const keys = Object.keys(rows[0]).sort();
			assert.deepStrictEqual(keys, ['display_name', 'id', 'username']);
		});
	});
});
