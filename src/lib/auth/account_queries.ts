/**
 * Account and actor database queries.
 *
 * Provides CRUD operations for the account and actor tables.
 * For v1, every account has exactly one actor (1:1).
 *
 * @module
 */

import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {QueryDeps} from '../db/query_deps.js';
import {assert_row} from '../db/assert_row.js';
import {
	to_admin_account,
	type Account,
	type Actor,
	type CreateAccountInput,
	type AdminAccountEntryJson,
} from './account_schema.js';
import {ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT} from './admin_action_specs.js';

/**
 * Create a new account.
 *
 * @param deps - query dependencies
 * @param input - the account fields
 * @returns the created account
 * @mutates `account` table - inserts the new row
 */
export const query_create_account = async (
	deps: QueryDeps,
	input: CreateAccountInput,
): Promise<Account> => {
	const row = await deps.db.query_one<Account>(
		`INSERT INTO account (username, password_hash, email)
		 VALUES ($1, $2, $3)
		 RETURNING *`,
		[input.username, input.password_hash, input.email ?? null],
	);
	return assert_row(row, 'INSERT INTO account');
};

/**
 * Find an account by id.
 */
export const query_account_by_id = async (
	deps: QueryDeps,
	id: string,
): Promise<Account | undefined> => {
	return deps.db.query_one<Account>(`SELECT * FROM account WHERE id = $1`, [id]);
};

/**
 * Find an account by username (case-insensitive).
 */
export const query_account_by_username = async (
	deps: QueryDeps,
	username: string,
): Promise<Account | undefined> => {
	return deps.db.query_one<Account>(`SELECT * FROM account WHERE LOWER(username) = LOWER($1)`, [
		username,
	]);
};

/**
 * Find an account by email (case-insensitive).
 */
export const query_account_by_email = async (
	deps: QueryDeps,
	email: string,
): Promise<Account | undefined> => {
	return deps.db.query_one<Account>(`SELECT * FROM account WHERE LOWER(email) = LOWER($1)`, [
		email,
	]);
};

/**
 * Find an account by username or email.
 *
 * If the input contains `@`, tries email lookup first then username.
 * Otherwise tries username first then email. This supports a single
 * login field that accepts either format.
 *
 * @param deps - query dependencies
 * @param input - username or email address
 * @returns the matching account, or `undefined`
 */
export const query_account_by_username_or_email = async (
	deps: QueryDeps,
	input: string,
): Promise<Account | undefined> => {
	if (input.includes('@')) {
		return (
			(await query_account_by_email(deps, input)) ?? (await query_account_by_username(deps, input))
		);
	}
	return (
		(await query_account_by_username(deps, input)) ?? (await query_account_by_email(deps, input))
	);
};

/**
 * Update the password hash for an account, conditional on the current
 * stored hash matching `expected_hash` — the verify-write atomic guard.
 *
 * The condition closes the race where two concurrent password changes both
 * verify against the pre-update hash (loaded by the authorization phase
 * outside the route's transaction) and would otherwise both UPDATE,
 * silently clobbering whichever lands first. With the conditional WHERE,
 * the second UPDATE matches zero rows; the route reads the boolean
 * return and surfaces 401 instead of pretending success.
 *
 * Pass the same hash the verify ran against — typically
 * `ctx.account.password_hash` from the request context.
 *
 * @returns `true` if the row was updated, `false` if `expected_hash` no
 *   longer matched (concurrent change won — caller should treat as a
 *   stale-credential failure).
 * @mutates `account` row - updates `password_hash`, `updated_at`, and
 *   `updated_by` only when the stored hash equals `expected_hash`
 */
export const query_update_account_password = async (
	deps: QueryDeps,
	id: string,
	password_hash: string,
	updated_by: string | null,
	expected_hash: string,
): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(
		`UPDATE account SET password_hash = $1, updated_at = NOW(), updated_by = $2
		 WHERE id = $3 AND password_hash = $4
		 RETURNING id`,
		[password_hash, updated_by ?? null, id, expected_hash],
	);
	return rows.length > 0;
};

/**
 * Delete an account. Cascades to actors, role_grants, sessions, and tokens.
 *
 * @mutates `account` table and downstream FK rows - DELETE cascades through actors/role_grants/sessions/tokens
 */
export const query_delete_account = async (deps: QueryDeps, id: string): Promise<boolean> => {
	const rows = await deps.db.query<{id: string}>(`DELETE FROM account WHERE id = $1 RETURNING id`, [
		id,
	]);
	return rows.length > 0;
};

/**
 * Check if any account exists.
 */
export const query_account_has_any = async (deps: QueryDeps): Promise<boolean> => {
	const row = await deps.db.query_one<{exists: boolean}>(
		`SELECT EXISTS(SELECT 1 FROM account) AS exists`,
	);
	return row?.exists ?? false;
};

/**
 * Create a new actor for an account.
 *
 * @param deps - query dependencies
 * @param account_id - the owning account
 * @param name - display name (defaults to account username)
 * @returns the created actor
 * @mutates `actor` table - inserts the new row
 */
export const query_create_actor = async (
	deps: QueryDeps,
	account_id: string,
	name: string,
): Promise<Actor> => {
	const row = await deps.db.query_one<Actor>(
		`INSERT INTO actor (account_id, name) VALUES ($1, $2) RETURNING *`,
		[account_id, name],
	);
	return assert_row(row, 'INSERT INTO actor');
};

/**
 * List every actor on an account, ordered by `created_at`.
 *
 * Used by `resolve_acting_actor` to resolve the acting actor for a
 * request: 1 actor picks transparently, multiple require an explicit
 * `acting` field on the request payload. For lookups by id, use
 * `query_actor_by_id` instead.
 */
export const query_actors_by_account = async (
	deps: QueryDeps,
	account_id: string,
): Promise<Array<Actor>> => {
	return deps.db.query<Actor>(
		`SELECT * FROM actor WHERE account_id = $1 ORDER BY created_at ASC, id ASC`,
		[account_id],
	);
};

/**
 * Find an actor by id.
 */
export const query_actor_by_id = async (
	deps: QueryDeps,
	id: string,
): Promise<Actor | undefined> => {
	return deps.db.query_one<Actor>(`SELECT * FROM actor WHERE id = $1`, [id]);
};

/**
 * Create an account and its actor in a single operation.
 *
 * For v1, every account gets exactly one actor with the same name as the username.
 *
 * @param deps - query dependencies
 * @param input - the account fields
 * @returns the created account and actor
 * @mutates `account` and `actor` tables - inserts one row in each
 */
export const query_create_account_with_actor = async (
	deps: QueryDeps,
	input: CreateAccountInput,
): Promise<{account: Account; actor: Actor}> => {
	const account = await query_create_account(deps, input);
	const actor = await query_create_actor(deps, account.id, input.username);
	return {account, actor};
};

/** Row shape for the active role_grants batch query. */
interface RoleGrantWithActorId {
	id: Uuid;
	actor_id: Uuid;
	role: string;
	scope_kind: string | null;
	scope_id: Uuid | null;
	created_at: string;
	expires_at: string | null;
	granted_by: Uuid | null;
}

/** Row shape for the pending offers batch query. */
interface PendingOfferRow {
	id: Uuid;
	to_account_id: Uuid;
	from_actor_id: Uuid;
	from_username: string;
	role: string;
	scope_kind: string | null;
	scope_id: Uuid | null;
	created_at: string;
	expires_at: string;
}

/** Options for `query_admin_account_list`. */
export interface AdminAccountListOptions {
	/**
	 * Max accounts to return. Defaults to `ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT`
	 * when omitted; pass `null` explicitly to disable the limit (unbounded
	 * fetch — for trusted internal callers / scripts; the RPC schema bounds
	 * wire callers to `[1, ADMIN_ACCOUNT_LIST_LIMIT_MAX]`).
	 */
	limit?: number | null;
	/** Pagination offset. Defaults to 0. */
	offset?: number | null;
}

/**
 * List accounts with their actors, active role_grants, and pending inbound
 * role_grant offers for admin display.
 *
 * Pages the accounts query (one round-trip), then fans out three parallel
 * lookups scoped to the page's `account_ids` (one round-trip). The role_grants
 * and offers queries use a subquery on `actor.account_id` so the page bound
 * pushes through to the DB without round-tripping `actor.id`s back to the
 * application. Pending offers surface the "offer pending — awaiting
 * acceptance" UX; `message` is intentionally excluded (cross-admin
 * visibility of grantor notes would expand beyond what the audit log
 * discloses).
 *
 * @param deps - query dependencies
 * @param options - optional `{limit, offset}`. Default limit is
 *   `ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT`; pass `limit: null` to disable.
 * @returns admin account entries sorted by creation date (oldest first)
 */
export const query_admin_account_list = async (
	deps: QueryDeps,
	options?: AdminAccountListOptions,
): Promise<Array<AdminAccountEntryJson>> => {
	const limit =
		options?.limit === null ? null : (options?.limit ?? ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT);
	const offset = options?.offset ?? 0;
	const account_query =
		limit == null
			? deps.db.query<Account>(`SELECT * FROM account ORDER BY created_at OFFSET $1`, [offset])
			: deps.db.query<Account>(`SELECT * FROM account ORDER BY created_at LIMIT $1 OFFSET $2`, [
					limit,
					offset,
				]);
	const accounts = await account_query;
	if (accounts.length === 0) return [];

	const account_ids = accounts.map((a) => a.id);

	const [actors, role_grants, pending_offers] = await Promise.all([
		deps.db.query<Actor>(`SELECT * FROM actor WHERE account_id = ANY($1::uuid[])`, [account_ids]),
		deps.db.query<RoleGrantWithActorId>(
			`SELECT id, actor_id, role, scope_kind, scope_id, created_at, expires_at, granted_by
			 FROM role_grant
			 WHERE actor_id IN (SELECT id FROM actor WHERE account_id = ANY($1::uuid[]))
			   AND revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at > NOW())`,
			[account_ids],
		),
		deps.db.query<PendingOfferRow>(
			`SELECT po.id, po.to_account_id, po.from_actor_id, po.role, po.scope_kind, po.scope_id,
			        po.created_at, po.expires_at, a.username AS from_username
			 FROM role_grant_offer po
			 JOIN actor act ON act.id = po.from_actor_id
			 JOIN account a ON a.id = act.account_id
			 WHERE po.to_account_id = ANY($1::uuid[])
			   AND po.accepted_at IS NULL
			   AND po.declined_at IS NULL
			   AND po.retracted_at IS NULL
			   AND po.superseded_at IS NULL
			   AND po.expires_at > NOW()
			 ORDER BY po.expires_at ASC`,
			[account_ids],
		),
	]);

	// Index actors by account_id. Multi-actor TODO: this Map keyed by
	// account_id silently overwrites earlier actors when an account
	// hosts more than one — when multi-actor lands, the admin row shape
	// must change from "account → one actor" to "account → Array<Actor>"
	// (or split into a separate per-actor row). The JSON shape change
	// will ripple into the admin UI; bundle that with the multi-actor
	// session-actor-selector work.
	const actor_by_account = new Map<Uuid, Actor>();
	for (const actor of actors) {
		actor_by_account.set(actor.account_id, actor);
	}

	// Group role_grants by actor_id
	const role_grants_by_actor = new Map<Uuid, Array<RoleGrantWithActorId>>();
	for (const role_grant of role_grants) {
		let list = role_grants_by_actor.get(role_grant.actor_id);
		if (!list) {
			list = [];
			role_grants_by_actor.set(role_grant.actor_id, list);
		}
		list.push(role_grant);
	}

	// Group pending offers by recipient account_id
	const offers_by_account = new Map<Uuid, Array<PendingOfferRow>>();
	for (const offer of pending_offers) {
		let list = offers_by_account.get(offer.to_account_id);
		if (!list) {
			list = [];
			offers_by_account.set(offer.to_account_id, list);
		}
		list.push(offer);
	}

	return accounts.map((account): AdminAccountEntryJson => {
		const actor = actor_by_account.get(account.id);
		const actor_role_grants = actor ? (role_grants_by_actor.get(actor.id) ?? []) : [];
		const account_offers = offers_by_account.get(account.id) ?? [];
		return {
			account: to_admin_account(account),
			actor: actor ? {id: actor.id, name: actor.name} : null,
			role_grants: actor_role_grants.map((p) => ({
				id: p.id,
				role: p.role,
				scope_kind: p.scope_kind,
				scope_id: p.scope_id,
				created_at: p.created_at,
				expires_at: p.expires_at,
				granted_by: p.granted_by,
			})),
			pending_offers: account_offers.map((o) => ({
				id: o.id,
				role: o.role,
				scope_kind: o.scope_kind,
				scope_id: o.scope_id,
				from_actor_id: o.from_actor_id,
				from_username: o.from_username,
				created_at: o.created_at,
				expires_at: o.expires_at,
			})),
		};
	});
};
