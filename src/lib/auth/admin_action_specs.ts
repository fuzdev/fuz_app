/**
 * Admin RPC action specs — declarative contract for admin-only operations.
 *
 * Import this module for the specs, Input/Output schemas, and the
 * `all_admin_action_specs` registry. Handlers live in `auth/admin_actions.ts`.
 *
 * Authorization is declared at the spec level (`auth: {role: ROLE_ADMIN}`)
 * so the RPC dispatcher enforces admin before the handler runs and the
 * generated surface accurately reports the requirement.
 *
 * The registry always includes `app_settings_get` / `app_settings_update` —
 * the runtime factory only wires their handlers when
 * `AdminActionOptions.app_settings` is provided; dispatch falls back to
 * `method_not_found` when absent.
 *
 * @module
 */

import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { RequestResponseActionSpec } from '../actions/action_spec.ts';
import { ROLE_ADMIN, ROLE_KEEPER, RoleName } from './role_schema.ts';
import { CREDENTIAL_TYPE_DAEMON_TOKEN } from './credential_type_schema.ts';
import { AdminAccountEntryJson } from './account_schema.ts';
import { Email, Username } from '../primitive_schemas.ts';
import { ActingActor } from '../http/auth_shape.ts';
import {
	AdminSessionJson,
	AUDIT_LOG_DEFAULT_LIMIT,
	AuditEventTypeName,
	AuditLogEventWithUsernamesJson,
	AuditOutcome,
	RoleGrantHistoryEventJson
} from './audit_log_schema.ts';
import { InviteJson, InviteWithUsernamesJson } from './invite_schema.ts';
import { AppSettingsWithUsernameJson } from './app_settings_schema.ts';

/** Max audit-log page size. */
export const AUDIT_LOG_LIST_LIMIT_MAX = 200;

/** Default `admin_account_list` page size. */
export const ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT = 50;
/** Max `admin_account_list` page size. */
export const ADMIN_ACCOUNT_LIST_LIMIT_MAX = 200;

// -- Input/output schemas ---------------------------------------------------

/** Input for `admin_account_list`. */
export const AdminAccountListInput = z
	.strictObject({
		acting: ActingActor,
		limit: z
			.number()
			.int()
			.min(1)
			.max(ADMIN_ACCOUNT_LIST_LIMIT_MAX)
			.nullish()
			.meta({
				description: `Max accounts to return (default ${ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT}, max ${
					ADMIN_ACCOUNT_LIST_LIMIT_MAX
				}).`
			}),
		offset: z.number().int().min(0).nullish().meta({ description: 'Pagination offset.' }),
		include_deleted: z.boolean().nullish().meta({
			description:
				'Include soft-deleted (tombstoned) accounts in the listing. Default false (active only). Used by the admin UI to surface accounts for reactivation via `account_undelete`.'
		})
	})
	.default({});
export type AdminAccountListInput = z.infer<typeof AdminAccountListInput>;

/** Output for `admin_account_list`. */
export const AdminAccountListOutput = z.strictObject({
	accounts: z.array(AdminAccountEntryJson),
	grantable_roles: z.array(RoleName)
});
export type AdminAccountListOutput = z.infer<typeof AdminAccountListOutput>;

/** Input for `admin_session_list`. */
export const AdminSessionListInput = z
	.strictObject({
		acting: ActingActor
	})
	.default({});
export type AdminSessionListInput = z.infer<typeof AdminSessionListInput>;

/** Output for `admin_session_list`. Cross-account listing; fan-out already scoped by role auth. */
export const AdminSessionListOutput = z.strictObject({
	sessions: z.array(AdminSessionJson)
});
export type AdminSessionListOutput = z.infer<typeof AdminSessionListOutput>;

/** Input for `admin_session_revoke_all`. */
export const AdminSessionRevokeAllInput = z.strictObject({
	account_id: Uuid.meta({ description: 'Account whose sessions to revoke.' }),
	acting: ActingActor
});
export type AdminSessionRevokeAllInput = z.infer<typeof AdminSessionRevokeAllInput>;

/** Output for `admin_session_revoke_all`. */
export const AdminSessionRevokeAllOutput = z.strictObject({
	ok: z.literal(true),
	count: z.number()
});
export type AdminSessionRevokeAllOutput = z.infer<typeof AdminSessionRevokeAllOutput>;

/** Input for `admin_token_revoke_all`. */
export const AdminTokenRevokeAllInput = z.strictObject({
	account_id: Uuid.meta({ description: 'Account whose API tokens to revoke.' }),
	acting: ActingActor
});
export type AdminTokenRevokeAllInput = z.infer<typeof AdminTokenRevokeAllInput>;

/** Output for `admin_token_revoke_all`. */
export const AdminTokenRevokeAllOutput = z.strictObject({
	ok: z.literal(true),
	count: z.number()
});
export type AdminTokenRevokeAllOutput = z.infer<typeof AdminTokenRevokeAllOutput>;

/**
 * Input for `audit_log_list`. All filter fields are optional — omit for the
 * default newest-first page. `since_seq` exists for SSE reconnection gap
 * fill (caller supplies the highest seq seen; server returns everything
 * after).
 */
export const AuditLogListInput = z
	.strictObject({
		event_type: AuditEventTypeName.nullish().meta({
			description:
				'Filter by event type. Accepts builtin or consumer-registered names (regex-validated).'
		}),
		outcome: AuditOutcome.nullish().meta({
			description: 'Filter by outcome (`success` or `failure`).'
		}),
		account_id: Uuid.nullish().meta({ description: 'Filter by actor account id.' }),
		limit: z
			.number()
			.int()
			.min(1)
			.max(AUDIT_LOG_LIST_LIMIT_MAX)
			.nullish()
			.meta({
				description: `Max rows to return (default ${AUDIT_LOG_DEFAULT_LIMIT}, max ${
					AUDIT_LOG_LIST_LIMIT_MAX
				}).`
			}),
		offset: z.number().int().min(0).nullish().meta({ description: 'Pagination offset.' }),
		since_seq: z.number().int().min(0).nullish().meta({
			description: 'Gap-fill from this seq forward. Used for SSE reconnection.'
		}),
		acting: ActingActor
	})
	.default({});
export type AuditLogListInput = z.infer<typeof AuditLogListInput>;

/** Output for `audit_log_list`. */
export const AuditLogListOutput = z.strictObject({
	events: z.array(AuditLogEventWithUsernamesJson)
});
export type AuditLogListOutput = z.infer<typeof AuditLogListOutput>;

/** Input for `audit_log_role_grant_history`. */
export const AuditLogRoleGrantHistoryInput = z
	.strictObject({
		limit: z
			.number()
			.int()
			.min(1)
			.max(AUDIT_LOG_LIST_LIMIT_MAX)
			.nullish()
			.meta({
				description: `Max rows to return (default ${AUDIT_LOG_DEFAULT_LIMIT}, max ${
					AUDIT_LOG_LIST_LIMIT_MAX
				}).`
			}),
		offset: z.number().int().min(0).nullish().meta({ description: 'Pagination offset.' }),
		acting: ActingActor
	})
	.default({});
export type AuditLogRoleGrantHistoryInput = z.infer<typeof AuditLogRoleGrantHistoryInput>;

/** Output for `audit_log_role_grant_history`. */
export const AuditLogRoleGrantHistoryOutput = z.strictObject({
	events: z.array(RoleGrantHistoryEventJson)
});
export type AuditLogRoleGrantHistoryOutput = z.infer<typeof AuditLogRoleGrantHistoryOutput>;

/** Input for `invite_create`. At least one of `email` / `username` must be provided. */
export const InviteCreateInput = z
	.strictObject({
		email: Email.nullish().meta({ description: 'Invitee email.' }),
		username: Username.nullish().meta({ description: 'Invitee username.' }),
		acting: ActingActor
	})
	.refine((v) => v.email != null || v.username != null, {
		message: 'at least one of email or username is required',
		path: ['email']
	});
export type InviteCreateInput = z.infer<typeof InviteCreateInput>;

/** Output for `invite_create`. */
export const InviteCreateOutput = z.strictObject({
	ok: z.literal(true),
	invite: InviteJson
});
export type InviteCreateOutput = z.infer<typeof InviteCreateOutput>;

/** Input for `invite_list`. */
export const InviteListInput = z
	.strictObject({
		acting: ActingActor
	})
	.default({});
export type InviteListInput = z.infer<typeof InviteListInput>;

/** Output for `invite_list`. Uses the enriched row including creator/claimer usernames. */
export const InviteListOutput = z.strictObject({
	invites: z.array(InviteWithUsernamesJson)
});
export type InviteListOutput = z.infer<typeof InviteListOutput>;

/** Input for `invite_delete`. */
export const InviteDeleteInput = z.strictObject({
	invite_id: Uuid.meta({ description: 'Invite to delete. Must be unclaimed.' }),
	acting: ActingActor
});
export type InviteDeleteInput = z.infer<typeof InviteDeleteInput>;

/** Output for `invite_delete`. */
export const InviteDeleteOutput = z.strictObject({
	ok: z.literal(true)
});
export type InviteDeleteOutput = z.infer<typeof InviteDeleteOutput>;

/** Input for `app_settings_get`. */
export const AppSettingsGetInput = z
	.strictObject({
		acting: ActingActor
	})
	.default({});
export type AppSettingsGetInput = z.infer<typeof AppSettingsGetInput>;

/** Output for `app_settings_get`. */
export const AppSettingsGetOutput = z.strictObject({
	settings: AppSettingsWithUsernameJson
});
export type AppSettingsGetOutput = z.infer<typeof AppSettingsGetOutput>;

/** Input for `app_settings_update`. */
export const AppSettingsUpdateInput = z.strictObject({
	open_signup: z.boolean().meta({ description: 'New value for the open signup toggle.' }),
	acting: ActingActor
});
export type AppSettingsUpdateInput = z.infer<typeof AppSettingsUpdateInput>;

/** Output for `app_settings_update`. */
export const AppSettingsUpdateOutput = z.strictObject({
	ok: z.literal(true),
	settings: AppSettingsWithUsernameJson
});
export type AppSettingsUpdateOutput = z.infer<typeof AppSettingsUpdateOutput>;

/**
 * `data.reason` on `account_purge` when `confirm: true` is absent.
 * Fail-loud: the irreversible purge refuses to run without explicit
 * confirmation. Mirrors the Rust `ERROR_PURGE_NOT_CONFIRMED`.
 */
export const ERROR_PURGE_NOT_CONFIRMED = 'purge_not_confirmed' as const;

/**
 * `data.reason` (403) on `account_delete` / `account_purge` when the
 * target account holds an active keeper role_grant. The keeper account
 * is never deletable or purgeable through the API: auth resolution and
 * daemon-token resolution both pivot on the keeper account, so tombstoning
 * or cascading it away would brick keeper/daemon auth with no recovery
 * path (the keeper role is not web-revocable, and `account_purge` itself
 * requires keeper auth). Keeper-account removal stays out-of-band
 * (bootstrap / DB surgery). Mirrors the Rust `ERROR_CANNOT_DELETE_KEEPER`.
 */
export const ERROR_CANNOT_DELETE_KEEPER = 'cannot_delete_keeper' as const;

/**
 * `data.reason` (403) on `account_delete` / `account_purge` when the target
 * is the **sole remaining active admin** — removing it would leave the
 * system with no account that can authenticate into the admin surface (and
 * `account_undelete` is itself admin-gated). Unlike the keeper guard this is
 * keeper-recoverable (a keeper can re-grant admin), but the guard avoids the
 * foot-gun of an admin tombstoning the last admin in one call. Soft-deleted
 * admins don't count toward the tally (they can't log in). Mirrors the Rust
 * `ERROR_CANNOT_DELETE_LAST_ADMIN`.
 */
export const ERROR_CANNOT_DELETE_LAST_ADMIN = 'cannot_delete_last_admin' as const;

/**
 * Input for `account_delete` (soft delete). `account_id` is optional —
 * omitted (or equal to the caller's own account) is a self-delete; a
 * different account requires the admin role (handler-enforced
 * elevation, like `role_grant_offer_list`).
 */
export const AccountDeleteInput = z
	.strictObject({
		account_id: Uuid.nullish().meta({
			description: 'Account to soft-delete. Omit for self-delete; another account requires admin.'
		}),
		acting: ActingActor
	})
	.default({});
export type AccountDeleteInput = z.infer<typeof AccountDeleteInput>;

/** Output for `account_delete`. */
export const AccountDeleteOutput = z.strictObject({
	ok: z.literal(true),
	deleted: z.boolean()
});
export type AccountDeleteOutput = z.infer<typeof AccountDeleteOutput>;

/** Input for `account_purge` (hard, irreversible delete). Keeper-only. */
export const AccountPurgeInput = z.strictObject({
	account_id: Uuid.meta({ description: 'Account to hard-purge.' }),
	confirm: z.boolean().optional().meta({
		description: 'Must be `true` — fail-loud guard against an accidental irreversible purge.'
	}),
	acting: ActingActor
});
export type AccountPurgeInput = z.infer<typeof AccountPurgeInput>;

/** Output for `account_purge`. */
export const AccountPurgeOutput = z.strictObject({
	ok: z.literal(true),
	purged: z.boolean()
});
export type AccountPurgeOutput = z.infer<typeof AccountPurgeOutput>;

/**
 * Input for `account_undelete` (reactivation). `account_id` is required —
 * unlike `account_delete` there is no self path: a soft-deleted account
 * can't authenticate (auth resolution excludes it, sessions are revoked),
 * so reactivation is always an admin acting on another account.
 */
export const AccountUndeleteInput = z.strictObject({
	account_id: Uuid.meta({ description: 'Soft-deleted account to reactivate.' }),
	acting: ActingActor
});
export type AccountUndeleteInput = z.infer<typeof AccountUndeleteInput>;

/** Output for `account_undelete`. */
export const AccountUndeleteOutput = z.strictObject({
	ok: z.literal(true),
	undeleted: z.boolean()
});
export type AccountUndeleteOutput = z.infer<typeof AccountUndeleteOutput>;

// -- Action specs -----------------------------------------------------------

/**
 * `rate_limit: 'account'` bounds admin-side scraping of the account table
 * via `(limit, offset)` walking — admin trust is not a substitute for a
 * read-rate cap when the listing is paginated and cross-account (yields
 * every account + actor + active role_grant in the system).
 */
export const admin_account_list_action_spec = {
	method: 'admin_account_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: false,
	input: AdminAccountListInput,
	output: AdminAccountListOutput,
	async: true,
	description: 'List all accounts with their actors, role_grants, and pending offers. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * `rate_limit: 'account'` bounds cross-account scraping of every active
 * `auth_session` row — no pagination, but the read is unbounded across
 * accounts and reveals one row per live cookie globally.
 */
export const admin_session_list_action_spec = {
	method: 'admin_session_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: false,
	input: AdminSessionListInput,
	output: AdminSessionListOutput,
	async: true,
	description: 'List every active auth session across all accounts. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

export const admin_session_revoke_all_action_spec = {
	method: 'admin_session_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: true,
	input: AdminSessionRevokeAllInput,
	output: AdminSessionRevokeAllOutput,
	async: true,
	description: 'Revoke all sessions for an account. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

export const admin_token_revoke_all_action_spec = {
	method: 'admin_token_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: true,
	input: AdminTokenRevokeAllInput,
	output: AdminTokenRevokeAllOutput,
	async: true,
	description: 'Revoke all API tokens for an account. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * `rate_limit: 'account'` bounds admin-side enumeration of the entire
 * audit log via `(limit, offset)` walking — same shape as
 * `admin_account_list_action_spec`. The listing carries cross-account
 * forensic detail (target ids, IPs, metadata), so the read-rate cap is
 * the only check that distinguishes a human reviewer from a scraping
 * script.
 */
export const audit_log_list_action_spec = {
	method: 'audit_log_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: false,
	input: AuditLogListInput,
	output: AuditLogListOutput,
	async: true,
	description: 'List audit log events with optional filters. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * `rate_limit: 'account'` bounds admin-side enumeration of the role_grant
 * history via `(limit, offset)` walking — same shape as `audit_log_list`,
 * narrower projection but identical scraping vector.
 */
export const audit_log_role_grant_history_action_spec = {
	method: 'audit_log_role_grant_history',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: false,
	input: AuditLogRoleGrantHistoryInput,
	output: AuditLogRoleGrantHistoryOutput,
	async: true,
	description: 'List role_grant grant and revoke events with usernames. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

export const invite_create_action_spec = {
	method: 'invite_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: true,
	input: InviteCreateInput,
	output: InviteCreateOutput,
	async: true,
	description: 'Create an invite addressed to an email, username, or both. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * `rate_limit: 'account'` bounds admin-side scraping of the invite table —
 * bounded by table size, but every row carries email + username +
 * creator/claimer identifiers worth defense-in-depth against an admin
 * mutation oracle running scripted reads alongside `invite_create`.
 */
export const invite_list_action_spec = {
	method: 'invite_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: false,
	input: InviteListInput,
	output: InviteListOutput,
	async: true,
	description: 'List all invites with creator and claimer usernames. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

export const invite_delete_action_spec = {
	method: 'invite_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: true,
	input: InviteDeleteInput,
	output: InviteDeleteOutput,
	async: true,
	description: 'Delete an unclaimed invite. Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * Soft-delete an account (reversible tombstone). Self-or-admin: the
 * caller may delete their own account; deleting another requires the
 * admin role (handler-enforced elevation). No `admin_` prefix — the
 * privilege lives in the auth check, not the name, so self-service
 * deletion stays open (`delete` = soft, `purge` = hard).
 */
export const account_delete_action_spec = {
	method: 'account_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: true,
	input: AccountDeleteInput,
	output: AccountDeleteOutput,
	async: true,
	description:
		'Soft-delete an account (reversible tombstone): blocks auth, revokes sessions/tokens, soft-deletes its actor(s). Self-service for own account; admin required to delete another.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * Hard-purge an account (keeper-gated, irreversible). Keeper credential
 * (`daemon_token`) + keeper role + explicit `confirm: true`. Not
 * admin-reachable and not self-service — the most dangerous operation is
 * the most restricted. `purge` = hard; the word + gating + WARN flag the
 * danger (fail-loud).
 */
export const account_purge_action_spec = {
	method: 'account_purge',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {
		account: 'required',
		actor: 'required',
		roles: [ROLE_KEEPER],
		credential_types: [CREDENTIAL_TYPE_DAEMON_TOKEN]
	},
	side_effects: true,
	input: AccountPurgeInput,
	output: AccountPurgeOutput,
	async: true,
	description:
		'Hard-purge an account (irreversible cascading delete). Keeper-only + explicit confirm. Audit ids survive; identity snapshotted in metadata.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * Reactivate a soft-deleted account (clears the tombstone). Admin-only —
 * there is no self path because a soft-deleted account can't authenticate
 * (auth resolution excludes it and its sessions are revoked), so
 * reactivation is always an admin acting on another account. The inverse
 * of `account_delete`; does not restore revoked sessions/tokens
 * (delete = soft, purge = hard).
 */
export const account_undelete_action_spec = {
	method: 'account_undelete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: true,
	input: AccountUndeleteInput,
	output: AccountUndeleteOutput,
	async: true,
	description:
		'Reactivate a soft-deleted account (clears the deleted_at tombstone on the account + its actors). Admin-only. Does not restore revoked sessions/tokens — principals re-auth fresh.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

export const app_settings_get_action_spec = {
	method: 'app_settings_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: false,
	input: AppSettingsGetInput,
	output: AppSettingsGetOutput,
	async: true,
	description: 'Read global app settings. Admin-only.'
} satisfies RequestResponseActionSpec;

export const app_settings_update_action_spec = {
	method: 'app_settings_update',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: [ROLE_ADMIN] },
	side_effects: true,
	input: AppSettingsUpdateInput,
	output: AppSettingsUpdateOutput,
	async: true,
	description: 'Update global app settings (currently just the open signup toggle). Admin-only.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * All admin action specs — a codegen-ready registry. Consumers spread this
 * into their own action-spec array to include admin methods in a typed
 * client surface. Includes the two app-settings specs, whose handlers the
 * runtime factory always wires.
 */
export const all_admin_action_specs: Array<RequestResponseActionSpec> = [
	admin_account_list_action_spec,
	admin_session_list_action_spec,
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	audit_log_list_action_spec,
	audit_log_role_grant_history_action_spec,
	invite_create_action_spec,
	invite_list_action_spec,
	invite_delete_action_spec,
	account_delete_action_spec,
	account_purge_action_spec,
	account_undelete_action_spec,
	app_settings_get_action_spec,
	app_settings_update_action_spec
];
