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
 * The action specs themselves live in `auth/account_action_specs.ts`. Every spec
 * declares `auth: {account: 'required', actor: 'none'}` so the dispatcher
 * enforces account-grain auth before the handler runs. Revoke operations are
 * account-scoped (via
 * `query_session_revoke_for_account` / `query_revoke_api_token_for_account`)
 * so passing another account's session or token id returns `revoked: false`
 * rather than revealing whether the id exists.
 *
 * Counterpart to `auth/account_routes.ts`, which keeps the cookie-lifecycle flows
 * (`login`, `logout`, `password`, `signup`, `bootstrap`) on REST.
 *
 * @module
 */

import {rpc_action, type ActionAuthContext, type RpcAction} from '../actions/action_rpc.js';
import type {ConnectionCloser} from '../actions/connection_closer.js';
import {to_session_account, type SessionAccountJson} from './account_schema.js';
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
import {DEFAULT_MAX_TOKENS} from './account_route_schema.js';
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
	/**
	 * Live-connection closer — when set, `account_session_revoke` /
	 * `_session_revoke_all` / `account_token_revoke` handlers eagerly close
	 * affected WebSocket sockets BEFORE emitting the corresponding audit
	 * event. Closes the audit-failure-leaks-WS surface: the listener-based
	 * close (`transports_ws_auth_guard`) only fires after the audit INSERT
	 * succeeds, so a DB error would leave live sockets stale. `BackendWebsocketTransport`
	 * satisfies this interface structurally; consumers pass their transport
	 * instance directly. When absent, only the listener-based close runs.
	 * Mirrors `zzz_server`'s handler-side `close_sockets_for_*` calls.
	 */
	connection_closer?: ConnectionCloser | null;
}

/**
 * Create the self-service account RPC actions.
 *
 * @param deps - `RouteFactoryDeps` (`log`, `audit`, …). `audit.emit` writes
 *   audit rows via the captured pool; the bound emitter encapsulates
 *   `on_audit_event` fan-out and the optional `AuditLogConfig`.
 * @param options - per-factory configuration
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_account_actions = (
	deps: Pick<RouteFactoryDeps, 'log' | 'audit'>,
	options: AccountActionOptions = {},
): Array<RpcAction> => {
	const {max_tokens = DEFAULT_MAX_TOKENS, connection_closer = null} = options;

	const verify_handler = (_input: VerifyInput, ctx: ActionAuthContext): SessionAccountJson => {
		return to_session_account(ctx.auth.account);
	};

	const session_list_handler = async (
		_input: SessionListInput,
		ctx: ActionAuthContext,
	): Promise<SessionListOutput> => {
		const sessions = await query_session_list_for_account(ctx, ctx.auth.account.id);
		return {sessions};
	};

	const session_revoke_handler = async (
		input: SessionRevokeInput,
		ctx: ActionAuthContext,
	): Promise<SessionRevokeOutput> => {
		const revoked = await query_session_revoke_for_account(
			ctx,
			input.session_id,
			ctx.auth.account.id,
		);
		// Handler-side belt+suspenders: close the live WS socket bound to this
		// session BEFORE the audit emit, so revocation lands even if the audit
		// INSERT fails. The real ordering invariant is "before the transaction
		// commits": this handler runs inside the dispatcher's transaction
		// (side_effects: true), so any throw between this close and the return
		// would roll back the DB revoke while leaving the socket severed. That
		// is benign — the session is still valid, the client reconnects — but
		// don't introduce a throw here without acknowledging the trade.
		// Only fire on success — failure carries an attacker-guessable
		// session_id and the listener-based close already ignores failure
		// outcomes for the same reason. Idempotent — the audit listener runs a
		// second close on success but matches no sockets the second time.
		if (revoked && connection_closer) {
			connection_closer.close_sockets_for_session(input.session_id);
		}
		deps.audit.emit(ctx, {
			event_type: 'session_revoke',
			outcome: revoked ? 'success' : 'failure',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			// `credential_type` defense in depth — see `docs/security.md` §Credential-channel gating.
			metadata: {session_id: input.session_id, credential_type: ctx.credential_type ?? undefined},
		});
		return {ok: true, revoked};
	};

	const session_revoke_all_handler = async (
		_input: SessionRevokeAllInput,
		ctx: ActionAuthContext,
	): Promise<SessionRevokeAllOutput> => {
		const count = await query_session_revoke_all_for_account(ctx, ctx.auth.account.id);
		// Handler-side belt+suspenders — see session_revoke_handler comment.
		// Close fires regardless of `count` (today `count >= 1` always — the
		// caller is using the session they're revoking; future bearer / daemon-
		// token-credentialed callers may hit `count: 0`). Symmetric with the
		// admin revoke-all handlers in `admin_actions.ts`, where `count: 0` is
		// a real outcome (target account had no live sessions/tokens) and the
		// eager close still fires to scrub sockets that the audit listener
		// would otherwise miss when the INSERT fails. Idempotent at all counts.
		if (connection_closer) {
			connection_closer.close_sockets_for_account(ctx.auth.account.id);
		}
		deps.audit.emit(ctx, {
			event_type: 'session_revoke_all',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			metadata: {count, credential_type: ctx.credential_type ?? undefined},
		});
		return {ok: true, count};
	};

	const token_create_handler = async (
		input: TokenCreateInput,
		ctx: ActionAuthContext,
	): Promise<TokenCreateOutput> => {
		const {token, id, token_hash} = generate_api_token();
		await query_create_api_token(ctx, id, ctx.auth.account.id, input.name, token_hash);
		if (max_tokens != null) {
			await query_api_token_enforce_limit(ctx, ctx.auth.account.id, max_tokens);
		}
		deps.audit.emit(ctx, {
			event_type: 'token_create',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				token_id: id,
				name: input.name,
				credential_type: ctx.credential_type ?? undefined,
			},
		});
		return {ok: true, token, id, name: input.name};
	};

	const token_list_handler = async (
		_input: TokenListInput,
		ctx: ActionAuthContext,
	): Promise<TokenListOutput> => {
		const tokens = await query_api_token_list_for_account(ctx, ctx.auth.account.id);
		return {tokens};
	};

	const token_revoke_handler = async (
		input: TokenRevokeInput,
		ctx: ActionAuthContext,
	): Promise<TokenRevokeOutput> => {
		const revoked = await query_revoke_api_token_for_account(
			ctx,
			input.token_id,
			ctx.auth.account.id,
		);
		// Handler-side belt+suspenders — see session_revoke_handler comment.
		if (revoked && connection_closer) {
			connection_closer.close_sockets_for_token(input.token_id);
		}
		deps.audit.emit(ctx, {
			event_type: 'token_revoke',
			outcome: revoked ? 'success' : 'failure',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			metadata: {token_id: input.token_id, credential_type: ctx.credential_type ?? undefined},
		});
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
