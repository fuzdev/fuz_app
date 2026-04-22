/**
 * Admin RPC actions — admin-only operations exposed on the JSON-RPC surface.
 *
 * Four action categories:
 *
 * - Account management: `admin_account_list`, `admin_session_revoke_all`,
 *   `admin_token_revoke_all`.
 * - Audit log reads: `audit_log_list`, `audit_log_permit_history`.
 * - Invite CRUD: `invite_create`, `invite_list`, `invite_delete`.
 * - App settings: `app_settings_get`, `app_settings_update` (registered only
 *   when `AdminActionOptions.app_settings` is provided — the mutable ref is
 *   owned by the server context and shared with signup middleware).
 *
 * Mutations emit matching audit events via `audit_log_fire_and_forget`.
 *
 * Authorization is declared at the spec level (`auth: {role: 'admin'}`) so
 * the RPC dispatcher enforces it before the handler runs and the generated
 * surface accurately reports the requirement. This differs from
 * `permit_revoke` in `permit_offer_actions.ts` (admin enforced in the
 * handler) because that file hosts a mix of authenticated-but-not-admin
 * methods on the same endpoint; this module is admin-only at the method
 * level.
 *
 * @module
 */

import {z} from 'zod';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import type {ActionContext, RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {BUILTIN_ROLE_OPTIONS, ROLE_ADMIN, RoleName, type RoleSchemaResult} from './role_schema.js';
import {AdminAccountEntryJson, Email, Username} from './account_schema.js';
import {
	query_account_by_email,
	query_account_by_id,
	query_account_by_username,
	query_admin_account_list,
} from './account_queries.js';
import {query_session_revoke_all_for_account} from './session_queries.js';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.js';
import {
	AUDIT_LOG_DEFAULT_LIMIT,
	audit_log_fire_and_forget,
	query_audit_log_list_permit_history,
	query_audit_log_list_with_usernames,
} from './audit_log_queries.js';
import {
	AuditEventType,
	AuditLogEventWithUsernamesJson,
	PermitHistoryEventJson,
} from './audit_log_schema.js';
import {InviteJson, InviteWithUsernamesJson} from './invite_schema.js';
import {
	query_create_invite,
	query_invite_delete_unclaimed,
	query_invite_list_all_with_usernames,
} from './invite_queries.js';
import {AppSettingsWithUsernameJson, type AppSettings} from './app_settings_schema.js';
import {
	query_app_settings_load_with_username,
	query_app_settings_update,
} from './app_settings_queries.js';
import type {RouteFactoryDeps} from './deps.js';
import {Uuid} from '../uuid.js';
import {is_pg_unique_violation} from '../db/pg_error.js';
import {
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_MISSING_IDENTIFIER,
	ERROR_INVITE_NOT_FOUND,
} from '../http/error_schemas.js';

/** Max audit-log page size. Mirrors the former REST route's clamp. */
const AUDIT_LOG_LIST_LIMIT_MAX = 200;

// -- Input/output schemas ---------------------------------------------------

/** Input for `admin_account_list`. No parameters — the caller is the subject. */
export const AdminAccountListInput = z.null();
export type AdminAccountListInput = z.infer<typeof AdminAccountListInput>;

/** Output for `admin_account_list`. */
export const AdminAccountListOutput = z.strictObject({
	accounts: z.array(AdminAccountEntryJson),
	grantable_roles: z.array(RoleName),
});
export type AdminAccountListOutput = z.infer<typeof AdminAccountListOutput>;

/** Input for `admin_session_revoke_all`. */
export const AdminSessionRevokeAllInput = z.strictObject({
	account_id: Uuid.meta({description: 'Account whose sessions to revoke.'}),
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
export const AuditLogListInput = z.strictObject({
	event_type: AuditEventType.nullish().meta({description: 'Filter by event type.'}),
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
});
export type AuditLogListInput = z.infer<typeof AuditLogListInput>;

/** Output for `audit_log_list`. */
export const AuditLogListOutput = z.strictObject({
	events: z.array(AuditLogEventWithUsernamesJson),
});
export type AuditLogListOutput = z.infer<typeof AuditLogListOutput>;

/** Input for `audit_log_permit_history`. */
export const AuditLogPermitHistoryInput = z.strictObject({
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
});
export type AuditLogPermitHistoryInput = z.infer<typeof AuditLogPermitHistoryInput>;

/** Output for `audit_log_permit_history`. */
export const AuditLogPermitHistoryOutput = z.strictObject({
	events: z.array(PermitHistoryEventJson),
});
export type AuditLogPermitHistoryOutput = z.infer<typeof AuditLogPermitHistoryOutput>;

/** Input for `invite_create`. At least one of `email` / `username` must be provided. */
export const InviteCreateInput = z.strictObject({
	email: Email.nullish().meta({description: 'Invitee email.'}),
	username: Username.nullish().meta({description: 'Invitee username.'}),
});
export type InviteCreateInput = z.infer<typeof InviteCreateInput>;

/** Output for `invite_create`. */
export const InviteCreateOutput = z.strictObject({
	ok: z.literal(true),
	invite: InviteJson,
});
export type InviteCreateOutput = z.infer<typeof InviteCreateOutput>;

/** Input for `invite_list`. */
export const InviteListInput = z.null();
export type InviteListInput = z.infer<typeof InviteListInput>;

/** Output for `invite_list`. Uses the enriched row including creator/claimer usernames. */
export const InviteListOutput = z.strictObject({
	invites: z.array(InviteWithUsernamesJson),
});
export type InviteListOutput = z.infer<typeof InviteListOutput>;

/** Input for `invite_delete`. */
export const InviteDeleteInput = z.strictObject({
	invite_id: Uuid.meta({description: 'Invite to delete. Must be unclaimed.'}),
});
export type InviteDeleteInput = z.infer<typeof InviteDeleteInput>;

/** Output for `invite_delete`. */
export const InviteDeleteOutput = z.strictObject({
	ok: z.literal(true),
});
export type InviteDeleteOutput = z.infer<typeof InviteDeleteOutput>;

/** Input for `app_settings_get`. No parameters. */
export const AppSettingsGetInput = z.null();
export type AppSettingsGetInput = z.infer<typeof AppSettingsGetInput>;

/** Output for `app_settings_get`. */
export const AppSettingsGetOutput = z.strictObject({
	settings: AppSettingsWithUsernameJson,
});
export type AppSettingsGetOutput = z.infer<typeof AppSettingsGetOutput>;

/** Input for `app_settings_update`. */
export const AppSettingsUpdateInput = z.strictObject({
	open_signup: z.boolean().meta({description: 'New value for the open signup toggle.'}),
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
	auth: {role: ROLE_ADMIN},
	side_effects: false,
	input: AdminAccountListInput,
	output: AdminAccountListOutput,
	async: true,
	description: 'List all accounts with their actors, permits, and pending offers. Admin-only.',
} satisfies RequestResponseActionSpec;

export const admin_session_revoke_all_action_spec = {
	method: 'admin_session_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
	side_effects: true,
	input: AdminSessionRevokeAllInput,
	output: AdminSessionRevokeAllOutput,
	async: true,
	description: 'Revoke all sessions for an account. Admin-only.',
} satisfies RequestResponseActionSpec;

export const admin_token_revoke_all_action_spec = {
	method: 'admin_token_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
	side_effects: true,
	input: AdminTokenRevokeAllInput,
	output: AdminTokenRevokeAllOutput,
	async: true,
	description: 'Revoke all API tokens for an account. Admin-only.',
} satisfies RequestResponseActionSpec;

export const audit_log_list_action_spec = {
	method: 'audit_log_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
	side_effects: false,
	input: AuditLogListInput,
	output: AuditLogListOutput,
	async: true,
	description: 'List audit log events with optional filters. Admin-only.',
} satisfies RequestResponseActionSpec;

export const audit_log_permit_history_action_spec = {
	method: 'audit_log_permit_history',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
	side_effects: false,
	input: AuditLogPermitHistoryInput,
	output: AuditLogPermitHistoryOutput,
	async: true,
	description: 'List permit grant and revoke events with usernames. Admin-only.',
} satisfies RequestResponseActionSpec;

export const invite_create_action_spec = {
	method: 'invite_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
	side_effects: true,
	input: InviteCreateInput,
	output: InviteCreateOutput,
	async: true,
	description: 'Create an invite addressed to an email, username, or both. Admin-only.',
} satisfies RequestResponseActionSpec;

export const invite_list_action_spec = {
	method: 'invite_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
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
	auth: {role: ROLE_ADMIN},
	side_effects: true,
	input: InviteDeleteInput,
	output: InviteDeleteOutput,
	async: true,
	description: 'Delete an unclaimed invite. Admin-only.',
} satisfies RequestResponseActionSpec;

export const app_settings_get_action_spec = {
	method: 'app_settings_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: ROLE_ADMIN},
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
	auth: {role: ROLE_ADMIN},
	side_effects: true,
	input: AppSettingsUpdateInput,
	output: AppSettingsUpdateOutput,
	async: true,
	description: 'Update global app settings (currently just the open signup toggle). Admin-only.',
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
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	audit_log_list_action_spec,
	audit_log_permit_history_action_spec,
	invite_create_action_spec,
	invite_list_action_spec,
	invite_delete_action_spec,
	app_settings_get_action_spec,
	app_settings_update_action_spec,
];

// -- Factory ----------------------------------------------------------------

/** Options for `create_admin_actions`. */
export interface AdminActionOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin
	 * roles only. Used to derive `grantable_roles` (the `web_grantable`
	 * subset) returned by `admin_account_list`.
	 */
	roles?: RoleSchemaResult;
	/**
	 * Mutable in-memory app settings ref — typically `ctx.app_settings` from
	 * `AppServerContext`. When provided, the factory wires the
	 * `app_settings_get` and `app_settings_update` handlers; the update
	 * handler mutates this ref so signup middleware reads the new value
	 * without a DB round trip. When omitted, those two methods have no
	 * handler and RPC dispatch returns `method_not_found`.
	 */
	app_settings?: AppSettings;
}

/**
 * Dependencies for `create_admin_actions`.
 *
 * Shares shape with `PermitOfferActionDeps` so consumers can pass the same
 * deps to both factories. `log` drives RPC-internal error logging;
 * `on_audit_event` is wired by the two revoke-all mutations so SSE fan-out
 * mirrors the former REST-route behavior.
 */
export type AdminActionDeps = Pick<RouteFactoryDeps, 'log' | 'on_audit_event'>;

/**
 * Create the admin-only RPC actions.
 *
 * @param deps - stateless capabilities (log, on_audit_event)
 * @param options - role schema for `grantable_roles` derivation
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_admin_actions = (
	deps: AdminActionDeps,
	options: AdminActionOptions = {},
): Array<RpcAction> => {
	const {log, on_audit_event} = deps;
	const role_options = options.roles?.role_options ?? BUILTIN_ROLE_OPTIONS;
	const grantable_roles: Array<string> = [];
	for (const [name, rc] of role_options) {
		if (rc.web_grantable) grantable_roles.push(name);
	}

	const account_list_handler = async (
		_input: AdminAccountListInput,
		ctx: ActionContext,
	): Promise<AdminAccountListOutput> => {
		const accounts = await query_admin_account_list(ctx);
		return {accounts, grantable_roles};
	};

	const session_revoke_all_handler = async (
		input: AdminSessionRevokeAllInput,
		ctx: ActionContext,
	): Promise<AdminSessionRevokeAllOutput> => {
		const auth = ctx.auth!;
		const account = await query_account_by_id(ctx, input.account_id);
		if (!account) {
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const count = await query_session_revoke_all_for_account(ctx, input.account_id);
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'session_revoke_all',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: input.account_id,
				ip: null,
				metadata: {count},
			},
			log,
			on_audit_event,
		);
		return {ok: true, count};
	};

	const token_revoke_all_handler = async (
		input: AdminTokenRevokeAllInput,
		ctx: ActionContext,
	): Promise<AdminTokenRevokeAllOutput> => {
		const auth = ctx.auth!;
		const account = await query_account_by_id(ctx, input.account_id);
		if (!account) {
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const count = await query_revoke_all_api_tokens_for_account(ctx, input.account_id);
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'token_revoke_all',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: input.account_id,
				ip: null,
				metadata: {count},
			},
			log,
			on_audit_event,
		);
		return {ok: true, count};
	};

	const audit_log_list_handler = async (
		input: AuditLogListInput,
		ctx: ActionContext,
	): Promise<AuditLogListOutput> => {
		const events = await query_audit_log_list_with_usernames(ctx, {
			event_type: input.event_type ?? undefined,
			account_id: input.account_id ?? undefined,
			limit: input.limit ?? AUDIT_LOG_DEFAULT_LIMIT,
			offset: input.offset ?? 0,
			since_seq: input.since_seq ?? undefined,
		});
		return {events};
	};

	const audit_log_permit_history_handler = async (
		input: AuditLogPermitHistoryInput,
		ctx: ActionContext,
	): Promise<AuditLogPermitHistoryOutput> => {
		const events = await query_audit_log_list_permit_history(
			ctx,
			input.limit ?? AUDIT_LOG_DEFAULT_LIMIT,
			input.offset ?? 0,
		);
		return {events};
	};

	const invite_create_handler = async (
		input: InviteCreateInput,
		ctx: ActionContext,
	): Promise<InviteCreateOutput> => {
		const auth = ctx.auth!;
		const email = input.email ?? null;
		const username = input.username ?? null;

		if (!email && !username) {
			throw jsonrpc_errors.invalid_params('invite must specify email or username', {
				reason: ERROR_INVITE_MISSING_IDENTIFIER,
			});
		}

		if (username) {
			const existing = await query_account_by_username(ctx, username);
			if (existing) {
				throw jsonrpc_errors.conflict('an account already exists with that username', {
					reason: ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
				});
			}
		}
		if (email) {
			const existing = await query_account_by_email(ctx, email);
			if (existing) {
				throw jsonrpc_errors.conflict('an account already exists with that email', {
					reason: ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
				});
			}
		}

		let invite;
		try {
			invite = await query_create_invite(ctx, {
				email,
				username,
				created_by: auth.actor.id,
			});
		} catch (err: unknown) {
			if (is_pg_unique_violation(err)) {
				throw jsonrpc_errors.conflict('an unclaimed invite already exists', {
					reason: ERROR_INVITE_DUPLICATE,
				});
			}
			throw err;
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'invite_create',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: null,
				metadata: {invite_id: invite.id, email, username},
			},
			log,
			on_audit_event,
		);
		return {ok: true, invite};
	};

	const invite_list_handler = async (
		_input: InviteListInput,
		ctx: ActionContext,
	): Promise<InviteListOutput> => {
		const invites = await query_invite_list_all_with_usernames(ctx);
		return {invites};
	};

	const invite_delete_handler = async (
		input: InviteDeleteInput,
		ctx: ActionContext,
	): Promise<InviteDeleteOutput> => {
		const auth = ctx.auth!;
		const deleted = await query_invite_delete_unclaimed(ctx, input.invite_id);
		if (!deleted) {
			throw jsonrpc_errors.not_found('invite', {reason: ERROR_INVITE_NOT_FOUND});
		}
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'invite_delete',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: null,
				metadata: {invite_id: input.invite_id},
			},
			log,
			on_audit_event,
		);
		return {ok: true};
	};

	const actions: Array<RpcAction> = [
		{
			spec: admin_account_list_action_spec,
			handler: account_list_handler as RpcAction['handler'],
		},
		{
			spec: admin_session_revoke_all_action_spec,
			handler: session_revoke_all_handler as RpcAction['handler'],
		},
		{
			spec: admin_token_revoke_all_action_spec,
			handler: token_revoke_all_handler as RpcAction['handler'],
		},
		{
			spec: audit_log_list_action_spec,
			handler: audit_log_list_handler as RpcAction['handler'],
		},
		{
			spec: audit_log_permit_history_action_spec,
			handler: audit_log_permit_history_handler as RpcAction['handler'],
		},
		{
			spec: invite_create_action_spec,
			handler: invite_create_handler as RpcAction['handler'],
		},
		{
			spec: invite_list_action_spec,
			handler: invite_list_handler as RpcAction['handler'],
		},
		{
			spec: invite_delete_action_spec,
			handler: invite_delete_handler as RpcAction['handler'],
		},
	];

	const {app_settings} = options;
	if (app_settings) {
		const app_settings_get_handler = async (
			_input: AppSettingsGetInput,
			ctx: ActionContext,
		): Promise<AppSettingsGetOutput> => {
			const settings = await query_app_settings_load_with_username(ctx);
			return {settings};
		};

		const app_settings_update_handler = async (
			input: AppSettingsUpdateInput,
			ctx: ActionContext,
		): Promise<AppSettingsUpdateOutput> => {
			const auth = ctx.auth!;
			const old_value = app_settings.open_signup;
			const updated = await query_app_settings_update(ctx, input.open_signup, auth.actor.id);

			// Mutate the in-memory ref so signup middleware reads the new value
			// without a DB round trip.
			app_settings.open_signup = updated.open_signup;
			app_settings.updated_at = updated.updated_at;
			app_settings.updated_by = updated.updated_by;

			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'app_settings_update',
					actor_id: auth.actor.id,
					account_id: auth.account.id,
					ip: null,
					metadata: {
						setting: 'open_signup',
						old_value,
						new_value: input.open_signup,
					},
				},
				log,
				on_audit_event,
			);
			const settings = await query_app_settings_load_with_username(ctx);
			return {ok: true, settings};
		};

		actions.push(
			{
				spec: app_settings_get_action_spec,
				handler: app_settings_get_handler as RpcAction['handler'],
			},
			{
				spec: app_settings_update_action_spec,
				handler: app_settings_update_handler as RpcAction['handler'],
			},
		);
	}

	return actions;
};
