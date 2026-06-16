/**
 * Admin RPC action handlers — admin-only operations exposed on the JSON-RPC surface.
 *
 * Four action categories:
 *
 * - Account management: `admin_account_list`, `admin_session_list`,
 *   `admin_session_revoke_all`, `admin_token_revoke_all`.
 * - Audit log reads: `audit_log_list`, `audit_log_role_grant_history`.
 * - Invite CRUD: `invite_create`, `invite_list`, `invite_delete`.
 * - App settings: `app_settings_get`, `app_settings_update`. The update
 *   handler writes the `app_settings` row in the database; signup reads the
 *   `open_signup` toggle fresh from that row on every request, so no
 *   in-memory state is shared between this surface and signup.
 *
 * The action specs themselves live in `auth/admin_action_specs.ts`. Mutations
 * emit matching audit events via `deps.audit.emit`.
 *
 * Authorization is declared at the spec level (`auth: {role: 'admin'}`) so
 * the RPC dispatcher enforces it before the handler runs and the generated
 * surface accurately reports the requirement. `role_grant_revoke` in
 * `auth/role_grant_offer_actions.ts` uses the same spec-level pattern even though its
 * sibling methods are authenticated-but-not-admin — the dispatcher checks
 * auth per-spec, so mixed-auth endpoints compose cleanly. Handler-level
 * gates are reserved for input-dependent elevation (e.g.
 * `role_grant_offer_list`/`_history` elevate to admin only when the caller
 * passes an `account_id` other than their own — an input-dependent check
 * the spec can't express).
 *
 * @module
 */

import {rpc_action, type ActionActorContext, type RpcAction} from '../actions/action_rpc.ts';
import type {ConnectionCloser} from '../actions/connection_closer.ts';
import {jsonrpc_errors} from '../http/jsonrpc_errors.ts';
import {
	builtin_role_specs_by_name,
	list_roles_with_grant_path,
	ROLE_ADMIN,
	ROLE_KEEPER,
	type RoleSchemaResult,
} from './role_schema.ts';
import {has_role} from './request_context.ts';
import {
	query_account_has_global_role,
	query_account_has_active_global_role,
	query_count_active_accounts_with_global_role,
} from './role_grant_queries.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import {GRANT_PATH_ADMIN} from './grant_path_schema.ts';
import {
	query_account_by_email,
	query_account_by_id,
	query_account_by_username,
	query_account_soft_delete,
	query_account_undelete,
	query_actor_soft_delete,
	query_actor_undelete,
	query_actors_by_account,
	query_admin_account_list,
	query_purge_account,
} from './account_queries.ts';
import {
	query_session_list_all_active,
	query_session_revoke_all_for_account,
} from './session_queries.ts';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.ts';
import {
	query_audit_log_list_role_grant_history,
	query_audit_log_list_with_usernames,
} from './audit_log_queries.ts';
import {AUDIT_LOG_DEFAULT_LIMIT} from './audit_log_schema.ts';
import {
	query_create_invite,
	query_invite_delete_unclaimed,
	query_invite_list_all_with_usernames,
} from './invite_queries.ts';
import {
	query_app_settings_load,
	query_app_settings_load_with_username,
	query_app_settings_update,
} from './app_settings_queries.ts';
import type {RouteFactoryDeps} from './deps.ts';
import {is_pg_unique_violation} from '../db/pg_error.ts';
import {
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_NOT_FOUND,
} from '../http/error_schemas.ts';
import {
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
	app_settings_update_action_spec,
	ERROR_PURGE_NOT_CONFIRMED,
	ERROR_CANNOT_DELETE_KEEPER,
	ERROR_CANNOT_DELETE_LAST_ADMIN,
	type AccountDeleteInput,
	type AccountDeleteOutput,
	type AccountPurgeInput,
	type AccountPurgeOutput,
	type AccountUndeleteInput,
	type AccountUndeleteOutput,
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
	type AuditLogRoleGrantHistoryInput,
	type AuditLogRoleGrantHistoryOutput,
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
} from './admin_action_specs.ts';

/** Options for `create_admin_actions`. */
export interface AdminActionOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin
	 * roles only. Used to derive `grantable_roles` (the subset whose
	 * `RoleSpec.grant_paths` includes `'admin'`) returned by
	 * `admin_account_list`.
	 */
	roles?: RoleSchemaResult;
	/**
	 * Live-connection closer — when set, `admin_session_revoke_all` and
	 * `admin_token_revoke_all` handlers eagerly close affected WebSocket
	 * sockets for the target account BEFORE emitting the corresponding
	 * audit event. Mirrors the self-service surface (see
	 * `AccountActionOptions.connection_closer`). `BackendWebsocketTransport`
	 * satisfies this interface structurally. When absent, only the
	 * listener-based close (`transports_ws_auth_guard`) runs.
	 */
	connection_closer?: ConnectionCloser | null;
}

/**
 * Create the admin-only RPC actions.
 *
 * @param deps - `RouteFactoryDeps` (`log`, `audit`, …). `log` drives RPC-
 *   internal error logging; `audit.emit` writes audit rows via the captured
 *   pool. The bound emitter encapsulates `on_audit_event` fan-out and the
 *   optional `AuditLogConfig`.
 * @param options - role schema for `grantable_roles` derivation
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_admin_actions = (
	deps: Pick<RouteFactoryDeps, 'log' | 'audit'>,
	options: AdminActionOptions = {},
): Array<RpcAction> => {
	const role_specs = options.roles?.role_specs ?? builtin_role_specs_by_name;
	const grantable_roles = list_roles_with_grant_path(role_specs, GRANT_PATH_ADMIN);
	const connection_closer = options.connection_closer ?? null;

	const account_list_handler = async (
		input: AdminAccountListInput,
		ctx: ActionActorContext,
	): Promise<AdminAccountListOutput> => {
		const accounts = await query_admin_account_list(ctx, {
			limit: input.limit,
			offset: input.offset,
			include_deleted: input.include_deleted,
		});
		return {accounts, grantable_roles};
	};

	const session_list_handler = async (
		_input: AdminSessionListInput,
		ctx: ActionActorContext,
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
			deps.audit.emit(ctx, {
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
			});
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const count = await query_session_revoke_all_for_account(ctx, input.account_id);
		// Handler-side belt+suspenders — close the target account's live WS
		// sockets BEFORE the audit emit so revocation lands even if the audit
		// INSERT fails. Listener-based close (`transports_ws_auth_guard` on
		// `audit.on_event_chain`) stays as a fail-safe for out-of-band emit
		// sites. Idempotent — see `account_actions.ts::session_revoke_handler`.
		if (connection_closer) {
			connection_closer.close_sockets_for_account(input.account_id);
		}
		// TOCTOU window — admin B hard-deletes `input.account_id` between the
		// pre-check above and this emit; the FK rejects the row, the audit
		// emitter logs + swallows, and the operation goes unaudited. Bounded
		// by the audit emitter's failure logging (operator-visible) and by
		// the rarity of concurrent admin hard-deletes. Not switching to the
		// failure-shape (`target_account_id: null + metadata.attempted_account_id`)
		// because the FK linkage powers the username-join in
		// `audit_log_list_with_usernames`; losing it on every success row
		// to harden a corner case isn't worth the query-shape change.
		deps.audit.emit(ctx, {
			event_type: 'session_revoke_all',
			account_id: auth.account.id,
			target_account_id: input.account_id,
			ip: ctx.client_ip,
			metadata: {count},
		});
		return {ok: true, count};
	};

	const token_revoke_all_handler = async (
		input: AdminTokenRevokeAllInput,
		ctx: ActionActorContext,
	): Promise<AdminTokenRevokeAllOutput> => {
		const auth = ctx.auth;
		const account = await query_account_by_id(ctx, input.account_id);
		if (!account) {
			deps.audit.emit(ctx, {
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
			});
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const count = await query_revoke_all_api_tokens_for_account(ctx, input.account_id);
		// Handler-side belt+suspenders — see `session_revoke_all_handler`.
		if (connection_closer) {
			connection_closer.close_sockets_for_account(input.account_id);
		}
		// TOCTOU window — see `session_revoke_all_handler` for the rationale on
		// keeping `target_account_id` populated rather than switching to the
		// failure-shape.
		deps.audit.emit(ctx, {
			event_type: 'token_revoke_all',
			account_id: auth.account.id,
			target_account_id: input.account_id,
			ip: ctx.client_ip,
			metadata: {count},
		});
		return {ok: true, count};
	};

	const audit_log_list_handler = async (
		input: AuditLogListInput,
		ctx: ActionActorContext,
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

	const audit_log_role_grant_history_handler = async (
		input: AuditLogRoleGrantHistoryInput,
		ctx: ActionActorContext,
	): Promise<AuditLogRoleGrantHistoryOutput> => {
		const events = await query_audit_log_list_role_grant_history(
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

		deps.audit.emit(ctx, {
			event_type: 'invite_create',
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {invite_id: invite.id, email, username},
		});
		return {ok: true, invite};
	};

	const invite_list_handler = async (
		_input: InviteListInput,
		ctx: ActionActorContext,
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
		deps.audit.emit(ctx, {
			event_type: 'invite_delete',
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {invite_id: input.invite_id},
		});
		return {ok: true};
	};

	// Shared removability guard for `account_delete` / `account_purge`,
	// checked after auth + (for purge) confirm, before any mutation. Two
	// protections, each emitting a forensic `outcome: 'failure'` audit row
	// (fail-loud) before throwing 403:
	//   1. **Keeper** — the keeper account is never API-removable: auth +
	//      daemon-token resolution both pivot on it, so removing it bricks
	//      keeper/daemon auth with no recovery (keeper role is non-web-
	//      revocable and purge itself needs keeper auth). Out-of-band only.
	//   2. **Last admin** — the sole remaining *active* admin is protected
	//      (soft-deleted admins can't log in, so they don't count). Unlike
	//      the keeper guard this is keeper-recoverable, but it stops an admin
	//      tombstoning the last admin in one call.
	// A missing account holds neither role here and falls through to the
	// handler's own not-found path. `event_type` selects the audit event so
	// the failure row matches the operation in flight.
	const assert_account_removable = async (
		ctx: ActionActorContext,
		target_account_id: Uuid,
		event_type: 'account_delete' | 'account_purge',
	): Promise<void> => {
		const auth = ctx.auth;
		const deny = (
			reason: typeof ERROR_CANNOT_DELETE_KEEPER | typeof ERROR_CANNOT_DELETE_LAST_ADMIN,
			message: string,
		): never => {
			deps.audit.emit(ctx, {
				event_type,
				outcome: 'failure',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id,
				ip: ctx.client_ip,
				metadata: {reason},
			});
			throw jsonrpc_errors.forbidden(message, {reason});
		};
		const verb = event_type === 'account_purge' ? 'purge' : 'delete';
		if (await query_account_has_global_role(ctx, target_account_id, ROLE_KEEPER)) {
			deny(ERROR_CANNOT_DELETE_KEEPER, `cannot ${verb} the keeper account`);
		}
		// `_active_` variant: a tombstoned admin is already excluded from the
		// active count, so removing it can't drop the tally — guarding it would
		// falsely block (cannot_delete_last_admin) the removal of a soft-deleted
		// admin while another active admin exists. Keeper branch above stays
		// unconditional; the last-admin branch fires only for an *active* target.
		if (
			(await query_account_has_active_global_role(ctx, target_account_id, ROLE_ADMIN)) &&
			(await query_count_active_accounts_with_global_role(ctx, ROLE_ADMIN)) <= 1
		) {
			deny(ERROR_CANNOT_DELETE_LAST_ADMIN, `cannot ${verb} the last admin account`);
		}
	};

	// Soft-delete an account (reversible tombstone). Self-or-admin:
	// deleting another account requires the admin role. Tombstones the
	// account + its actor(s), revokes sessions/tokens, closes sockets, and
	// emits `account_delete` + one `actor_delete` per soft-deleted actor —
	// each carrying its identity snapshot. `delete` = soft.
	const account_delete_handler = async (
		input: AccountDeleteInput,
		ctx: ActionActorContext,
	): Promise<AccountDeleteOutput> => {
		const auth = ctx.auth;
		const target_account_id = input.account_id ?? auth.account.id;
		// Self-or-admin elevation: deleting someone else needs admin.
		if (target_account_id !== auth.account.id && !has_role(auth, ROLE_ADMIN)) {
			throw jsonrpc_errors.forbidden('cannot delete another account', {
				reason: ERROR_INSUFFICIENT_PERMISSIONS,
			});
		}
		// Keeper + last-admin guards (fail-loud, before the tombstone).
		await assert_account_removable(ctx, target_account_id, 'account_delete');
		// Snapshot actor names before the tombstone.
		const actors = await query_actors_by_account(ctx, target_account_id);
		const snapshot = await query_account_soft_delete(ctx, target_account_id, auth.actor.id);
		if (!snapshot) {
			// Missing or already soft-deleted — UUID probe key, failure audit is safe.
			deps.audit.emit(ctx, {
				event_type: 'account_delete',
				outcome: 'failure',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {reason: ERROR_ACCOUNT_NOT_FOUND, attempted_account_id: target_account_id},
			});
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const soft_deleted_actors = [];
		for (const actor of actors) {
			if (await query_actor_soft_delete(ctx, actor.id, auth.actor.id)) {
				soft_deleted_actors.push(actor);
			}
		}
		await query_session_revoke_all_for_account(ctx, target_account_id);
		await query_revoke_all_api_tokens_for_account(ctx, target_account_id);
		if (connection_closer) connection_closer.close_sockets_for_account(target_account_id);
		deps.audit.emit(ctx, {
			event_type: 'account_delete',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			target_account_id,
			ip: ctx.client_ip,
			metadata: {username: snapshot.username, email: snapshot.email},
		});
		for (const actor of soft_deleted_actors) {
			deps.audit.emit(ctx, {
				event_type: 'actor_delete',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id,
				target_actor_id: actor.id,
				ip: ctx.client_ip,
				metadata: {name: actor.name},
			});
		}
		return {ok: true, deleted: true};
	};

	// Hard-purge an account (keeper-only, irreversible). Fail-loud:
	// requires `confirm: true` + emits a WARN. Snapshots identity into
	// `account_purge` + per-actor `actor_purge` before the cascading delete
	// removes the rows — the `audit_log` id columns carry no FK, so the
	// purged ids survive on historical rows and the snapshots name them.
	const account_purge_handler = async (
		input: AccountPurgeInput,
		ctx: ActionActorContext,
	): Promise<AccountPurgeOutput> => {
		const auth = ctx.auth;
		// Fail-loud: refuse the irreversible purge without explicit confirm.
		if (input.confirm !== true) {
			throw jsonrpc_errors.invalid_params('purge requires confirm: true', {
				reason: ERROR_PURGE_NOT_CONFIRMED,
			});
		}
		// Keeper + last-admin guards (fail-loud, before the cascade).
		await assert_account_removable(ctx, input.account_id, 'account_purge');
		// Snapshot actors before the cascade removes them.
		const actors = await query_actors_by_account(ctx, input.account_id);
		const snapshot = await query_purge_account(ctx, input.account_id);
		if (!snapshot) {
			deps.audit.emit(ctx, {
				event_type: 'account_purge',
				outcome: 'failure',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {reason: ERROR_ACCOUNT_NOT_FOUND, attempted_account_id: input.account_id},
			});
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		if (connection_closer) connection_closer.close_sockets_for_account(input.account_id);
		deps.log.warn(
			`account hard-purged (irreversible cascading delete): ${input.account_id} by actor ${auth.actor.id}`,
		);
		deps.audit.emit(ctx, {
			event_type: 'account_purge',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			target_account_id: input.account_id,
			ip: ctx.client_ip,
			metadata: {username: snapshot.username, email: snapshot.email},
		});
		for (const actor of actors) {
			deps.audit.emit(ctx, {
				event_type: 'actor_purge',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: input.account_id,
				target_actor_id: actor.id,
				ip: ctx.client_ip,
				metadata: {name: actor.name},
			});
		}
		return {ok: true, purged: true};
	};

	// Reactivate a soft-deleted account (clears the tombstone). Admin-only —
	// the self path is unreachable (a tombstoned account can't authenticate).
	// Clears `deleted_at` on the account + its soft-deleted actor(s) and
	// emits `account_undelete` + one `actor_undelete` per reactivated actor.
	// Does NOT restore revoked sessions/tokens. The inverse of `delete`.
	const account_undelete_handler = async (
		input: AccountUndeleteInput,
		ctx: ActionActorContext,
	): Promise<AccountUndeleteOutput> => {
		const auth = ctx.auth;
		// Snapshot actors (the listing includes soft-deleted rows) before
		// clearing the tombstones so names land in the per-actor events.
		const actors = await query_actors_by_account(ctx, input.account_id);
		const snapshot = await query_account_undelete(ctx, input.account_id);
		if (!snapshot) {
			// Missing or not soft-deleted — UUID probe key, failure audit is safe.
			deps.audit.emit(ctx, {
				event_type: 'account_undelete',
				outcome: 'failure',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {reason: ERROR_ACCOUNT_NOT_FOUND, attempted_account_id: input.account_id},
			});
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const undeleted_actors = [];
		for (const actor of actors) {
			if (await query_actor_undelete(ctx, actor.id)) {
				undeleted_actors.push(actor);
			}
		}
		deps.audit.emit(ctx, {
			event_type: 'account_undelete',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			target_account_id: input.account_id,
			ip: ctx.client_ip,
			metadata: {username: snapshot.username, email: snapshot.email},
		});
		for (const actor of undeleted_actors) {
			deps.audit.emit(ctx, {
				event_type: 'actor_undelete',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: input.account_id,
				target_actor_id: actor.id,
				ip: ctx.client_ip,
				metadata: {name: actor.name},
			});
		}
		return {ok: true, undeleted: true};
	};

	const actions: Array<RpcAction> = [
		rpc_action(admin_account_list_action_spec, account_list_handler),
		rpc_action(account_delete_action_spec, account_delete_handler),
		rpc_action(account_purge_action_spec, account_purge_handler),
		rpc_action(account_undelete_action_spec, account_undelete_handler),
		rpc_action(admin_session_list_action_spec, session_list_handler),
		rpc_action(admin_session_revoke_all_action_spec, session_revoke_all_handler),
		rpc_action(admin_token_revoke_all_action_spec, token_revoke_all_handler),
		rpc_action(audit_log_list_action_spec, audit_log_list_handler),
		rpc_action(audit_log_role_grant_history_action_spec, audit_log_role_grant_history_handler),
		rpc_action(invite_create_action_spec, invite_create_handler),
		rpc_action(invite_list_action_spec, invite_list_handler),
		rpc_action(invite_delete_action_spec, invite_delete_handler),
	];

	const app_settings_get_handler = async (
		_input: AppSettingsGetInput,
		ctx: ActionActorContext,
	): Promise<AppSettingsGetOutput> => {
		const settings = await query_app_settings_load_with_username(ctx);
		return {settings};
	};

	const app_settings_update_handler = async (
		input: AppSettingsUpdateInput,
		ctx: ActionActorContext,
	): Promise<AppSettingsUpdateOutput> => {
		const auth = ctx.auth;
		// Read the prior value for the audit row before writing the new one.
		const {open_signup: old_value} = await query_app_settings_load(ctx);
		await query_app_settings_update(ctx, input.open_signup, auth.actor.id);

		deps.audit.emit(ctx, {
			event_type: 'app_settings_update',
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				setting: 'open_signup',
				old_value,
				new_value: input.open_signup,
			},
		});
		const settings = await query_app_settings_load_with_username(ctx);
		return {ok: true, settings};
	};

	actions.push(
		rpc_action(app_settings_get_action_spec, app_settings_get_handler),
		rpc_action(app_settings_update_action_spec, app_settings_update_handler),
	);

	return actions;
};
