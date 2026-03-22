/**
 * Auth entity types and client-safe schemas.
 *
 * Defines the runtime types for the fuz identity system:
 * `Account`, `Actor`, `Permit`, `AuthSession`, and `ApiToken`.
 *
 * DDL lives in `ddl.ts`; role system in `role_schema.ts`.
 * See docs/identity.md for design rationale.
 *
 * @module
 */

import {z} from 'zod';

// TODO consider `.brand()` on Username and Email for compile-time safety

/** Minimum username length (must have start + middle + end characters). */
export const USERNAME_LENGTH_MIN = 3;

/** Maximum username length (matches GitHub's limit). */
export const USERNAME_LENGTH_MAX = 39;

/** Maximum length for username input on login/lookup — more permissive than `USERNAME_LENGTH_MAX` for forward-compatibility if the creation limit is raised. */
export const USERNAME_PROVIDED_LENGTH_MAX = 255;

/** Username for account creation — starts with letter, alphanumeric/dash/underscore middle, ends with alphanumeric. No @ or . allowed. */
export const Username = z
	.string()
	.min(USERNAME_LENGTH_MIN)
	.max(USERNAME_LENGTH_MAX)
	.regex(/^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$/);
export type Username = z.infer<typeof Username>;

/** Username submitted for login or lookup — minimal validation for forward-compatibility if format rules change. */
export const UsernameProvided = z.string().min(1).max(USERNAME_PROVIDED_LENGTH_MAX);
export type UsernameProvided = z.infer<typeof UsernameProvided>;

/** Email validation. */
export const Email = z.email();
export type Email = z.infer<typeof Email>;

// Types

/** Account — authentication identity. You log in as an account. */
export interface Account {
	id: string;
	username: Username;
	email: Email | null;
	email_verified: boolean;
	password_hash: string;
	created_at: string;
	created_by: string | null;
	updated_at: string;
	updated_by: string | null;
}

/** Account without sensitive fields, scoped to the authenticated user's own session. */
export interface SessionAccount {
	id: string;
	username: Username;
	email: Email | null;
	email_verified: boolean;
	created_at: string;
}

/** Actor — the entity that acts. Owns cells, holds permits, appears in audit trails. */
export interface Actor {
	id: string;
	account_id: string;
	name: string;
	created_at: string;
	updated_at: string | null;
	updated_by: string | null;
}

/** Permit — time-bounded, revocable grant of a role to an actor. */
export interface Permit {
	id: string;
	actor_id: string;
	role: string;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
	revoked_by: string | null;
	granted_by: string | null;
}

export const is_permit_active = (p: Permit, now: Date = new Date()): boolean =>
	!p.revoked_at && (!p.expires_at || new Date(p.expires_at) > now);

/** Server-side auth session, keyed by blake3 hash of session token. */
export interface AuthSession {
	id: string;
	account_id: string;
	created_at: string;
	expires_at: string;
	last_seen_at: string;
}

/** API token for CLI/programmatic access. */
export interface ApiToken {
	id: string;
	account_id: string;
	name: string;
	token_hash: string;
	expires_at: string | null;
	last_used_at: string | null;
	last_used_ip: string | null;
	created_at: string;
}

// Client-safe Zod schemas — for route output validation and ActionSpec outputs.

/** Zod schema for `SessionAccount` — account without sensitive fields. */
export const SessionAccountJson = z.strictObject({
	id: z.string(),
	username: Username,
	email: Email.nullable(),
	email_verified: z.boolean(),
	created_at: z.string(),
});
export type SessionAccountJson = z.infer<typeof SessionAccountJson>;

/** Zod schema for `AuthSession` — id is the blake3 hash, safe for client. */
export const AuthSessionJson = z.strictObject({
	id: z.string(),
	account_id: z.string(),
	created_at: z.string(),
	expires_at: z.string(),
	last_seen_at: z.string(),
});
export type AuthSessionJson = z.infer<typeof AuthSessionJson>;

/** Zod schema for client-safe API token listing (excludes `token_hash`). */
export const ClientApiTokenJson = z.strictObject({
	id: z.string(),
	account_id: z.string(),
	name: z.string(),
	expires_at: z.string().nullable(),
	last_used_at: z.string().nullable(),
	last_used_ip: z.string().nullable(),
	created_at: z.string(),
});
export type ClientApiTokenJson = z.infer<typeof ClientApiTokenJson>;

/** Zod schema for the permit summary returned in admin account listings. */
export const PermitSummaryJson = z.strictObject({
	id: z.string(),
	role: z.string(),
	created_at: z.string(),
	expires_at: z.string().nullable(),
	granted_by: z.string().nullable(),
});
export type PermitSummaryJson = z.infer<typeof PermitSummaryJson>;

/** Zod schema for the actor summary returned in admin account listings. */
export const ActorSummaryJson = z.strictObject({
	id: z.string(),
	name: z.string(),
});
export type ActorSummaryJson = z.infer<typeof ActorSummaryJson>;

/** Zod schema for admin-facing account data — extends `SessionAccountJson` with audit fields. */
export const AdminAccountJson = SessionAccountJson.extend({
	updated_at: z.string(),
	updated_by: z.string().nullable(),
});
export type AdminAccountJson = z.infer<typeof AdminAccountJson>;

/** Zod schema for an admin account listing entry (account + actor + permits). */
export const AdminAccountEntryJson = z.strictObject({
	account: AdminAccountJson,
	actor: ActorSummaryJson.nullable(),
	permits: z.array(PermitSummaryJson),
});
export type AdminAccountEntryJson = z.infer<typeof AdminAccountEntryJson>;

// Input types

export interface CreateAccountInput {
	username: Username;
	password_hash: string;
	email?: Email | null;
}

export interface GrantPermitInput {
	actor_id: string;
	role: string;
	expires_at?: Date | null;
	granted_by: string | null;
}

/**
 * Convert an `Account` to a `SessionAccount` by stripping sensitive fields.
 *
 * @param account - the full account record
 * @returns the client-safe account
 */
export const to_session_account = (account: Account): SessionAccount => ({
	id: account.id,
	username: account.username,
	email: account.email,
	email_verified: account.email_verified,
	created_at: account.created_at,
});

/**
 * Convert an `Account` to an `AdminAccountJson` for admin listings.
 *
 * @param account - the full account record
 * @returns the admin-safe account with audit fields
 */
export const to_admin_account = (account: Account): AdminAccountJson => ({
	...to_session_account(account),
	updated_at: account.updated_at,
	updated_by: account.updated_by,
});
