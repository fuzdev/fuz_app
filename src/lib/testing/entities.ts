import './assert_dev_env.js';

/**
 * Shared test entity factories for `Account`, `Actor`, `Permit`, and `RequestContext`.
 *
 * Accepts `Partial<T>` overrides — callers set only what matters to their test.
 * Uses `create_test_*` names to avoid collisions with real `create_account_with_actor`
 * from `account_queries.ts`.
 *
 * @module
 */

import type {Account, Actor, Permit} from '../auth/account_schema.js';
import type {RequestContext} from '../auth/request_context.js';

/** Create a test `Account` with sensible defaults. */
export const create_test_account = (overrides?: Partial<Account>): Account => ({
	id: 'acct-test',
	username: 'test_user',
	email: null,
	email_verified: false,
	password_hash: 'hash',
	created_at: '2024-01-01T00:00:00Z',
	created_by: null,
	updated_at: '2024-01-01T00:00:00Z',
	updated_by: null,
	...overrides,
});

/** Create a test `Actor` with sensible defaults. */
export const create_test_actor = (overrides?: Partial<Actor>): Actor => ({
	id: 'actor-test',
	account_id: 'acct-test',
	name: 'test_user',
	created_at: '2024-01-01T00:00:00Z',
	updated_at: null,
	updated_by: null,
	...overrides,
});

/** Create a test `Permit` with sensible defaults. */
export const create_test_permit = (overrides?: Partial<Permit>): Permit => ({
	id: 'permit-test',
	actor_id: 'actor-test',
	role: 'admin',
	created_at: '2024-01-01T00:00:00Z',
	expires_at: null,
	revoked_at: null,
	revoked_by: null,
	granted_by: null,
	...overrides,
});

/** Create a test `RequestContext` with permits from partial overrides. */
export const create_test_context = (permits: Array<Partial<Permit>> = [{}]): RequestContext => ({
	account: create_test_account(),
	actor: create_test_actor(),
	permits: permits.map((p) => create_test_permit(p)),
});
