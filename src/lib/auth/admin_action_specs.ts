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

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {ROLE_ADMIN, RoleName} from './role_schema.js';
import {AdminAccountEntryJson} from './account_schema.js';
import {Email, Username} from '../primitive_schemas.js';
import {ActingActor} from '../http/auth_shape.js';
import {
	AdminSessionJson,
	AUDIT_LOG_DEFAULT_LIMIT,
	AuditEventTypeName,
	AuditLogEventWithUsernamesJson,
	AuditOutcome,
	RoleGrantHistoryEventJson,
} from './audit_log_schema.js';
import {InviteJson, InviteWithUsernamesJson} from './invite_schema.js';
import {AppSettingsWithUsernameJson} from './app_settings_schema.js';

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
				description: `Max accounts to return (default ${ADMIN_ACCOUNT_LIST_DEFAULT_LIMIT}, max ${ADMIN_ACCOUNT_LIST_LIMIT_MAX}).`,
			}),
		offset: z.number().int().min(0).nullish().meta({description: 'Pagination offset.'}),
	})
	.default({});
export type AdminAccountListInput = z.infer<typeof AdminAccountListInput>;

/** Output for `admin_account_list`. */
export const AdminAccountListOutput = z.strictObject({
	accounts: z.array(AdminAccountEntryJson),
	grantable_roles: z.array(RoleName),
});
export type AdminAccountListOutput = z.infer<typeof AdminAccountListOutput>;

/** Input for `admin_session_list`. */
export const AdminSessionListInput = z
	.strictObject({
		acting: ActingActor,
	})
	.default({});
export type AdminSessionListInput = z.infer<typeof AdminSessionListInput>;

/** Output for `admin_session_list`. Cross-account listing; fan-out already scoped by role auth. */
export const AdminSessionListOutput = z.strictObject({
	sessions: z.array(AdminSessionJson),
});
export type AdminSessionListOutput = z.infer<typeof AdminSessionListOutput>;

/** Input for `admin_session_revoke_all`. */
export const AdminSessionRevokeAllInput = z.strictObject({
	account_id: Uuid.meta({description: 'Account whose sessions to revoke.'}),
	acting: ActingActor,
});
export type AdminSessionRevokeAllInput = z.infer<typeof AdminSessionRevokeAllInput>;

/** Output for `admin_session_revoke_all`. */
export const AdminSessionRevokeAllOutput = z.strictObject({
	ok: z.literal(true),
	count: z.number(),
});
export type AdminSessionRevokeAllOutput = z.infer<typeof AdminSessionRevokeAllOutput>;

/** Input for `admin_token_revoke_all`. */
export const AdminTokenRevokeAllInput = z.strictObject({
	account_id: Uuid.meta({description: 'Account whose API tokens to revoke.'}),
	acting: ActingActor,
});
export type AdminTokenRevokeAllInput = z.infer<typeof AdminTokenRevokeAllInput>;

/** Output for `admin_token_revoke_all`. */
export const AdminTokenRevokeAllOutput = z.strictObject({
	ok: z.literal(true),
	count: z.number(),
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
				'Filter by event type. Accepts builtin or consumer-registered names (regex-validated).',
		}),
		outcome: AuditOutcome.nullish().meta({
			description: 'Filter by outcome (`success` or `failure`).',
		}),
		account_id: Uuid.nullish().meta({description: 'Filter by actor account id.'}),
		limit: z
			.number()
			.int()
			.min(1)
			.max(AUDIT_LOG_LIST_LIMIT_MAX)
			.nullish()
			.meta({
				description: `Max rows to return (default ${AUDIT_LOG_DEFAULT_LIMIT}, max ${AUDIT_LOG_LIST_LIMIT_MAX}).`,
			}),
		offset: z.number().int().min(0).nullish().meta({description: 'Pagination offset.'}),
		since_seq: z.number().int().min(0).nullish().meta({
			description: 'Gap-fill from this seq forward. Used for SSE reconnection.',
		}),
		acting: ActingActor,
	})
	.default({});
export type AuditLogListInput = z.infer<typeof AuditLogListInput>;

/** Output for `audit_log_list`. */
export const AuditLogListOutput = z.strictObject({
	events: z.array(AuditLogEventWithUsernamesJson),
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
				description: `Max rows to return (default ${AUDIT_LOG_DEFAULT_LIMIT}, max ${AUDIT_LOG_LIST_LIMIT_MAX}).`,
			}),
		offset: z.number().int().min(0).nullish().meta({description: 'Pagination offset.'}),
		acting: ActingActor,
	})
	.default({});
export type AuditLogRoleGrantHistoryInput = z.infer<typeof AuditLogRoleGrantHistoryInput>;

/** Output for `audit_log_role_grant_history`. */
export const AuditLogRoleGrantHistoryOutput = z.strictObject({
	events: z.array(RoleGrantHistoryEventJson),
});
export type AuditLogRoleGrantHistoryOutput = z.infer<typeof AuditLogRoleGrantHistoryOutput>;

/** Input for `invite_create`. At least one of `email` / `username` must be provided. */
export const InviteCreateInput = z
	.strictObject({
		email: Email.nullish().meta({description: 'Invitee email.'}),
		username: Username.nullish().meta({description: 'Invitee username.'}),
		acting: ActingActor,
	})
	.refine((v) => v.email != null || v.username != null, {
		message: 'at least one of email or username is required',
		path: ['email'],
	});
export type InviteCreateInput = z.infer<typeof InviteCreateInput>;

/** Output for `invite_create`. */
export const InviteCreateOutput = z.strictObject({
	ok: z.literal(true),
	invite: InviteJson,
});
export type InviteCreateOutput = z.infer<typeof InviteCreateOutput>;

/** Input for `invite_list`. */
export const InviteListInput = z
	.strictObject({
		acting: ActingActor,
	})
	.default({});
export type InviteListInput = z.infer<typeof InviteListInput>;

/** Output for `invite_list`. Uses the enriched row including creator/claimer usernames. */
export const InviteListOutput = z.strictObject({
	invites: z.array(InviteWithUsernamesJson),
});
export type InviteListOutput = z.infer<typeof InviteListOutput>;

/** Input for `invite_delete`. */
export const InviteDeleteInput = z.strictObject({
	invite_id: Uuid.meta({description: 'Invite to delete. Must be unclaimed.'}),
	acting: ActingActor,
});
export type InviteDeleteInput = z.infer<typeof InviteDeleteInput>;

/** Output for `invite_delete`. */
export const InviteDeleteOutput = z.strictObject({
	ok: z.literal(true),
});
export type InviteDeleteOutput = z.infer<typeof InviteDeleteOutput>;

/** Input for `app_settings_get`. */
export const AppSettingsGetInput = z
	.strictObject({
		acting: ActingActor,
	})
	.default({});
export type AppSettingsGetInput = z.infer<typeof AppSettingsGetInput>;

/** Output for `app_settings_get`. */
export const AppSettingsGetOutput = z.strictObject({
	settings: AppSettingsWithUsernameJson,
});
export type AppSettingsGetOutput = z.infer<typeof AppSettingsGetOutput>;

/** Input for `app_settings_update`. */
export const AppSettingsUpdateInput = z.strictObject({
	open_signup: z.boolean().meta({description: 'New value for the open signup toggle.'}),
	acting: ActingActor,
});
export type AppSettingsUpdateInput = z.infer<typeof AppSettingsUpdateInput>;

/** Output for `app_settings_update`. */
export const AppSettingsUpdateOutput = z.strictObject({
	ok: z.literal(true),
	settings: AppSettingsWithUsernameJson,
});
export type AppSettingsUpdateOutput = z.infer<typeof AppSettingsUpdateOutput>;

// -- Action specs -----------------------------------------------------------

export const admin_account_list_action_spec = {
	method: 'admin_account_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: false,
	input: AdminAccountListInput,
	output: AdminAccountListOutput,
	async: true,
	description: 'List all accounts with their actors, role_grants, and pending offers. Admin-only.',
} satisfies RequestResponseActionSpec;

export const admin_session_list_action_spec = {
	method: 'admin_session_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: false,
	input: AdminSessionListInput,
	output: AdminSessionListOutput,
	async: true,
	description: 'List every active auth session across all accounts. Admin-only.',
} satisfies RequestResponseActionSpec;

export const admin_session_revoke_all_action_spec = {
	method: 'admin_session_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: true,
	input: AdminSessionRevokeAllInput,
	output: AdminSessionRevokeAllOutput,
	async: true,
	description: 'Revoke all sessions for an account. Admin-only.',
	rate_limit: 'account',
} satisfies RequestResponseActionSpec;

export const admin_token_revoke_all_action_spec = {
	method: 'admin_token_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: true,
	input: AdminTokenRevokeAllInput,
	output: AdminTokenRevokeAllOutput,
	async: true,
	description: 'Revoke all API tokens for an account. Admin-only.',
	rate_limit: 'account',
} satisfies RequestResponseActionSpec;

export const audit_log_list_action_spec = {
	method: 'audit_log_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: false,
	input: AuditLogListInput,
	output: AuditLogListOutput,
	async: true,
	description: 'List audit log events with optional filters. Admin-only.',
} satisfies RequestResponseActionSpec;

export const audit_log_role_grant_history_action_spec = {
	method: 'audit_log_role_grant_history',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: false,
	input: AuditLogRoleGrantHistoryInput,
	output: AuditLogRoleGrantHistoryOutput,
	async: true,
	description: 'List role_grant grant and revoke events with usernames. Admin-only.',
} satisfies RequestResponseActionSpec;

export const invite_create_action_spec = {
	method: 'invite_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: true,
	input: InviteCreateInput,
	output: InviteCreateOutput,
	async: true,
	description: 'Create an invite addressed to an email, username, or both. Admin-only.',
	rate_limit: 'account',
} satisfies RequestResponseActionSpec;

export const invite_list_action_spec = {
	method: 'invite_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: false,
	input: InviteListInput,
	output: InviteListOutput,
	async: true,
	description: 'List all invites with creator and claimer usernames. Admin-only.',
} satisfies RequestResponseActionSpec;

export const invite_delete_action_spec = {
	method: 'invite_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: true,
	input: InviteDeleteInput,
	output: InviteDeleteOutput,
	async: true,
	description: 'Delete an unclaimed invite. Admin-only.',
	rate_limit: 'account',
} satisfies RequestResponseActionSpec;

export const app_settings_get_action_spec = {
	method: 'app_settings_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: false,
	input: AppSettingsGetInput,
	output: AppSettingsGetOutput,
	async: true,
	description: 'Read global app settings. Admin-only.',
} satisfies RequestResponseActionSpec;

export const app_settings_update_action_spec = {
	method: 'app_settings_update',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
	side_effects: true,
	input: AppSettingsUpdateInput,
	output: AppSettingsUpdateOutput,
	async: true,
	description: 'Update global app settings (currently just the open signup toggle). Admin-only.',
	rate_limit: 'account',
} satisfies RequestResponseActionSpec;

/**
 * All admin action specs — a codegen-ready registry. Consumers spread this
 * into their own action-spec array to include admin methods in a typed
 * client surface. Always includes the two app-settings specs; the runtime
 * factory only wires their handlers when `AdminActionOptions.app_settings`
 * is provided.
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
	app_settings_get_action_spec,
	app_settings_update_action_spec,
];
