/**
 * Shared scaffolding for the `role_grant_offer_queries.<aspect>.db.test.ts`
 * sibling suites.
 *
 * Lifts the per-test-file boilerplate out of the per-aspect files:
 * `make_account` / `future` / `hour` / `TestAccount` for the account
 * setup boilerplate, plus `create_pending_offer` for the
 * default-pending-offer shape used by `supersede` and `concurrent`.
 * Mirrors the `role_grant_offer.multi_actor.fixtures.ts` pattern on the
 * actions side.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick
 * it up.
 *
 * @module
 */

import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
import {query_role_grant_offer_create} from '$lib/auth/role_grant_offer_queries.js';
import type {RoleGrantOffer} from '$lib/auth/role_grant_offer_schema.js';
import type {Db} from '$lib/db/db.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

export interface TestAccount {
	account_id: Uuid;
	actor_id: Uuid;
}

export const make_account = async (db: Db, username: string): Promise<TestAccount> => {
	const deps = {db};
	const {account, actor} = await query_create_account_with_actor(deps, {
		username,
		password_hash: 'hash',
	});
	return {account_id: account.id, actor_id: actor.id};
};

export const future = (ms_from_now: number): Date => new Date(Date.now() + ms_from_now);
export const hour = 60 * 60 * 1000;

export interface CreatePendingOfferOptions {
	role?: string;
	/**
	 * Paired-null with `scope_id`. When `scope_id` is set, defaults to
	 * `'test'` (a registered scope-kind name in the test consumer registry)
	 * so callers don't need to pass both fields. When `scope_id` is null,
	 * `scope_kind` is forced to null to satisfy the
	 * `role_grant_offer_scope_kind_paired` CHECK.
	 */
	scope_kind?: string | null;
	scope_id?: Uuid | null;
	message?: string | null;
	expires_at?: Date;
}

/**
 * Resolve the paired-null `(scope_kind, scope_id)` shape from helper
 * options. `scope_id IS NULL ⇔ scope_kind IS NULL`; when `scope_id` is
 * set without an explicit kind, the test-only `'test'` placeholder is
 * used. Centralizes the convention so every helper enforces the CHECK
 * constraint at the test surface.
 */
const resolve_scope_pair = (
	scope_kind: string | null | undefined,
	scope_id: Uuid | null | undefined,
): {scope_kind: string | null; scope_id: Uuid | null} => {
	if (scope_id == null) return {scope_kind: null, scope_id: null};
	return {scope_kind: scope_kind ?? 'test', scope_id};
};

/** Test helper — create a pending offer with sensible defaults. */
export const create_pending_offer = (
	db: Db,
	grantor: TestAccount,
	recipient: TestAccount,
	options: CreatePendingOfferOptions = {},
): Promise<RoleGrantOffer> => {
	const pair = resolve_scope_pair(options.scope_kind, options.scope_id);
	return query_role_grant_offer_create(
		{db},
		{
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: options.role ?? 'teacher',
			scope_kind: pair.scope_kind,
			scope_id: pair.scope_id,
			message: options.message ?? null,
			expires_at: options.expires_at ?? future(hour),
		},
	);
};

export interface InsertSupersededOfferOptions {
	role?: string;
	scope_kind?: string | null;
	scope_id?: Uuid | null;
	/** Defaults to `future(hour)` — set to a past Date to also expire the row. */
	expires_at?: Date;
	/** When the offer was superseded — defaults to "1 minute ago". */
	superseded_at?: Date;
}

/**
 * Test helper — raw INSERT a superseded `role_grant_offer` row.
 *
 * No public API sets `superseded_at` directly (callers go through accept or
 * role_grant revoke). Tests for the list/find_pending/sweep predicates need
 * already-superseded rows in isolation, so this helper is the documented
 * raw-SQL escape hatch.
 *
 * @returns the inserted row's id
 */
export const insert_superseded_offer = async (
	db: Db,
	grantor: TestAccount,
	recipient: TestAccount,
	options: InsertSupersededOfferOptions = {},
): Promise<Uuid> => {
	const expires_at = options.expires_at ?? future(hour);
	const superseded_at = options.superseded_at ?? new Date(Date.now() - 60_000);
	const pair = resolve_scope_pair(options.scope_kind, options.scope_id);
	const rows = await db.query<{id: Uuid}>(
		`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, scope_kind, scope_id, expires_at, superseded_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		[
			grantor.actor_id,
			recipient.account_id,
			options.role ?? 'classroom_student',
			pair.scope_kind,
			pair.scope_id,
			expires_at.toISOString(),
			superseded_at.toISOString(),
		],
	);
	return rows[0]!.id;
};
