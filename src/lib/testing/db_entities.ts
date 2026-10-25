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
	query_actor_by_id,
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
 * Its `created_at` is read from the wall clock (`clock_timestamp()`) rather
 * than the transaction-fixed `NOW()` default the production
 * `query_create_actor` relies on. Actors listed for an account sort by
 * `created_at ASC, id ASC`, so an extra actor seeded in the transaction that
 * created the account's first one would share its `created_at` and order by
 * random id, and the multi-actor `actor_required` `available` list would come
 * out in a random order. Seeded through here, the first actor sorts first and
 * the extras in insert order. The bootstrap-cradle seeding of `extra_actors`
 * uses it — the `_testing_reset` action and the in-process setup — as the Rust
 * reset seeds them with `query_create_actor_with_clock_timestamp`.
 *
 * @param db - the database, or the transaction the account was seeded in
 * @param account_id - the account the actor joins
 * @param name - the actor's name
 * @returns the created actor
 * @mutates `actor` table - inserts the new row
 */
export const create_test_extra_actor = async (
	db: Db,
	account_id: string,
	name: string
): Promise<Actor> => {
	// two steps: the actor projection's timestamp expression is private to
	// `account_queries.ts`, so the row is read back through `query_actor_by_id`
	const inserted = await db.query_one<{ id: string }>(
		`INSERT INTO actor (account_id, name, created_at) VALUES ($1, $2, clock_timestamp()) RETURNING id`,
		[account_id, name]
	);
	if (!inserted) throw new Error('create_test_extra_actor: INSERT returned no row');
	const actor = await query_actor_by_id({ db }, inserted.id);
	if (!actor) throw new Error('create_test_extra_actor: inserted actor not found');
	return actor;
};

/**
 * Soft-delete (tombstone) one actor via the production `query_actor_soft_delete`
 * — returns `true` when an active row flipped. The TS twin of the Rust
 * `query_actor_soft_delete` the guard tests use, for seeding the latent
 * multi-actor tombstone state directly (no per-actor-delete RPC ships yet).
 */
export const soft_delete_test_actor = async (db: Db, actor_id: string): Promise<boolean> =>
	query_actor_soft_delete({ db }, actor_id, null);
