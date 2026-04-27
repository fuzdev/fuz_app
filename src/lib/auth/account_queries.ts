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

/**
 * Create a new account.
 *
 * @param deps - query dependencies
 * @param input - the account fields
 * @returns the created account
 * @mutates `account` table - inserts the new row
 * @throws Error if the INSERT does not return a row (failed `assert_row` invariant)
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
 * Update the password hash for an account.
 *
 * @mutates `account` row - updates `password_hash`, `updated_at`, and `updated_by`
 */
export const query_update_account_password = async (
	deps: QueryDeps,
	id: string,
	password_hash: string,
	updated_by: string | null,
): Promise<void> => {
	await deps.db.query(
		`UPDATE account SET password_hash = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3`,
		[password_hash, updated_by ?? null, id],
	);
};

/**
 * Delete an account. Cascades to actors, permits, sessions, and tokens.
 *
 * @mutates `account` table and downstream FK rows - DELETE cascades through actors/permits/sessions/tokens
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
 * @throws Error if the INSERT does not return a row (failed `assert_row` invariant)
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
 * Find the actor for an account.
 *
 * For v1, each account has exactly one actor.
 */
export const query_actor_by_account = async (
	deps: QueryDeps,
	account_id: string,
): Promise<Actor | undefined> => {
	return deps.db.query_one<Actor>(`SELECT * FROM actor WHERE account_id = $1`, [account_id]);
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
 * @throws Error if either INSERT does not return a row
 */
export const query_create_account_with_actor = async (
	deps: QueryDeps,
	input: CreateAccountInput,
): Promise<{account: Account; actor: Actor}> => {
	const account = await query_create_account(deps, input);
	const actor = await query_create_actor(deps, account.id, input.username);
	return {account, actor};
};

/** Row shape for the active permits batch query. */
interface PermitWithActorId {
	id: Uuid;
	actor_id: Uuid;
	role: string;
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
	scope_id: Uuid | null;
	created_at: string;
	expires_at: string;
}

/**
 * List all accounts with their actors, active permits, and pending inbound
 * permit offers for admin display.
 *
 * Uses 4 flat queries instead of N+1 per-account loops. Pending offers surface
 * the "offer pending — awaiting acceptance" UX without a second round-trip;
 * `message` is intentionally excluded (cross-admin visibility of grantor notes
 * would expand beyond what the audit log discloses).
 *
 * @param deps - query dependencies
 * @returns admin account entries sorted by creation date
 */
export const query_admin_account_list = async (
	deps: QueryDeps,
): Promise<Array<AdminAccountEntryJson>> => {
	const [accounts, actors, permits, pending_offers] = await Promise.all([
		deps.db.query<Account>(`SELECT * FROM account ORDER BY created_at`),
		deps.db.query<Actor>(`SELECT * FROM actor`),
		deps.db.query<PermitWithActorId>(
			`SELECT id, actor_id, role, scope_id, created_at, expires_at, granted_by
			 FROM permit
			 WHERE revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at > NOW())`,
		),
		deps.db.query<PendingOfferRow>(
			`SELECT po.id, po.to_account_id, po.from_actor_id, po.role, po.scope_id,
			        po.created_at, po.expires_at, a.username AS from_username
			 FROM permit_offer po
			 JOIN actor act ON act.id = po.from_actor_id
			 JOIN account a ON a.id = act.account_id
			 WHERE po.accepted_at IS NULL
			   AND po.declined_at IS NULL
			   AND po.retracted_at IS NULL
			   AND po.superseded_at IS NULL
			   AND po.expires_at > NOW()
			 ORDER BY po.expires_at ASC`,
		),
	]);

	// Index actors by account_id (1:1 in v1)
	const actor_by_account = new Map<Uuid, Actor>();
	for (const actor of actors) {
		actor_by_account.set(actor.account_id, actor);
	}

	// Group permits by actor_id
	const permits_by_actor = new Map<Uuid, Array<PermitWithActorId>>();
	for (const permit of permits) {
		let list = permits_by_actor.get(permit.actor_id);
		if (!list) {
			list = [];
			permits_by_actor.set(permit.actor_id, list);
		}
		list.push(permit);
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
		const actor_permits = actor ? (permits_by_actor.get(actor.id) ?? []) : [];
		const account_offers = offers_by_account.get(account.id) ?? [];
		return {
			account: to_admin_account(account),
			actor: actor ? {id: actor.id, name: actor.name} : null,
			permits: actor_permits.map((p) => ({
				id: p.id,
				role: p.role,
				scope_id: p.scope_id,
				created_at: p.created_at,
				expires_at: p.expires_at,
				granted_by: p.granted_by,
			})),
			pending_offers: account_offers.map((o) => ({
				id: o.id,
				role: o.role,
				scope_id: o.scope_id,
				from_actor_id: o.from_actor_id,
				from_username: o.from_username,
				created_at: o.created_at,
				expires_at: o.expires_at,
			})),
		};
	});
};
