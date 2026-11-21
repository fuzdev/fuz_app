/**
 * Account and actor database queries.
 *
 * Provides CRUD operations for the account and actor tables.
 * For v1, every account has exactly one actor (1:1).
 *
 * @module
 */

import type { Uuid } from '../primitive_schemas.ts';

import type { QueryDeps } from '../db/query_deps.ts';
import { assert_row } from '../db/assert_row.ts';
import {
	columns_sql,
	iso8601_timestamp_column,
	iso8601_timestamp_expr,
	omit_columns
} from '../db/sql_columns.ts';
import {
	to_admin_account,
	type Account,
	type Actor,
	type CreateAccountInput,
	type AdminAccountEntryJson
} from './account_schema.ts';
import { ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT } from './admin_action_specs.ts';
import { ROLE_GRANT_COLUMNS } from './role_grant_queries.ts';
import { offer_pending_predicate, role_grant_active_sql } from './role_grant_sql.ts';

/**
 * The full `account` column set, named explicitly so a row read fails loud
 * on schema drift.
 *
 * `SELECT *` silently omits a dropped column, which the login lookups then
 * misread: `query_account_by_username_or_email` filters its result with
 * `account.deleted_at === null`, so a missing `deleted_at` column reads back
 * as `undefined`, `undefined === null` is `false`, and *every* login resolves
 * to "not found" (401) — a silent, total auth outage instead of an error.
 * Selecting named columns turns that drift into a hard Postgres
 * `column "..." does not exist`. Mirrors the Rust side
 * (`fuz_auth/src/account_queries.rs`), which selects named columns and
 * decodes them positionally. Keep in sync with `Account` and the `account`
 * DDL in `auth/auth_ddl.ts`.
 */
export const ACCOUNT_COLUMNS = [
	'id',
	'username',
	'email',
	'email_verified',
	'password_hash',
	'created_at',
	'created_by',
	'updated_at',
	'updated_by',
	'deleted_at',
	'deleted_by'
] as const satisfies ReadonlyArray<keyof Account>;

/**
 * The full `actor` column set — the same fail-loud discipline as
 * `ACCOUNT_COLUMNS` (this module owns both tables). Keep in sync with
 * `Actor` and the `actor` DDL in `auth/auth_ddl.ts`.
 */
export const ACTOR_COLUMNS = [
	'id',
	'account_id',
	'name',
	'created_at',
	'updated_at',
	'updated_by',
	'deleted_at',
	'deleted_by'
] as const satisfies ReadonlyArray<keyof Actor>;

/**
 * The timestamp override both tables this module owns share (`ACTOR_COLUMNS`
 * carries the same triple); every read here is on the bare table. Actor
 * timestamps never reach the wire (the summaries carry `{id, name}` only —
 * see `actor_lookup_action_specs.ts` on timing-oracle avoidance), but `Actor`
 * declares them as strings, so the projection makes the row honest there too.
 */
const account_actor_expr = iso8601_timestamp_expr(ACCOUNT_COLUMNS, [
	'created_at',
	'updated_at',
	'deleted_at'
])('');

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
	input: CreateAccountInput
): Promise<Account> => {
	const row = await deps.db.query_one<Account>(
		`INSERT INTO account (username, password_hash, email)
		 VALUES ($1, $2, $3)
		 RETURNING ${columns_sql(ACCOUNT_COLUMNS, account_actor_expr)}`,
		[input.username, input.password_hash, input.email ?? null]
	);
	return assert_row(row, 'INSERT INTO account');
};

/**
 * Find an **active** account by id (`deleted_at IS NULL`).
 *
 * This is the auth-resolution workhorse (`build_request_context` /
 * `build_account_context`) and the admin-target lookup, so it
 * deliberately excludes soft-deleted accounts: a tombstoned account must
 * not authenticate (`delete` = soft, `purge` = hard). Purge, which must operate on
 * soft-deleted rows too, uses `query_purge_account` directly.
 */
export const query_account_by_id = async (
	deps: QueryDeps,
	id: string
): Promise<Account | undefined> => {
	return deps.db.query_one<Account>(
		`SELECT ${columns_sql(ACCOUNT_COLUMNS, account_actor_expr)} FROM account WHERE id = $1 AND deleted_at IS NULL`,
		[id]
	);
};

/**
 * Find an account by username (case-insensitive).
 */
export const query_account_by_username = async (
	deps: QueryDeps,
	username: string
): Promise<Account | undefined> => {
	return deps.db.query_one<Account>(
		`SELECT ${columns_sql(ACCOUNT_COLUMNS, account_actor_expr)} FROM account WHERE LOWER(username) = LOWER($1)`,
		[username]
	);
};

/**
 * Find an account by email (case-insensitive).
 */
export const query_account_by_email = async (
	deps: QueryDeps,
	email: string
): Promise<Account | undefined> => {
	return deps.db.query_one<Account>(
		`SELECT ${columns_sql(ACCOUNT_COLUMNS, account_actor_expr)} FROM account WHERE LOWER(email) = LOWER($1)`,
		[email]
	);
};

/**
 * Find an account by username or email.
 *
 * If the input contains `@`, tries email lookup first then username.
 * Otherwise tries username first then email. This supports a single
 * login field that accepts either format.
 *
 * Excludes soft-deleted accounts (`deleted_at IS NULL`) — this is the
 * login lookup, and a tombstoned account must not authenticate. The
 * underlying `query_account_by_username` / `query_account_by_email` stay
 * unfiltered because the invite-collision checks need to see soft-deleted
 * accounts (usernames/emails stay reserved after a soft-delete).
 *
 * @param deps - query dependencies
 * @param input - username or email address
 * @returns the matching active account, or `undefined`
 */
export const query_account_by_username_or_email = async (
	deps: QueryDeps,
	input: string
): Promise<Account | undefined> => {
	const account = input.includes('@')
		? ((await query_account_by_email(deps, input)) ??
			(await query_account_by_username(deps, input)))
		: ((await query_account_by_username(deps, input)) ??
			(await query_account_by_email(deps, input)));
	// Login must not resolve a soft-deleted account, but the bare
	// username/email lookups stay unfiltered for invite-collision checks.
	return account && account.deleted_at === null ? account : undefined;
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
	expected_hash: string
): Promise<boolean> => {
	const rows = await deps.db.query<{ id: string }>(
		`UPDATE account SET password_hash = $1, updated_at = NOW(), updated_by = $2
		 WHERE id = $3 AND password_hash = $4
		 RETURNING id`,
		[password_hash, updated_by ?? null, id, expected_hash]
	);
	return rows.length > 0;
};

/**
 * Lock an account row for a credential mint, when the account is live and
 * still holds the password hash its authorization verified.
 *
 * A login verifies the password outside any transaction, so a password change
 * or an account delete can commit between the verify and the session insert —
 * and revoke "every session" before the new one exists. Run first in the
 * mint's transaction, this read waits on the row lock either writer holds and
 * then rereads the row as they committed it, so the mint is refused when the
 * hash changed or the tombstone landed; and once it holds the lock, either
 * writer waits for the mint to commit and then revokes what it minted. Both
 * writers write the account row before they revoke, which is what makes the
 * lock order them.
 *
 * `FOR NO KEY UPDATE`, the strength of their `UPDATE`s, so it also conflicts
 * with itself: the mints of one account take turns. The session cap needs
 * that. A mint inserts its session and evicts the oldest past the cap in one
 * transaction, and two mints running together each count without the other's
 * uncommitted row — both commit above the cap — while their evictions lock
 * the same old rows in orders the query plan picks, and can deadlock. Taken
 * in turn, the second mint runs its statements after the first commits and
 * counts its row. The foreign-key `FOR KEY SHARE` of a row inserted under the
 * account does not conflict with it, so no write that merely references the
 * account waits on a login. Besides the writers it orders against, it
 * conflicts with `query_account_lock_live` (the token mint, the same
 * strength), the `FOR SHARE` of `query_account_lock_live_many` (an offer or
 * invite create), and the last-admin guard's `FOR UPDATE`. None of those
 * waits on an account row while holding a session row, and once a mint holds
 * the lock it waits on nothing but the session rows its eviction deletes, so
 * no cycle runs through it. Twin of the Rust
 * `fuz_auth::query_account_lock_verified`.
 *
 * @param deps - query dependencies (must be the mint's transaction)
 * @param id - the account the credential is for
 * @param password_hash - the hash the password was verified against
 * @returns `true` when the row is locked and current, `false` when it was deleted, tombstoned, or its hash changed
 */
export const query_account_lock_verified = async (
	deps: QueryDeps,
	id: string,
	password_hash: string
): Promise<boolean> => {
	const row = await deps.db.query_one<{ id: string }>(
		`SELECT id FROM account
		 WHERE id = $1 AND deleted_at IS NULL AND password_hash = $2
		 FOR NO KEY UPDATE`,
		[id, password_hash]
	);
	return row !== undefined;
};

/**
 * Lock a live account row for a credential mint authorized by a credential
 * the account already holds (`account_token_create`).
 *
 * The request's credential was resolved outside the mint's transaction, so an
 * account delete can commit between that read and the insert, revoking every
 * token before the new one exists. Run first in the mint's transaction, this
 * read waits on the delete's row lock and then sees its tombstone; once it
 * holds the lock, a delete waits for the mint to commit and then revokes the
 * token. The password is not re-checked: the mint verified none. Taken
 * `FOR NO KEY UPDATE` for the token cap, as the login's lock is for the session
 * cap — `query_account_lock_verified` has why, and what it conflicts with; a
 * token mint and a login of one account take turns too. A write that only
 * needs ordering against a delete takes `query_account_lock_live_many`, which
 * lets such writes run together. Twin of the Rust
 * `fuz_auth::query_account_lock_live`.
 *
 * @param deps - query dependencies (must be the mint's transaction)
 * @param id - the account the credential is for
 * @returns `true` when the row is locked and not tombstoned, `false` when it was deleted or tombstoned
 */
export const query_account_lock_live = async (deps: QueryDeps, id: string): Promise<boolean> => {
	const row = await deps.db.query_one<{ id: string }>(
		`SELECT id FROM account WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
		[id]
	);
	return row !== undefined;
};

/**
 * Lock an account row for its purge, tombstoned or not.
 *
 * Every writer of an account takes the account row before its other rows — a
 * credential mint its lock, a password change or a delete its `UPDATE` — and a
 * purge takes it first as well, ahead of the credential rows its revokes and
 * its cascade delete. A purge reaching the row only at its `DELETE` would hold
 * the account's sessions and tokens while waiting on a writer that holds the
 * row and goes on to those same rows: a login evicting at the cap, a password
 * change or a delete revoking. `FOR UPDATE`, the lock the purge's `DELETE`
 * takes anyway: it conflicts with every other lock on the row, so a writer
 * holding one is waited out, and a writer arriving later waits for the purge
 * and then finds no row. No `deleted_at` filter — a purge removes a tombstoned
 * account too. Run after the last-admin guard, which takes an admin target's
 * account row among the others in id order
 * (`query_count_active_accounts_with_global_role_locked`), so the two never
 * take the rows in opposite orders. Twin of the Rust
 * `fuz_auth::account_queries::query_account_lock_for_purge`.
 *
 * @param deps - query dependencies (must be the purge's transaction)
 * @param id - the account to purge
 * @returns `true` when the row is locked, `false` when there is no such account
 */
export const query_account_lock_for_purge = async (
	deps: QueryDeps,
	id: string
): Promise<boolean> => {
	const row = await deps.db.query_one<{ id: string }>(
		`SELECT id FROM account WHERE id = $1 FOR UPDATE`,
		[id]
	);
	return row !== undefined;
};

/**
 * Lock live account rows in one statement, in id order, for a write that must
 * be ordered against a delete of any of them.
 *
 * An offer locks its two parties (`query_role_grant_offer_create`), an invite
 * its issuer (`invite_create`, one id).
 *
 * `FOR SHARE`: the weakest lock that conflicts with a delete's `UPDATE` of the
 * row, so these writes don't wait on one another. It also waits on a
 * credential mint's `FOR NO KEY UPDATE` (`query_account_lock_verified`), and a
 * mint waits on it — but a mint holding its lock waits on no row these writes
 * hold.
 *
 * The rows are locked as the sort returns them, so every caller takes them in
 * id order, as the last-admin guard
 * (`query_count_active_accounts_with_global_role_for_update`) takes its
 * account rows: two transactions locking two of the same accounts never wait
 * on each other in opposite orders. Taken one statement per account, an offer
 * between two admins could hold one party's row while the guard held the
 * other's, each waiting on the other. Ids never change, so the sort key a
 * concurrent update could move is not one of them. As with
 * `query_account_lock_live`, a delete committed before the read is waited for
 * and its tombstone seen; one after it waits for the caller's commit. Twin of
 * the Rust `fuz_auth::query_account_lock_live_many`.
 *
 * @param deps - query dependencies (must be the write's transaction)
 * @param ids - the accounts to lock
 * @returns the ids locked: those of the accounts neither deleted nor tombstoned
 */
export const query_account_lock_live_many = async (
	deps: QueryDeps,
	ids: ReadonlyArray<string>
): Promise<Set<string>> => {
	if (ids.length === 0) return new Set();
	const rows = await deps.db.query<{ id: string }>(
		`SELECT id FROM account WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY id FOR SHARE`,
		[ids]
	);
	return new Set(rows.map((row) => row.id));
};

/**
 * Identifying values snapshotted into a deletion/purge audit event so the
 * identity behind a now-orphaned `audit_log` id isn't lost. Mirrors the
 * Rust `AccountIdentitySnapshot`.
 */
export interface AccountIdentitySnapshot {
	username: string;
	email: string | null;
}

/**
 * Soft-delete an account — the reversible tombstone (`delete` = soft).
 *
 * Stamps `deleted_at` + `deleted_by` (the initiator's actor) on the active
 * row — paired like `role_grant`'s `revoked_at` / `revoked_by`, and
 * deliberately leaving `updated_at` / `updated_by` untouched (deletion
 * isn't a content edit). Returns the identity snapshot for the
 * `account_delete` audit event, or `undefined` when no active row matched
 * (missing or already soft-deleted). Auth resolution
 * (`query_account_by_id`) already excludes soft-deleted accounts; the
 * caller revokes sessions/tokens.
 *
 * @mutates `account` row - sets `deleted_at` + `deleted_by` on one active row
 */
export const query_account_soft_delete = async (
	deps: QueryDeps,
	id: string,
	deleted_by: string | null
): Promise<AccountIdentitySnapshot | undefined> => {
	return deps.db.query_one<AccountIdentitySnapshot>(
		`UPDATE account SET deleted_at = NOW(), deleted_by = $2
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING username, email`,
		[id, deleted_by]
	);
};

/**
 * Hard-purge an account — irreversible cascading removal (`purge` = hard).
 *
 * Physically deletes the row, cascading to actors, role_grants, sessions,
 * and tokens. Operates on active OR already-soft-deleted rows. Returns the
 * identity snapshot for the `account_purge` audit event, or `undefined`
 * when no row matched. The `audit_log` identity columns carry no FK, so
 * the purged id survives on historical rows for forensic correlation back
 * to the purge event.
 *
 * **Keeper-gated, loud, irreversible** — restrict to the keeper credential
 * and confirm explicitly at the call site. The `purge` name flags the danger.
 *
 * @mutates `account` table and downstream FK rows - DELETE cascades through actors/role_grants/sessions/tokens
 */
export const query_purge_account = async (
	deps: QueryDeps,
	id: string
): Promise<AccountIdentitySnapshot | undefined> => {
	return deps.db.query_one<AccountIdentitySnapshot>(
		`DELETE FROM account WHERE id = $1 RETURNING username, email`,
		[id]
	);
};

/**
 * Soft-delete one actor (sets `deleted_at` + `deleted_by`). Returns `true`
 * when an active row flipped, `false` when none matched. Emitted per actor
 * alongside the account-level soft-delete.
 *
 * @mutates `actor` row - sets `deleted_at` + `deleted_by` on one active row
 */
export const query_actor_soft_delete = async (
	deps: QueryDeps,
	id: string,
	deleted_by: string | null
): Promise<boolean> => {
	const row = await deps.db.query_one<{ id: string }>(
		`UPDATE actor SET deleted_at = NOW(), deleted_by = $2
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING id`,
		[id, deleted_by]
	);
	return row !== undefined;
};

/**
 * Reactivate a soft-deleted account — clears the `deleted_at` /
 * `deleted_by` tombstone (the inverse of `query_account_soft_delete`).
 *
 * Operates only on a currently soft-deleted row (`deleted_at IS NOT NULL`)
 * and returns the identity snapshot for the `account_undelete` audit
 * event, or `undefined` when no soft-deleted row matched (missing or
 * already active). Reactivation does **not** restore the revoked
 * sessions/tokens — the account is live again but its principals re-auth
 * fresh. `updated_at` / `updated_by` stay untouched.
 *
 * @mutates `account` row - clears `deleted_at` + `deleted_by` on one soft-deleted row
 */
export const query_account_undelete = async (
	deps: QueryDeps,
	id: string
): Promise<AccountIdentitySnapshot | undefined> => {
	return deps.db.query_one<AccountIdentitySnapshot>(
		`UPDATE account SET deleted_at = NULL, deleted_by = NULL
		 WHERE id = $1 AND deleted_at IS NOT NULL
		 RETURNING username, email`,
		[id]
	);
};

/**
 * Reactivate one soft-deleted actor (clears `deleted_at` / `deleted_by`).
 * Returns `true` when a soft-deleted row flipped back, `false` when none
 * matched. Emitted per actor alongside the account-level reactivation.
 *
 * @mutates `actor` row - clears `deleted_at` + `deleted_by` on one soft-deleted row
 */
export const query_actor_undelete = async (deps: QueryDeps, id: string): Promise<boolean> => {
	const row = await deps.db.query_one<{ id: string }>(
		`UPDATE actor SET deleted_at = NULL, deleted_by = NULL
		 WHERE id = $1 AND deleted_at IS NOT NULL
		 RETURNING id`,
		[id]
	);
	return row !== undefined;
};

/**
 * Check if any account exists.
 */
export const query_account_has_any = async (deps: QueryDeps): Promise<boolean> => {
	const row = await deps.db.query_one<{ exists: boolean }>(
		`SELECT EXISTS(SELECT 1 FROM account) AS exists`
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
	name: string
): Promise<Actor> => {
	const row = await deps.db.query_one<Actor>(
		`INSERT INTO actor (account_id, name) VALUES ($1, $2) RETURNING ${columns_sql(ACTOR_COLUMNS, account_actor_expr)}`,
		[account_id, name]
	);
	return assert_row(row, 'INSERT INTO actor');
};

/**
 * List every actor on an account, ordered by `created_at`, **including
 * soft-deleted (tombstoned) rows**.
 *
 * Used by the admin/snapshot handlers (`account_delete` / `account_purge` /
 * `account_undelete`) that must enumerate every actor that ever existed on
 * the account to snapshot names into per-actor audit events. For the
 * acting-actor resolution path — which must never resolve a tombstoned
 * actor — use `query_active_actors_by_account`. For lookups by id, use
 * `query_actor_by_id` instead.
 */
export const query_actors_by_account = async (
	deps: QueryDeps,
	account_id: string
): Promise<Array<Actor>> => {
	return deps.db.query<Actor>(
		`SELECT ${columns_sql(ACTOR_COLUMNS, account_actor_expr)} FROM actor WHERE account_id = $1 ORDER BY actor.created_at ASC, actor.id ASC`,
		[account_id]
	);
};

/**
 * List **active** (non-tombstoned) actors on an account, ordered by
 * `created_at`.
 *
 * Filters `deleted_at IS NULL` so a soft-deleted actor can never be resolved
 * as the acting actor (and carry its `role_grants` into the role gate). Used
 * by `resolve_acting_actor` to resolve the acting actor for a request: 1
 * actor picks transparently, multiple require an explicit `acting` field on
 * the request payload. The admin/snapshot handlers that legitimately need
 * tombstoned rows stay on the unfiltered `query_actors_by_account`.
 */
export const query_active_actors_by_account = async (
	deps: QueryDeps,
	account_id: string
): Promise<Array<Actor>> => {
	return deps.db.query<Actor>(
		`SELECT ${columns_sql(ACTOR_COLUMNS, account_actor_expr)} FROM actor WHERE account_id = $1 AND deleted_at IS NULL ORDER BY actor.created_at ASC, actor.id ASC`,
		[account_id]
	);
};

/**
 * Find an actor by id.
 */
export const query_actor_by_id = async (
	deps: QueryDeps,
	id: string
): Promise<Actor | undefined> => {
	return deps.db.query_one<Actor>(
		`SELECT ${columns_sql(ACTOR_COLUMNS, account_actor_expr)} FROM actor WHERE id = $1`,
		[id]
	);
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
	input: CreateAccountInput
): Promise<{ account: Account; actor: Actor }> => {
	const account = await query_create_account(deps, input);
	const actor = await query_create_actor(deps, account.id, input.username);
	return { account, actor };
};

/**
 * `ROLE_GRANT_COLUMNS` minus the revocation + provenance columns — the
 * active-grant summary the admin listing projects (`RoleGrantWithActorId`).
 */
const ADMIN_ROLE_GRANT_COLUMNS = omit_columns(
	ROLE_GRANT_COLUMNS,
	'revoked_at',
	'revoked_by',
	'revoked_reason',
	'source_offer_id'
);

/**
 * The admin listing's active-grant summary timestamps — twin of the spine's
 * `role_grant_summary_columns`. The read is on the bare `role_grant` table.
 */
const admin_role_grant_expr = iso8601_timestamp_expr(ADMIN_ROLE_GRANT_COLUMNS, [
	'created_at',
	'expires_at'
])('');

/** Row shape for the active role_grants batch query — `ADMIN_ROLE_GRANT_COLUMNS`. */
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
	/**
	 * Include soft-deleted (tombstoned) accounts. Defaults to `false` —
	 * the listing shows active accounts only, matching auth resolution.
	 * Set `true` for the admin UI's "show deleted" view, which offers
	 * reactivation via `account_undelete`.
	 */
	include_deleted?: boolean | null;
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
 * Every list is ordered as the Rust spine orders it, on data keys rather than
 * the random `id` alone: accounts by `created_at, username`, each entry's
 * role_grants by `created_at, role, scope_id`, its pending offers by
 * `expires_at, role, scope_id` (`id` last, for a tie no data key breaks). The
 * order is deterministic on each engine, so rows written in one transaction
 * (one `created_at`) list stably. Two backends holding the same rows list
 * them alike only under the same text collation: a bytewise compare (pglet)
 * and a locale one (Postgres `en_US.UTF-8`, which passes over `_` and `-` at
 * first) can order the text keys differently.
 *
 * @param deps - query dependencies
 * @param options - optional `{limit, offset}`. Default limit is
 *   `ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT`; pass `limit: null` to disable.
 * @returns admin account entries sorted by creation date (oldest first)
 */
export const query_admin_account_list = async (
	deps: QueryDeps,
	options?: AdminAccountListOptions
): Promise<Array<AdminAccountEntryJson>> => {
	const limit =
		options?.limit === null ? null : (options?.limit ?? ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT);
	const offset = options?.offset ?? 0;
	// Active-only by default; the admin UI's "show deleted" view passes
	// `include_deleted` to surface tombstoned rows for reactivation.
	const where = options?.include_deleted ? '' : 'WHERE deleted_at IS NULL';
	const account_query =
		limit == null
			? deps.db.query<Account>(
					`SELECT ${columns_sql(ACCOUNT_COLUMNS, account_actor_expr)} FROM account ${where} ORDER BY account.created_at, account.username OFFSET $1`,
					[offset]
				)
			: deps.db.query<Account>(
					`SELECT ${columns_sql(ACCOUNT_COLUMNS, account_actor_expr)} FROM account ${where} ORDER BY account.created_at, account.username LIMIT $1 OFFSET $2`,
					[limit, offset]
				);
	const accounts = await account_query;
	if (accounts.length === 0) return [];

	const account_ids = accounts.map((a) => a.id);

	const [actors, role_grants, pending_offers] = await Promise.all([
		deps.db.query<Actor>(
			`SELECT ${columns_sql(ACTOR_COLUMNS, account_actor_expr)} FROM actor WHERE account_id = ANY($1::uuid[]) ORDER BY actor.created_at, actor.name, actor.id`,
			[account_ids]
		),
		deps.db.query<RoleGrantWithActorId>(
			`SELECT ${columns_sql(ADMIN_ROLE_GRANT_COLUMNS, admin_role_grant_expr)}
			 FROM role_grant
			 WHERE actor_id IN (SELECT id FROM actor WHERE account_id = ANY($1::uuid[]))
			   AND ${role_grant_active_sql('')}
			 ORDER BY role_grant.created_at, role_grant.role, role_grant.scope_id, role_grant.id`,
			[account_ids]
		),
		deps.db.query<PendingOfferRow>(
			`SELECT po.id, po.to_account_id, po.from_actor_id, po.role, po.scope_kind, po.scope_id,
			        ${iso8601_timestamp_column('po', 'created_at')} AS created_at,
			        ${iso8601_timestamp_column('po', 'expires_at')} AS expires_at,
			        a.username AS from_username
			 FROM role_grant_offer po
			 JOIN actor act ON act.id = po.from_actor_id
			 JOIN account a ON a.id = act.account_id
			 WHERE po.to_account_id = ANY($1::uuid[])
			   AND ${offer_pending_predicate('po')}
			   AND po.expires_at > NOW()
			 ORDER BY po.expires_at ASC, po.role ASC, po.scope_id ASC, po.id ASC`,
			[account_ids]
		)
	]);

	// Index actors by account_id, the first one winning: actors arrive in
	// `created_at, name, id` order, so an account's row carries its oldest actor
	// (and that actor's grants). Multi-actor TODO: an account hosting more
	// than one actor shows only that one — when multi-actor lands, the admin
	// row shape must change from "account → one actor" to "account →
	// Array<Actor>" (or split into a separate per-actor row). The JSON shape
	// change will ripple into the admin UI; bundle that with the multi-actor
	// session-actor-selector work.
	const actor_by_account = new Map<Uuid, Actor>();
	for (const actor of actors) {
		if (!actor_by_account.has(actor.account_id)) actor_by_account.set(actor.account_id, actor);
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
			actor: actor ? { id: actor.id, name: actor.name } : null,
			role_grants: actor_role_grants.map((p) => ({
				id: p.id,
				role: p.role,
				scope_kind: p.scope_kind,
				scope_id: p.scope_id,
				created_at: p.created_at,
				expires_at: p.expires_at,
				granted_by: p.granted_by
			})),
			pending_offers: account_offers.map((o) => ({
				id: o.id,
				role: o.role,
				scope_kind: o.scope_kind,
				scope_id: o.scope_id,
				from_actor_id: o.from_actor_id,
				from_username: o.from_username,
				created_at: o.created_at,
				expires_at: o.expires_at
			}))
		};
	});
};
