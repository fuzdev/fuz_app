/**
 * Admin RPC action specs — declarative contract for admin-only operations.
 *
 * Import this module for the specs, Input/Output schemas, and the
 * `all_admin_action_specs` registry. Handlers live in `auth/admin_actions.ts`.
 * Every input and output is a `@fuzdev/fuz_schema` schema.
 *
 * Authorization is declared at the spec level (`auth: {role: ROLE_ADMIN}`)
 * so the RPC dispatcher enforces admin before the handler runs and the
 * generated surface accurately reports the requirement.
 *
 * The registry includes `app_settings_get` / `app_settings_update`, and
 * `create_admin_actions` always wires their handlers.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	array,
	boolean,
	check_at,
	integer,
	literal,
	max_value,
	message,
	min_value,
	nullable,
	number,
	object,
	optional,
	pipe,
	with_default_fn,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { ActingActor, Email, Username, Uuid } from '../primitive_schemas_fuz.ts';
import type { RequestResponseActionSpec } from '../actions/action_spec.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from './role_schema.ts';
import { RoleName } from './role_schema_fuz.ts';
import { CREDENTIAL_TYPE_DAEMON_TOKEN } from './credential_type_schema.ts';
import { NAME_LENGTH_MAX } from './name_schema.ts';
import { AdminAccountEntryJson } from './account_schema.ts';
import {
	AdminSessionJson,
	AUDIT_LOG_DEFAULT_LIMIT,
	AuditLogEventWithUsernamesJson,
	RoleGrantHistoryEventJson
} from './audit_log_schema.ts';
import { AuditEventTypeName, AuditOutcome } from './audit_log_schema_fuz.ts';
import { InviteJson, InviteWithUsernamesJson } from './invite_schema.ts';
import { AppSettingsWithUsernameJson } from './app_settings_schema.ts';
import {
	ERROR_LIMIT_INVALID,
	ERROR_OFFSET_INVALID,
	ERROR_OUTCOME_INVALID,
	ERROR_SINCE_SEQ_INVALID
} from '../http/error_schemas.ts';

/** Max audit-log page size. */
export const AUDIT_LOG_LIST_LIMIT_MAX = 200;

/** Default `admin_account_list` page size. */
export const ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT = 50;
/** Max `admin_account_list` page size. */
export const ADMIN_ACCOUNT_LIST_LIMIT_MAX = 200;

/** The message `invite_create` fails with when it is given neither `email` nor `username`. */
export const INVITE_TARGET_REQUIRED_MESSAGE = 'at least one of email or username is required';

// -- Input/output schemas ---------------------------------------------------

/**
 * A page's `limit`, an integer in `[1, max]`, or absent, with the reason
 * every refusal of it carries.
 */
const page_limit = (max: number, description: string) =>
	meta(optional(nullable(pipe(number, integer, min_value(1), max_value(max)))), {
		description,
		invalid_reason: ERROR_LIMIT_INVALID
	});

/**
 * An integer at least zero, bounded by `Number.MAX_SAFE_INTEGER`, the
 * integers every number holds exactly, or absent: a page's `offset` and the
 * audit list's `since_seq`.
 */
const SafeCount = optional(
	nullable(pipe(number, integer, min_value(0), max_value(Number.MAX_SAFE_INTEGER)))
);

/** A page's `offset`, with the reason every refusal of it carries. */
const PageOffset = meta(SafeCount, {
	description: 'Pagination offset.',
	invalid_reason: ERROR_OFFSET_INVALID
});

/**
 * Input for `admin_account_list`, a `@fuzdev/fuz_schema` schema. An omitted
 * input reads as a fresh `{}`.
 */
export const AdminAccountListInput = with_default_fn(
	object({
		acting: ActingActor,
		limit: page_limit(
			ADMIN_ACCOUNT_LIST_LIMIT_MAX,
			`Max accounts to return (default ${ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT}, max ${
				ADMIN_ACCOUNT_LIST_LIMIT_MAX
			}).`
		),
		offset: PageOffset,
		include_deleted: meta(optional(nullable(boolean)), {
			description:
				'Include soft-deleted (tombstoned) accounts in the listing. Default false (active only). Used by the admin UI to surface accounts for reactivation via `account_undelete`.'
		})
	}),
	() => ({})
);
export type AdminAccountListInput = Infer<typeof AdminAccountListInput>;

/** Output for `admin_account_list`, a `@fuzdev/fuz_schema` schema. */
export const AdminAccountListOutput = object({
	accounts: array(AdminAccountEntryJson),
	grantable_roles: array(RoleName)
});
export type AdminAccountListOutput = Infer<typeof AdminAccountListOutput>;

/**
 * Input for `admin_session_list`, a `@fuzdev/fuz_schema` schema. An omitted
 * input reads as a fresh `{}`.
 */
export const AdminSessionListInput = with_default_fn(object({ acting: ActingActor }), () => ({}));
export type AdminSessionListInput = Infer<typeof AdminSessionListInput>;

/**
 * Output for `admin_session_list`, a `@fuzdev/fuz_schema` schema.
 * Cross-account listing; fan-out already scoped by role auth.
 */
export const AdminSessionListOutput = object({
	sessions: array(AdminSessionJson)
});
export type AdminSessionListOutput = Infer<typeof AdminSessionListOutput>;

/** Input for `admin_session_revoke_all`, a `@fuzdev/fuz_schema` schema. */
export const AdminSessionRevokeAllInput = object({
	account_id: meta(Uuid, { description: 'Account whose sessions to revoke.' }),
	acting: ActingActor
});
export type AdminSessionRevokeAllInput = Infer<typeof AdminSessionRevokeAllInput>;

/** Output for `admin_session_revoke_all`, a `@fuzdev/fuz_schema` schema. */
export const AdminSessionRevokeAllOutput = object({
	ok: literal(true),
	count: pipe(number, integer, min_value(0))
});
export type AdminSessionRevokeAllOutput = Infer<typeof AdminSessionRevokeAllOutput>;

/** Input for `admin_token_revoke_all`, a `@fuzdev/fuz_schema` schema. */
export const AdminTokenRevokeAllInput = object({
	account_id: meta(Uuid, { description: 'Account whose API tokens to revoke.' }),
	acting: ActingActor
});
export type AdminTokenRevokeAllInput = Infer<typeof AdminTokenRevokeAllInput>;

/** Output for `admin_token_revoke_all`, a `@fuzdev/fuz_schema` schema. */
export const AdminTokenRevokeAllOutput = object({
	ok: literal(true),
	count: pipe(number, integer, min_value(0))
});
export type AdminTokenRevokeAllOutput = Infer<typeof AdminTokenRevokeAllOutput>;

/**
 * Input for `audit_log_list`, a `@fuzdev/fuz_schema` schema. All filter
 * fields are optional — omit for the default newest-first page, and an
 * omitted input reads as a fresh `{}`. `since_seq` exists for SSE
 * reconnection gap fill (caller supplies the highest seq seen; server returns
 * everything after).
 */
export const AuditLogListInput = with_default_fn(
	object({
		event_type: meta(optional(nullable(AuditEventTypeName)), {
			description: `Filter by event type. Accepts builtin or consumer-registered names (regex-validated, at most ${NAME_LENGTH_MAX} characters).`
		}),
		outcome: meta(optional(nullable(AuditOutcome)), {
			description: 'Filter by outcome (`success` or `failure`).',
			invalid_reason: ERROR_OUTCOME_INVALID
		}),
		account_id: meta(optional(nullable(Uuid)), {
			description: 'Filter by account id — matches the actor or the target account.'
		}),
		limit: page_limit(
			AUDIT_LOG_LIST_LIMIT_MAX,
			`Max rows to return (default ${AUDIT_LOG_DEFAULT_LIMIT}, max ${AUDIT_LOG_LIST_LIMIT_MAX}).`
		),
		offset: PageOffset,
		since_seq: meta(SafeCount, {
			description: 'Gap-fill from this seq forward. Used for SSE reconnection.',
			invalid_reason: ERROR_SINCE_SEQ_INVALID
		}),
		acting: ActingActor
	}),
	() => ({})
);
export type AuditLogListInput = Infer<typeof AuditLogListInput>;

/** Output for `audit_log_list`, a `@fuzdev/fuz_schema` schema. */
export const AuditLogListOutput = object({
	events: array(AuditLogEventWithUsernamesJson)
});
export type AuditLogListOutput = Infer<typeof AuditLogListOutput>;

/**
 * Input for `audit_log_role_grant_history`, a `@fuzdev/fuz_schema` schema.
 * An omitted input reads as a fresh `{}`.
 */
export const AuditLogRoleGrantHistoryInput = with_default_fn(
	object({
		limit: page_limit(
			AUDIT_LOG_LIST_LIMIT_MAX,
			`Max rows to return (default ${AUDIT_LOG_DEFAULT_LIMIT}, max ${AUDIT_LOG_LIST_LIMIT_MAX}).`
		),
		offset: PageOffset,
		acting: ActingActor
	}),
	() => ({})
);
export type AuditLogRoleGrantHistoryInput = Infer<typeof AuditLogRoleGrantHistoryInput>;

/** Output for `audit_log_role_grant_history`, a `@fuzdev/fuz_schema` schema. */
export const AuditLogRoleGrantHistoryOutput = object({
	events: array(RoleGrantHistoryEventJson)
});
export type AuditLogRoleGrantHistoryOutput = Infer<typeof AuditLogRoleGrantHistoryOutput>;

/**
 * Input for `invite_create`, a `@fuzdev/fuz_schema` schema. At least one of
 * `email` / `username` must be provided: an input with neither fails with
 * `INVITE_TARGET_REQUIRED_MESSAGE`, a `check` issue at `email`. The check runs
 * only on an input whose fields all passed.
 */
export const InviteCreateInput = pipe(
	object({
		email: meta(optional(nullable(Email)), { description: 'Invitee email.' }),
		username: meta(optional(nullable(Username)), { description: 'Invitee username.' }),
		acting: ActingActor
	}),
	message(
		check_at('email', (v) => v.email != null || v.username != null),
		INVITE_TARGET_REQUIRED_MESSAGE
	)
);
export type InviteCreateInput = Infer<typeof InviteCreateInput>;

/** Output for `invite_create`, a `@fuzdev/fuz_schema` schema. */
export const InviteCreateOutput = object({
	ok: literal(true),
	invite: InviteJson
});
export type InviteCreateOutput = Infer<typeof InviteCreateOutput>;

/**
 * Input for `invite_list`, a `@fuzdev/fuz_schema` schema. An omitted input
 * reads as a fresh `{}`.
 */
export const InviteListInput = with_default_fn(object({ acting: ActingActor }), () => ({}));
export type InviteListInput = Infer<typeof InviteListInput>;

/**
 * Output for `invite_list`, a `@fuzdev/fuz_schema` schema. Uses the enriched
 * row including creator/claimer usernames.
 */
export const InviteListOutput = object({
	invites: array(InviteWithUsernamesJson)
});
export type InviteListOutput = Infer<typeof InviteListOutput>;

/** Input for `invite_delete`, a `@fuzdev/fuz_schema` schema. */
export const InviteDeleteInput = object({
	invite_id: meta(Uuid, { description: 'Invite to delete. Must be unclaimed.' }),
	acting: ActingActor
});
export type InviteDeleteInput = Infer<typeof InviteDeleteInput>;

/** Output for `invite_delete`, a `@fuzdev/fuz_schema` schema. */
export const InviteDeleteOutput = object({
	ok: literal(true)
});
export type InviteDeleteOutput = Infer<typeof InviteDeleteOutput>;

/**
 * Input for `app_settings_get`, a `@fuzdev/fuz_schema` schema. An omitted
 * input reads as a fresh `{}`.
 */
export const AppSettingsGetInput = with_default_fn(object({ acting: ActingActor }), () => ({}));
export type AppSettingsGetInput = Infer<typeof AppSettingsGetInput>;

/** Output for `app_settings_get`, a `@fuzdev/fuz_schema` schema. */
export const AppSettingsGetOutput = object({
	settings: AppSettingsWithUsernameJson
});
export type AppSettingsGetOutput = Infer<typeof AppSettingsGetOutput>;

/** Input for `app_settings_update`, a `@fuzdev/fuz_schema` schema. */
export const AppSettingsUpdateInput = object({
	open_signup: meta(boolean, { description: 'New value for the open signup toggle.' }),
	acting: ActingActor
});
export type AppSettingsUpdateInput = Infer<typeof AppSettingsUpdateInput>;

/** Output for `app_settings_update`, a `@fuzdev/fuz_schema` schema. */
export const AppSettingsUpdateOutput = object({
	ok: literal(true),
	settings: AppSettingsWithUsernameJson
});
export type AppSettingsUpdateOutput = Infer<typeof AppSettingsUpdateOutput>;

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
 * `account_undelete` is itself admin-gated), and no web path re-grants admin.
 * Soft-deleted admins don't count toward the tally (they can't log in), and
 * the count locks the rows it counted, so two removals racing for the last
 * two admins can't both pass. Mirrors the Rust
 * `ERROR_CANNOT_DELETE_LAST_ADMIN`.
 */
export const ERROR_CANNOT_DELETE_LAST_ADMIN = 'cannot_delete_last_admin' as const;

/**
 * Input for `account_delete` (soft delete), a `@fuzdev/fuz_schema` schema.
 * `account_id` is optional — omitted (or equal to the caller's own account)
 * is a self-delete; a different account requires the admin role
 * (handler-enforced elevation, like `role_grant_offer_list`). An omitted
 * input reads as a fresh `{}`.
 */
export const AccountDeleteInput = with_default_fn(
	object({
		account_id: meta(optional(nullable(Uuid)), {
			description: 'Account to soft-delete. Omit for self-delete; another account requires admin.'
		}),
		acting: ActingActor
	}),
	() => ({})
);
export type AccountDeleteInput = Infer<typeof AccountDeleteInput>;

/** Output for `account_delete`, a `@fuzdev/fuz_schema` schema. */
export const AccountDeleteOutput = object({
	ok: literal(true),
	deleted: boolean
});
export type AccountDeleteOutput = Infer<typeof AccountDeleteOutput>;

/**
 * Input for `account_purge` (hard, irreversible delete), a
 * `@fuzdev/fuz_schema` schema. Keeper-only.
 */
export const AccountPurgeInput = object({
	account_id: meta(Uuid, { description: 'Account to hard-purge.' }),
	confirm: meta(optional(boolean), {
		description: 'Must be `true` — fail-loud guard against an accidental irreversible purge.'
	}),
	acting: ActingActor
});
export type AccountPurgeInput = Infer<typeof AccountPurgeInput>;

/** Output for `account_purge`, a `@fuzdev/fuz_schema` schema. */
export const AccountPurgeOutput = object({
	ok: literal(true),
	purged: boolean
});
export type AccountPurgeOutput = Infer<typeof AccountPurgeOutput>;

/**
 * Input for `account_undelete` (reactivation), a `@fuzdev/fuz_schema`
 * schema. `account_id` is required — unlike `account_delete` there is no
 * self path: a soft-deleted account can't authenticate (auth resolution
 * excludes it, sessions are revoked), so reactivation is always an admin
 * acting on another account.
 */
export const AccountUndeleteInput = object({
	account_id: meta(Uuid, { description: 'Soft-deleted account to reactivate.' }),
	acting: ActingActor
});
export type AccountUndeleteInput = Infer<typeof AccountUndeleteInput>;

/** Output for `account_undelete`, a `@fuzdev/fuz_schema` schema. */
export const AccountUndeleteOutput = object({
	ok: literal(true),
	undeleted: boolean
});
export type AccountUndeleteOutput = Infer<typeof AccountUndeleteOutput>;

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
 * admin role (handler-enforced elevation). The self path is session-only,
 * also handler-enforced — the spec declares no `credential_types` so an
 * admin deleting another account keeps any credential, and a self-delete
 * over an API or daemon token gets the dispatcher's own 403
 * `credential_type_required` (`required_credential_types: ['session']`),
 * ahead of the keeper / last-admin guards. No `admin_` prefix — the
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
