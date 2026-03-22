/**
 * Account and actor database queries.
 *
 * Provides CRUD operations for the account and actor tables.
 * For v1, every account has exactly one actor (1:1).
 *
 * @module
 */

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
	id: string;
	actor_id: string;
	role: string;
	created_at: string;
	expires_at: string | null;
	granted_by: string | null;
}

/**
 * List all accounts with their actors and active permits for admin display.
 *
 * Uses 3 flat queries instead of N+1 per-account loops.
 *
 * @param deps - query dependencies
 * @returns admin account entries sorted by creation date
 */
export const query_admin_account_list = async (
	deps: QueryDeps,
): Promise<Array<AdminAccountEntryJson>> => {
	const [accounts, actors, permits] = await Promise.all([
		deps.db.query<Account>(`SELECT * FROM account ORDER BY created_at`),
		deps.db.query<Actor>(`SELECT * FROM actor`),
		deps.db.query<PermitWithActorId>(
			`SELECT id, actor_id, role, created_at, expires_at, granted_by
			 FROM permit
			 WHERE revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at > NOW())`,
		),
	]);

	// Index actors by account_id (1:1 in v1)
	const actor_by_account = new Map<string, Actor>();
	for (const actor of actors) {
		actor_by_account.set(actor.account_id, actor);
	}

	// Group permits by actor_id
	const permits_by_actor = new Map<string, Array<PermitWithActorId>>();
	for (const permit of permits) {
		let list = permits_by_actor.get(permit.actor_id);
		if (!list) {
			list = [];
			permits_by_actor.set(permit.actor_id, list);
		}
		list.push(permit);
	}

	return accounts.map((account): AdminAccountEntryJson => {
		const actor = actor_by_account.get(account.id);
		const actor_permits = actor ? (permits_by_actor.get(actor.id) ?? []) : [];
		return {
			account: to_admin_account(account),
			actor: actor ? {id: actor.id, name: actor.name} : null,
			permits: actor_permits.map((p) => ({
				id: p.id,
				role: p.role,
				created_at: p.created_at,
				expires_at: p.expires_at,
				granted_by: p.granted_by,
			})),
		};
	});
};
