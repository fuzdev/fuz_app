/**
 * Admin RPC action handlers — admin-only operations exposed on the JSON-RPC surface.
 *
 * Four action categories:
 *
 * - Account management: `admin_account_list`, `admin_session_list`,
 *   `admin_session_revoke_all`, `admin_token_revoke_all`.
 * - Audit log reads: `audit_log_list`, `audit_log_permit_history`.
 * - Invite CRUD: `invite_create`, `invite_list`, `invite_delete`.
 * - App settings: `app_settings_get`, `app_settings_update` (registered only
 *   when `AdminActionOptions.app_settings` is provided — the mutable ref is
 *   owned by the server context and shared with signup middleware).
 *
 * The action specs themselves live in `auth/admin_action_specs.ts`. Mutations
 * emit matching audit events via `audit_log_fire_and_forget`.
 *
 * Authorization is declared at the spec level (`auth: {role: 'admin'}`) so
 * the RPC dispatcher enforces it before the handler runs and the generated
 * surface accurately reports the requirement. `permit_revoke` in
 * `auth/permit_offer_actions.ts` uses the same spec-level pattern even though its
 * sibling methods are authenticated-but-not-admin — the dispatcher checks
 * auth per-spec, so mixed-auth endpoints compose cleanly. Handler-level
 * gates are reserved for input-dependent elevation (e.g.
 * `permit_offer_list`/`_history` elevate to admin only when the caller
 * passes an `account_id` other than their own — an input-dependent check
 * the spec can't express).
 *
 * @module
 */

import {
	rpc_action,
	rpc_actor_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction,
} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {BUILTIN_ROLE_OPTIONS, type RoleSchemaResult} from './role_schema.js';
import {
	query_account_by_email,
	query_account_by_id,
	query_account_by_username,
	query_admin_account_list,
} from './account_queries.js';
import {
	query_session_list_all_active,
	query_session_revoke_all_for_account,
} from './session_queries.js';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.js';
import {
	audit_log_fire_and_forget,
	query_audit_log_list_permit_history,
	query_audit_log_list_with_usernames,
} from './audit_log_queries.js';
import {AUDIT_LOG_DEFAULT_LIMIT} from './audit_log_schema.js';
import {
	query_create_invite,
	query_invite_delete_unclaimed,
	query_invite_list_all_with_usernames,
} from './invite_queries.js';
import {type AppSettings} from './app_settings_schema.js';
import {
	query_app_settings_load_with_username,
	query_app_settings_update,
} from './app_settings_queries.js';
import type {AuditEmitDeps} from './deps.js';
import {is_pg_unique_violation} from '../db/pg_error.js';
import {
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_MISSING_IDENTIFIER,
	ERROR_INVITE_NOT_FOUND,
} from '../http/error_schemas.js';
import {
	admin_account_list_action_spec,
	admin_session_list_action_spec,
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	audit_log_list_action_spec,
	audit_log_permit_history_action_spec,
	invite_create_action_spec,
	invite_list_action_spec,
	invite_delete_action_spec,
	app_settings_get_action_spec,
	app_settings_update_action_spec,
	type AdminAccountListInput,
	type AdminAccountListOutput,
	type AdminSessionListInput,
	type AdminSessionListOutput,
	type AdminSessionRevokeAllInput,
	type AdminSessionRevokeAllOutput,
	type AdminTokenRevokeAllInput,
	type AdminTokenRevokeAllOutput,
	type AuditLogListInput,
	type AuditLogListOutput,
	type AuditLogPermitHistoryInput,
	type AuditLogPermitHistoryOutput,
	type InviteCreateInput,
	type InviteCreateOutput,
	type InviteListInput,
	type InviteListOutput,
	type InviteDeleteInput,
	type InviteDeleteOutput,
	type AppSettingsGetInput,
	type AppSettingsGetOutput,
	type AppSettingsUpdateInput,
	type AppSettingsUpdateOutput,
} from './admin_action_specs.js';

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
 * Aliases the shared `AuditEmitDeps` (the `log` / `on_audit_event` /
 * optional `audit_log_config` slice every audit-emitting site picks).
 * `log` drives RPC-internal error logging; `on_audit_event` is wired by
 * the two revoke-all mutations so SSE fan-out mirrors the former
 * REST-route behavior; `audit_log_config` is consumed by
 * `audit_log_fire_and_forget`.
 */
export type AdminActionDeps = AuditEmitDeps;

/**
 * Create the admin-only RPC actions.
 *
 * @param deps - `AdminActionDeps` slice of `AppDeps` (`log`, `on_audit_event`, optional `audit_log_config`)
 * @param options - role schema for `grantable_roles` derivation
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 * @mutates `options.app_settings` ref - `app_settings_update` writes `open_signup`, `updated_at`, and `updated_by` so signup middleware reads without a DB round trip
 */
export const create_admin_actions = (
	deps: AdminActionDeps,
	options: AdminActionOptions = {},
): Array<RpcAction> => {
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

	const session_list_handler = async (
		_input: AdminSessionListInput,
		ctx: ActionContext,
	): Promise<AdminSessionListOutput> => {
		const sessions = await query_session_list_all_active(ctx);
		return {sessions};
	};

	const session_revoke_all_handler = async (
		input: AdminSessionRevokeAllInput,
		ctx: ActionActorContext,
	): Promise<AdminSessionRevokeAllOutput> => {
		const auth = ctx.auth;
		const account = await query_account_by_id(ctx, input.account_id);
		if (!account) {
			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'session_revoke_all',
					outcome: 'failure',
					account_id: auth.account.id,
					// `target_account_id` is null: the FK to `account` would reject
					// a probe for a non-existent id. The probed value is preserved
					// under `metadata.attempted_account_id` for forensics.
					target_account_id: null,
					ip: ctx.client_ip,
					metadata: {
						reason: ERROR_ACCOUNT_NOT_FOUND,
						attempted_account_id: input.account_id,
					},
				},
				deps,
			);
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const count = await query_session_revoke_all_for_account(ctx, input.account_id);
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'session_revoke_all',
				account_id: auth.account.id,
				target_account_id: input.account_id,
				ip: ctx.client_ip,
				metadata: {count},
			},
			deps,
		);
		return {ok: true, count};
	};

	const token_revoke_all_handler = async (
		input: AdminTokenRevokeAllInput,
		ctx: ActionActorContext,
	): Promise<AdminTokenRevokeAllOutput> => {
		const auth = ctx.auth;
		const account = await query_account_by_id(ctx, input.account_id);
		if (!account) {
			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'token_revoke_all',
					outcome: 'failure',
					account_id: auth.account.id,
					// See `session_revoke_all_handler` — FK forces null here; the
					// probed id lives under `metadata.attempted_account_id`.
					target_account_id: null,
					ip: ctx.client_ip,
					metadata: {
						reason: ERROR_ACCOUNT_NOT_FOUND,
						attempted_account_id: input.account_id,
					},
				},
				deps,
			);
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const count = await query_revoke_all_api_tokens_for_account(ctx, input.account_id);
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'token_revoke_all',
				account_id: auth.account.id,
				target_account_id: input.account_id,
				ip: ctx.client_ip,
				metadata: {count},
			},
			deps,
		);
		return {ok: true, count};
	};

	const audit_log_list_handler = async (
		input: AuditLogListInput,
		ctx: ActionContext,
	): Promise<AuditLogListOutput> => {
		const events = await query_audit_log_list_with_usernames(ctx, {
			event_type: input.event_type ?? undefined,
			outcome: input.outcome ?? undefined,
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
		ctx: ActionActorContext,
	): Promise<InviteCreateOutput> => {
		const auth = ctx.auth;
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
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {invite_id: invite.id, email, username},
			},
			deps,
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
		ctx: ActionActorContext,
	): Promise<InviteDeleteOutput> => {
		const auth = ctx.auth;
		const deleted = await query_invite_delete_unclaimed(ctx, input.invite_id);
		if (!deleted) {
			throw jsonrpc_errors.not_found('invite', {reason: ERROR_INVITE_NOT_FOUND});
		}
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'invite_delete',
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {invite_id: input.invite_id},
			},
			deps,
		);
		return {ok: true};
	};

	const actions: Array<RpcAction> = [
		rpc_action(admin_account_list_action_spec, account_list_handler),
		rpc_action(admin_session_list_action_spec, session_list_handler),
		rpc_actor_action(admin_session_revoke_all_action_spec, session_revoke_all_handler),
		rpc_actor_action(admin_token_revoke_all_action_spec, token_revoke_all_handler),
		rpc_action(audit_log_list_action_spec, audit_log_list_handler),
		rpc_action(audit_log_permit_history_action_spec, audit_log_permit_history_handler),
		rpc_actor_action(invite_create_action_spec, invite_create_handler),
		rpc_action(invite_list_action_spec, invite_list_handler),
		rpc_actor_action(invite_delete_action_spec, invite_delete_handler),
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
			ctx: ActionActorContext,
		): Promise<AppSettingsUpdateOutput> => {
			const auth = ctx.auth;
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
					account_id: auth.account.id,
					ip: ctx.client_ip,
					metadata: {
						setting: 'open_signup',
						old_value,
						new_value: input.open_signup,
					},
				},
				deps,
			);
			const settings = await query_app_settings_load_with_username(ctx);
			return {ok: true, settings};
		};

		actions.push(
			rpc_action(app_settings_get_action_spec, app_settings_get_handler),
			rpc_actor_action(app_settings_update_action_spec, app_settings_update_handler),
		);
	}

	return actions;
};
