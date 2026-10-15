/**
 * Shared scaffolding for the `cleanup.sessions.<aspect>.db.test.ts` sibling
 * suites — the four-leg `cleanup.sessions.db.test.ts` and the real-Postgres
 * `cleanup.sessions.refused_commit.db.test.ts`.
 *
 * `seed_accounts` / `seed_session` for the account and `auth_session` setup,
 * `remaining_sessions` to read what a sweep left, `create_deps` for the
 * sweep's deps over a closer, and `closed_sessions` to read a recording
 * closer's calls. Mirrors the `role_grant_offer_queries.fixtures.ts` pattern.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick
 * it up.
 *
 * @module
 */

import { assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import type { AuthCleanupDeps } from '#lib/auth/cleanup.ts';
import { hash_session_token, query_create_session } from '#lib/auth/session_queries.ts';
import type { ConnectionCloser } from '#lib/actions/connection_closer.ts';
import type { Db } from '#lib/db/db.ts';
import type { RecordedClose } from '#lib/testing/connection_closer_helpers.ts';

const log = new Logger('cleanup-sessions-test', { level: 'off' });
const hour_ms = 60 * 60 * 1000;

export interface TestAccounts {
	account_id: Uuid;
	other_account_id: Uuid;
}

export const seed_accounts = async (db: Db): Promise<TestAccounts> => {
	const { account } = await query_create_account_with_actor(
		{ db },
		{ username: 'sweep_account', password_hash: 'hash' }
	);
	const { account: other } = await query_create_account_with_actor(
		{ db },
		{ username: 'sweep_other', password_hash: 'hash' }
	);
	return { account_id: account.id, other_account_id: other.id };
};

/**
 * Seed one `auth_session` row — an expired one an hour past its `expires_at`,
 * a live one an hour short of it — and return its id (the token hash
 * connections are registered under).
 */
export const seed_session = async (
	db: Db,
	name: string,
	account_id: Uuid,
	expired: boolean
): Promise<string> => {
	const id = hash_session_token(name);
	await query_create_session(
		{ db },
		id,
		account_id,
		new Date(Date.now() + (expired ? -hour_ms : hour_ms))
	);
	return id;
};

/** The ids left in `auth_session`, sorted. */
export const remaining_sessions = async (db: Db): Promise<Array<string>> =>
	(await db.query<{ id: string }>('SELECT id FROM auth_session')).map((r) => r.id).sort();

/** Cleanup deps over `db` closing through `connection_closer`, with no audit listener. */
export const create_deps = (db: Db, connection_closer: ConnectionCloser): AuthCleanupDeps => ({
	db,
	log,
	audit: create_audit_emitter({ db, log }),
	connection_closer
});

/** The session ids a recording closer was asked to close, sorted — the delete returns ids in no order worth pinning. */
export const closed_sessions = (calls: Array<RecordedClose>): Array<string> => {
	const ids: Array<string> = [];
	for (const call of calls) {
		if (call.method !== 'session')
			assert.fail(`the sweep closes sessions only, got ${call.method}`);
		ids.push(call.id);
	}
	return ids.sort();
};
