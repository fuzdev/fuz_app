/**
 * Admin RPC actions — admin-only operations exposed on the JSON-RPC surface.
 *
 * Ships three actions:
 *
 * - `admin_account_list` — `side_effects: false`, the RPC form of the former
 *   `GET /api/admin/accounts`.
 * - `admin_session_revoke_all` — `side_effects: true`, revokes every session
 *   for a target account (formerly `POST /api/admin/accounts/:id/sessions/revoke-all`).
 * - `admin_token_revoke_all` — `side_effects: true`, revokes every API token
 *   for a target account (formerly `POST /api/admin/accounts/:id/tokens/revoke-all`).
 *
 * The two mutations emit `session_revoke_all` / `token_revoke_all` audit
 * events via `audit_log_fire_and_forget`, matching the REST-route precedent.
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

import {RequestResponseActionSpec} from '../actions/action_spec.js';
import type {ActionContext, RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {BUILTIN_ROLE_OPTIONS, ROLE_ADMIN, RoleName, type RoleSchemaResult} from './role_schema.js';
import {AdminAccountEntryJson} from './account_schema.js';
import {query_account_by_id, query_admin_account_list} from './account_queries.js';
import {query_session_revoke_all_for_account} from './session_queries.js';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {RouteFactoryDeps} from './deps.js';
import {Uuid} from '../uuid.js';
import {ERROR_ACCOUNT_NOT_FOUND} from '../http/error_schemas.js';

// -- Method names -----------------------------------------------------------

export const ADMIN_ACCOUNT_LIST_METHOD = 'admin_account_list';
export const ADMIN_SESSION_REVOKE_ALL_METHOD = 'admin_session_revoke_all';
export const ADMIN_TOKEN_REVOKE_ALL_METHOD = 'admin_token_revoke_all';

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

// -- Factory ----------------------------------------------------------------

/** Options for `create_admin_actions`. */
export interface AdminActionOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin
	 * roles only. Used to derive `grantable_roles` (the `web_grantable`
	 * subset) returned by `admin_account_list`.
	 */
	roles?: RoleSchemaResult;
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

	const admin_auth = {role: ROLE_ADMIN} as const;

	// -- admin_account_list --

	const account_list_spec = RequestResponseActionSpec.parse({
		method: ADMIN_ACCOUNT_LIST_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: admin_auth,
		side_effects: false,
		input: AdminAccountListInput,
		output: AdminAccountListOutput,
		async: true,
		description: 'List all accounts with their actors, permits, and pending offers. Admin-only.',
	});

	const account_list_handler = async (
		_input: AdminAccountListInput,
		ctx: ActionContext,
	): Promise<AdminAccountListOutput> => {
		const accounts = await query_admin_account_list(ctx);
		return {accounts, grantable_roles};
	};

	// -- admin_session_revoke_all --

	const session_revoke_all_spec = RequestResponseActionSpec.parse({
		method: ADMIN_SESSION_REVOKE_ALL_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: admin_auth,
		side_effects: true,
		input: AdminSessionRevokeAllInput,
		output: AdminSessionRevokeAllOutput,
		async: true,
		description: 'Revoke all sessions for an account. Admin-only.',
	});

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

	// -- admin_token_revoke_all --

	const token_revoke_all_spec = RequestResponseActionSpec.parse({
		method: ADMIN_TOKEN_REVOKE_ALL_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: admin_auth,
		side_effects: true,
		input: AdminTokenRevokeAllInput,
		output: AdminTokenRevokeAllOutput,
		async: true,
		description: 'Revoke all API tokens for an account. Admin-only.',
	});

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

	return [
		{spec: account_list_spec, handler: account_list_handler as RpcAction['handler']},
		{spec: session_revoke_all_spec, handler: session_revoke_all_handler as RpcAction['handler']},
		{spec: token_revoke_all_spec, handler: token_revoke_all_handler as RpcAction['handler']},
	];
};
