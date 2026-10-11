/**
 * The session sweep in `auth/cleanup.ts` — `cleanup_expired_sessions` — with
 * its `COMMIT` refused.
 *
 * A deferred constraint trigger lets the sweep's delete succeed and refuses
 * the `COMMIT` statement itself. The sweep still closes the session it swept
 * — the session is expired either way — the delete rolls back, and the next
 * pass deletes the row and closes again, never the live session.
 *
 * Real Postgres only: the four-leg `cleanup.sessions.db.test.ts` drives the
 * same branch on every driver through `create_gated_db`'s `hold_commit`,
 * which can only stand in for a refused `COMMIT` — here Postgres refuses it
 * (and pglet has no triggers). Skipped when `TEST_DATABASE_URL` is unset.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { cleanup_expired_sessions } from '#lib/auth/cleanup.ts';
import { create_describe_db, auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_recording_closer } from '#lib/testing/connection_closer_helpers.ts';

import { pg_factory } from '../db_fixture.ts';
import {
	closed_sessions,
	create_deps,
	remaining_sessions,
	seed_accounts,
	seed_session
} from './cleanup.sessions.fixtures.ts';

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg('cleanup_expired_sessions with a refused COMMIT', (get_db) => {
	test('a sweep whose commit fails still closes, and the next pass retries', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired = await seed_session(db, 'sweep-expired', a.account_id, true);
		const live = await seed_session(db, 'sweep-live', a.account_id, false);
		const { closer, calls } = create_recording_closer();
		const deps = create_deps(db, closer);

		// deferred, so the DELETE succeeds and the COMMIT is what fails
		await db.query(
			`CREATE FUNCTION cleanup_test_refuse_commit() RETURNS trigger AS $$
			   BEGIN RAISE EXCEPTION 'synthetic commit failure'; END;
			 $$ LANGUAGE plpgsql`
		);
		try {
			await db.query(
				`CREATE CONSTRAINT TRIGGER cleanup_test_refuse_commit
				   AFTER DELETE ON auth_session DEFERRABLE INITIALLY DEFERRED
				   FOR EACH ROW EXECUTE FUNCTION cleanup_test_refuse_commit()`
			);
			await assert_rejects(() => cleanup_expired_sessions(deps), /synthetic commit failure/);
		} finally {
			// the database outlives this file — leave no trigger behind
			await db.query('DROP TRIGGER IF EXISTS cleanup_test_refuse_commit ON auth_session');
			await db.query('DROP FUNCTION cleanup_test_refuse_commit()');
		}

		assert.deepEqual(
			closed_sessions(calls),
			[expired],
			'the swept session is closed although its commit failed'
		);
		assert.deepEqual(
			await remaining_sessions(db),
			[expired, live].sort(),
			'the failed commit rolled the delete back'
		);

		assert.strictEqual(await cleanup_expired_sessions(deps), 1);
		assert.deepEqual(await remaining_sessions(db), [live]);
		assert.deepEqual(
			closed_sessions(calls),
			[expired, expired],
			'the next pass deletes the row and closes again, never the live session'
		);
	});
});
