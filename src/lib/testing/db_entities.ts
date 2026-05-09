import './assert_dev_env.js';

/**
 * DB-backed entity factories for tests that need real `account` + `actor`
 * rows in the database.
 *
 * Companion to `entities.ts` — that file ships in-memory factories
 * (`create_test_account`, `create_test_actor`) for tests that mock the
 * DB; this file ships factories that hit a real `Db` so query-level
 * tests don't reimplement the same `query_create_account_with_actor`
 * wrapper in every file.
 *
 * For full-fledged test accounts that also need an API token + signed
 * session cookie + role_grants, use `bootstrap_test_account` from
 * `app_server.ts` instead.
 *
 * @module
 */

import {query_create_account_with_actor} from '../auth/account_queries.js';
import type {Account, Actor} from '../auth/account_schema.js';
import type {Db} from '../db/db.js';

/** The `{account, actor}` row pair returned by `create_test_account_with_actor`. */
export interface TestAccountWithActor {
	account: Account;
	actor: Actor;
}

/**
 * Create an `account` + `actor` row pair in the database for tests.
 *
 * Wraps `query_create_account_with_actor` with a default `password_hash`
 * so suites that don't exercise password verification can stay terse.
 * Replaces the per-file `create_user` / `create_test_actor` /
 * `create_test_account` helpers that had accumulated across the auth
 * test suite.
 */
export const create_test_account_with_actor = async (
	db: Db,
	options: {username: string; password_hash?: string},
): Promise<TestAccountWithActor> =>
	query_create_account_with_actor(
		{db},
		{username: options.username, password_hash: options.password_hash ?? 'hash'},
	);
