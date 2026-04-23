/**
 * Account RPC action handlers — self-service operations for the authenticated
 * account.
 *
 * Seven `request_response` actions bound to handlers:
 *
 * - Session reads: `account_verify`, `account_session_list`.
 * - Session mutations: `account_session_revoke`, `account_session_revoke_all`.
 * - API token management: `account_token_create`, `account_token_list`,
 *   `account_token_revoke`.
 *
 * The action specs themselves live in `./account_action_specs.js`. Every spec
 * declares `auth: 'authenticated'` so the dispatcher enforces auth before the
 * handler runs. Revoke operations are account-scoped (via
 * `query_session_revoke_for_account` / `query_revoke_api_token_for_account`)
 * so passing another account's session or token id returns `revoked: false`
 * rather than revealing whether the id exists.
 *
 * Counterpart to `account_routes.ts`, which keeps the cookie-lifecycle flows
 * (`login`, `logout`, `password`, `signup`, `bootstrap`) on REST.
 *
 * @module
 */

import {rpc_action, type ActionContext, type RpcAction} from '../actions/action_rpc.js';
import {to_session_account} from './account_schema.js';
import {
	query_session_list_for_account,
	query_session_revoke_for_account,
	query_session_revoke_all_for_account,
} from './session_queries.js';
import {
	query_api_token_enforce_limit,
	query_api_token_list_for_account,
	query_create_api_token,
	query_revoke_api_token_for_account,
} from './api_token_queries.js';
import {generate_api_token} from './api_token.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import {DEFAULT_MAX_TOKENS} from './account_routes.js';
import type {RouteFactoryDeps} from './deps.js';
import {
	account_verify_action_spec,
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
	account_token_create_action_spec,
	account_token_list_action_spec,
	account_token_revoke_action_spec,
	type VerifyInput,
	type VerifyOutput,
	type SessionListInput,
	type SessionListOutput,
	type SessionRevokeInput,
	type SessionRevokeOutput,
	type SessionRevokeAllInput,
	type SessionRevokeAllOutput,
	type TokenCreateInput,
	type TokenCreateOutput,
	type TokenListInput,
	type TokenListOutput,
	type TokenRevokeInput,
	type TokenRevokeOutput,
} from './account_action_specs.js';

/** Options for `create_account_actions`. */
export interface AccountActionOptions {
	/**
	 * Max API tokens per account. When set, `account_token_create` enforces the
	 * cap via `query_api_token_enforce_limit` inside the same transaction —
	 * oldest tokens are evicted once the cap is exceeded. Default
	 * `DEFAULT_MAX_TOKENS`; pass `null` to disable the cap.
	 */
	max_tokens?: number | null;
}

/**
 * Dependencies for `create_account_actions`.
 *
 * Shares shape with `AdminActionDeps` / `PermitOfferActionDeps` so consumers
 * can pass the same deps to every action factory.
 */
export type AccountActionDeps = Pick<RouteFactoryDeps, 'log' | 'on_audit_event'>;

/**
 * Create the self-service account RPC actions.
 *
 * @param deps - stateless capabilities (log, on_audit_event)
 * @param options - per-factory configuration
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_account_actions = (
	deps: AccountActionDeps,
	options: AccountActionOptions = {},
): Array<RpcAction> => {
	const {log, on_audit_event} = deps;
	const {max_tokens = DEFAULT_MAX_TOKENS} = options;

	const verify_handler = (_input: VerifyInput, ctx: ActionContext): VerifyOutput => {
		const auth = ctx.auth!;
		return to_session_account(auth.account);
	};

	const session_list_handler = async (
		_input: SessionListInput,
		ctx: ActionContext,
	): Promise<SessionListOutput> => {
		const auth = ctx.auth!;
		const sessions = await query_session_list_for_account(ctx, auth.account.id);
		return {sessions};
	};

	const session_revoke_handler = async (
		input: SessionRevokeInput,
		ctx: ActionContext,
	): Promise<SessionRevokeOutput> => {
		const auth = ctx.auth!;
		const revoked = await query_session_revoke_for_account(ctx, input.session_id, auth.account.id);
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'session_revoke',
				outcome: revoked ? 'success' : 'failure',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {session_id: input.session_id},
			},
			log,
			on_audit_event,
		);
		return {ok: true, revoked};
	};

	const session_revoke_all_handler = async (
		_input: SessionRevokeAllInput,
		ctx: ActionContext,
	): Promise<SessionRevokeAllOutput> => {
		const auth = ctx.auth!;
		const count = await query_session_revoke_all_for_account(ctx, auth.account.id);
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'session_revoke_all',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {count},
			},
			log,
			on_audit_event,
		);
		return {ok: true, count};
	};

	const token_create_handler = async (
		input: TokenCreateInput,
		ctx: ActionContext,
	): Promise<TokenCreateOutput> => {
		const auth = ctx.auth!;
		const {token, id, token_hash} = generate_api_token();
		await query_create_api_token(ctx, id, auth.account.id, input.name, token_hash);
		if (max_tokens != null) {
			await query_api_token_enforce_limit(ctx, auth.account.id, max_tokens);
		}
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'token_create',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {token_id: id, name: input.name},
			},
			log,
			on_audit_event,
		);
		return {ok: true, token, id, name: input.name};
	};

	const token_list_handler = async (
		_input: TokenListInput,
		ctx: ActionContext,
	): Promise<TokenListOutput> => {
		const auth = ctx.auth!;
		const tokens = await query_api_token_list_for_account(ctx, auth.account.id);
		return {tokens};
	};

	const token_revoke_handler = async (
		input: TokenRevokeInput,
		ctx: ActionContext,
	): Promise<TokenRevokeOutput> => {
		const auth = ctx.auth!;
		const revoked = await query_revoke_api_token_for_account(ctx, input.token_id, auth.account.id);
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'token_revoke',
				outcome: revoked ? 'success' : 'failure',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {token_id: input.token_id},
			},
			log,
			on_audit_event,
		);
		return {ok: true, revoked};
	};

	return [
		rpc_action(account_verify_action_spec, verify_handler),
		rpc_action(account_session_list_action_spec, session_list_handler),
		rpc_action(account_session_revoke_action_spec, session_revoke_handler),
		rpc_action(account_session_revoke_all_action_spec, session_revoke_all_handler),
		rpc_action(account_token_create_action_spec, token_create_handler),
		rpc_action(account_token_list_action_spec, token_list_handler),
		rpc_action(account_token_revoke_action_spec, token_revoke_handler),
	];
};
