import './assert_dev_env.ts';

/**
 * DB-backed entity factories for tests that need real `account` + `actor`
 * rows in the database.
 *
 * Companion to `testing/entities.ts` — that file ships in-memory factories
 * (`create_test_account`, `create_test_actor`) for tests that mock the
 * DB; this file ships factories that hit a real `Db` so query-level
 * tests don't reimplement the same `query_create_account_with_actor`
 * wrapper in every file.
 *
 * For full-fledged test accounts that also need an API token + signed
 * session cookie + role_grants, use `bootstrap_test_keeper` (keeper) or
 * `create_test_account_with_credentials` (additional accounts) from
 * `testing/app_server.ts` instead.
 *
 * @module
 */

import {
	query_create_account_with_actor,
	query_create_actor,
	query_actor_soft_delete
} from '../auth/account_queries.ts';
import { query_create_role_grant } from '../auth/role_grant_queries.ts';
import type { Account, Actor, CreateRoleGrantInput, RoleGrant } from '../auth/account_schema.ts';
import type { Db } from '../db/db.ts';

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
	options: { username: string; password_hash?: string }
): Promise<TestAccountWithActor> =>
	query_create_account_with_actor(
		{ db },
		{ username: options.username, password_hash: options.password_hash ?? 'hash' }
	);

/**
 * Materialize a `role_grant` directly via `query_create_role_grant`,
 * bypassing the production offer/accept consent flow.
 *
 * **In-process only.** This helper takes a raw `Db` handle and seeds
 * rows without firing audit fan-out, WebSocket broadcasts, or the
 * `_supersede` notification chain a real grant emits. Cross-process
 * suites must instead drive `role_grant_offer_create_action_spec` +
 * `role_grant_offer_accept_action_spec` via
 * `testing/role_grant_helpers.ts`'s `role_grant_offer_and_accept` so the
 * fixture observes the full post-commit fan-out the way production
 * does — otherwise tests would mask real divergence between the TS
 * and Rust spines.
 *
 * Use this helper for query-level (`*.db.test.ts`) tests that
 * exercise revoke or isolation semantics — not the consent path
 * itself. The schema's `source_offer_id = null` shape is an
 * intentional admin-direct escape; this helper exposes it so
 * suites don't reimplement the same direct-seed wrapper.
 */
export const create_test_role_grant_direct = async (
	db: Db,
	input: CreateRoleGrantInput
): Promise<RoleGrant> => query_create_role_grant({ db }, input);

/**
 * Add a second `actor` to an existing test account — the multi-actor edge.
 *
 * Wraps the production `query_create_actor`; the TS twin of the Rust
 * `tests/common` `seed_extra_actor` helper. Lets a `.db.test.ts` suite build a
 * multi-actor account without reimplementing the raw insert.
 */
export const create_test_extra_actor = async (
	db: Db,
	account_id: string,
	name: string
): Promise<Actor> => query_create_actor({ db }, account_id, name);

/**
 * Soft-delete (tombstone) one actor via the production `query_actor_soft_delete`
 * — returns `true` when an active row flipped. The TS twin of the Rust
 * `query_actor_soft_delete` the guard tests use, for seeding the latent
 * multi-actor tombstone state directly (no per-actor-delete RPC ships yet).
 */
export const soft_delete_test_actor = async (db: Db, actor_id: string): Promise<boolean> =>
	query_actor_soft_delete({ db }, actor_id, null);
