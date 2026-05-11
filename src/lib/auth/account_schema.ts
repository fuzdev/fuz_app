/**
 * Auth entity types and client-safe schemas.
 *
 * Defines the runtime types for the fuz identity system:
 * `Account`, `Actor`, `RoleGrant`, `AuthSession`, and `ApiToken`.
 *
 * Identifier primitives (`Username`, `UsernameProvided`, `Email`) live
 * in `../primitive_schemas.ts` — they're general validator shapes that
 * don't depend on the auth domain. The auth-shape request-contract
 * primitive `ActingActor` lives in `../http/auth_shape.ts` next to
 * `RouteAuth` (the two pair: `auth.actor !== 'none'` ⟺ input declares
 * `acting?: ActingActor`).
 *
 * DDL lives in `auth/ddl.ts`; role system in `auth/role_schema.ts`.
 * See docs/identity.md for design rationale.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {Username, Email} from '../primitive_schemas.js';

// Types

/** Account — authentication identity. You log in as an account. */
export interface Account {
	id: Uuid;
	username: Username;
	email: Email | null;
	email_verified: boolean;
	password_hash: string;
	created_at: string;
	created_by: Uuid | null;
	updated_at: string;
	updated_by: Uuid | null;
}

/** Account without sensitive fields, scoped to the authenticated user's own session. */
export interface SessionAccount {
	id: Uuid;
	username: Username;
	email: Email | null;
	email_verified: boolean;
	created_at: string;
}

/** Actor — the entity that acts. Owns cells, holds role_grants, appears in audit trails. */
export interface Actor {
	id: Uuid;
	account_id: Uuid;
	name: string;
	created_at: string;
	updated_at: string | null;
	updated_by: Uuid | null;
}

/**
 * Maximum length of the optional free-form `revoked_reason` attached to a
 * revoked role_grant. Bounds the value at the schema layer so both the admin
 * input (when the route surfaces a reason field) and the revokee-facing
 * `role_grant_revoke` WS notification validate against the same ceiling.
 */
export const ROLE_GRANT_REVOKED_REASON_LENGTH_MAX = 500;

/** Role grant — time-bounded, revocable grant of a role to an actor. */
export interface RoleGrant {
	id: Uuid;
	actor_id: Uuid;
	role: string;
	/**
	 * Machine-readable kind tag for the polymorphic `scope_id`. Paired-null
	 * with `scope_id` per the `role_grant_scope_kind_paired` CHECK: both null
	 * (global) or both non-null (scoped). Consumer-declared via
	 * `create_scope_kind_schema(...)`; v1 keeps validation registry-membership
	 * only, with no INSERT-time `(role, scope_kind)` enforcement.
	 */
	scope_kind: string | null;
	/** Resource scope this grant applies to (e.g. a classroom id). `null` for global role_grants. */
	scope_id: Uuid | null;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
	revoked_by: Uuid | null;
	/** Optional free-form reason attached on revoke (surfaced in the revokee WS notification once it lands). */
	revoked_reason: string | null;
	granted_by: Uuid | null;
	/** Offer that produced this role_grant (set by `query_accept_offer`). `null` for direct grants. */
	source_offer_id: Uuid | null;
}

export const is_role_grant_active = (
	p: {revoked_at?: string | null; expires_at: string | null},
	now: Date = new Date(),
): boolean => !p.revoked_at && (!p.expires_at || new Date(p.expires_at) > now);

/** Server-side auth session, keyed by blake3 hash of session token. */
export interface AuthSession {
	id: string;
	account_id: Uuid;
	created_at: string;
	expires_at: string;
	last_seen_at: string;
}

/** API token for CLI/programmatic access. */
export interface ApiToken {
	id: string;
	account_id: Uuid;
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
	id: Uuid,
	username: Username,
	email: Email.nullable(),
	email_verified: z.boolean(),
	created_at: z.string(),
});
export type SessionAccountJson = z.infer<typeof SessionAccountJson>;

/** Zod schema for `AuthSession` — id is the blake3 hash, safe for client. */
export const AuthSessionJson = z.strictObject({
	id: z.string(),
	account_id: Uuid,
	created_at: z.string(),
	expires_at: z.string(),
	last_seen_at: z.string(),
});
export type AuthSessionJson = z.infer<typeof AuthSessionJson>;

/** Zod schema for client-safe API token listing (excludes `token_hash`). */
export const ClientApiTokenJson = z.strictObject({
	id: z.string(),
	account_id: Uuid,
	name: z.string(),
	expires_at: z.string().nullable(),
	last_used_at: z.string().nullable(),
	last_used_ip: z.string().nullable(),
	created_at: z.string(),
});
export type ClientApiTokenJson = z.infer<typeof ClientApiTokenJson>;

/** Zod schema for the role_grant summary returned in admin account listings. */
export const RoleGrantSummaryJson = z.strictObject({
	id: Uuid,
	role: z.string(),
	scope_kind: z.string().nullable(),
	scope_id: Uuid.nullable(),
	created_at: z.string(),
	expires_at: z.string().nullable(),
	granted_by: Uuid.nullable(),
});
export type RoleGrantSummaryJson = z.infer<typeof RoleGrantSummaryJson>;

/** Zod schema for the actor summary returned in admin account listings. */
export const ActorSummaryJson = z.strictObject({
	id: Uuid,
	name: z.string(),
});
export type ActorSummaryJson = z.infer<typeof ActorSummaryJson>;

/** Zod schema for admin-facing account data — extends `SessionAccountJson` with audit fields. */
export const AdminAccountJson = SessionAccountJson.extend({
	updated_at: z.string(),
	updated_by: Uuid.nullable(),
});
export type AdminAccountJson = z.infer<typeof AdminAccountJson>;

/**
 * Zod schema for a pending role_grant offer surfaced in admin account listings.
 *
 * Deliberately narrower than `RoleGrantOfferJson`: omits `message` and
 * `decline_reason` so cross-admin visibility of the listing does not expose
 * grantor-authored text that the audit log also withholds. Full offer
 * payloads remain available through the offer-specific RPC surface and the
 * audit log when admins need them.
 *
 * `from_username` is resolved server-side so multi-admin deployments can see
 * at a glance whose pending offer is blocking a "+ {role}" button; the
 * resolution runs inside the listing query's parallel batch.
 */
export const PendingOfferSummaryJson = z.strictObject({
	id: Uuid,
	role: z.string(),
	scope_kind: z.string().nullable(),
	scope_id: Uuid.nullable(),
	from_actor_id: Uuid,
	from_username: z.string(),
	created_at: z.string(),
	expires_at: z.string(),
});
export type PendingOfferSummaryJson = z.infer<typeof PendingOfferSummaryJson>;

/** Zod schema for an admin account listing entry (account + actor + role_grants + pending offers). */
export const AdminAccountEntryJson = z.strictObject({
	account: AdminAccountJson,
	actor: ActorSummaryJson.nullable(),
	role_grants: z.array(RoleGrantSummaryJson),
	pending_offers: z.array(PendingOfferSummaryJson),
});
export type AdminAccountEntryJson = z.infer<typeof AdminAccountEntryJson>;

// Input types

export interface CreateAccountInput {
	username: Username;
	password_hash: string;
	email?: Email | null;
}

export interface CreateRoleGrantInput {
	actor_id: Uuid;
	role: string;
	/**
	 * Machine-readable kind for the `scope_id`. Required iff `scope_id` is
	 * set; must be null/omitted when `scope_id` is null. The DB-level
	 * `role_grant_scope_kind_paired` CHECK rejects mismatched pairs.
	 */
	scope_kind?: string | null;
	/** Scope the grant applies to. `null` / omitted grants a global role_grant. */
	scope_id?: Uuid | null;
	expires_at?: Date | null;
	granted_by: Uuid | null;
	/** Offer id that produced this role_grant. Set by `query_accept_offer`; leave unset for direct grants. */
	source_offer_id?: Uuid | null;
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
