/**
 * Proves the `ORDER BY` rule the `iso8601_timestamp_column` projection
 * imposes: a projected read aliases its `to_char(…)` back to the column name
 * (`… AS created_at`), and Postgres resolves a **bare** `ORDER BY created_at`
 * against that output name — sorting the formatted text, which is truncated
 * to the second. Rows written inside one second would tie in insertion
 * order, and the btree index would drop out of the plan.
 *
 * Every projected read therefore qualifies its sort key
 * (`ORDER BY auth_session.created_at DESC`). This file pins that: three
 * sessions stamped `.100` / `.900` / `.500` inside one second must come back
 * newest-first, which only holds while the sort key is the input column.
 *
 * Companion to ./sql_columns.test.ts, which pins the rendered SQL.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { query_create_account } from '$lib/auth/account_queries.ts';
import { query_session_list_for_account } from '$lib/auth/session_queries.ts';
import { ISO8601_SECONDS } from '$lib/timestamp.ts';

import { describe_db } from '../db_fixture.ts';

/** Three stamps inside one second, deliberately out of insertion order. */
const STAMPS = [
	{ id: 'session_a', created_at: '2024-01-01T00:00:00.100Z' },
	{ id: 'session_b', created_at: '2024-01-01T00:00:00.900Z' },
	{ id: 'session_c', created_at: '2024-01-01T00:00:00.500Z' }
] as const;

describe_db('projected ORDER BY', (get_db) => {
	test('sorts on the input column, not the truncated projection', async () => {
		const db = get_db();
		const deps = { db };
		const account = await query_create_account(deps, {
			username: 'ordering_user',
			password_hash: 'x'
		});
		for (const { id, created_at } of STAMPS) {
			await db.query(
				`INSERT INTO auth_session (id, account_id, created_at, expires_at)
				 VALUES ($1, $2, $3, $4)`,
				[id, account.id, created_at, '2099-01-01T00:00:00Z']
			);
		}

		const sessions = await query_session_list_for_account(deps, account.id);

		// Newest first by the raw instant: .900, .500, .100. A bare
		// `ORDER BY created_at` sorts the formatted text — all three render
		// `2024-01-01T00:00:00Z` — and returns them in scan order instead.
		assert.deepEqual(
			sessions.map((s) => s.id),
			['session_b', 'session_c', 'session_a']
		);
		// The rows still carry the truncated wire shape — the fix moves the
		// sort key, not the projection.
		for (const session of sessions) {
			assert.match(session.created_at, ISO8601_SECONDS);
			assert.strictEqual(session.created_at, '2024-01-01T00:00:00Z');
		}
	});
});
