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
 * Every handler that ends a credential closes the connections it opened,
 * after the handler's transaction commits (`queue_connection_close` on
 * `deps.connection_closer`): the two session revokes, the token revoke, and
 * `account_token_create` for the tokens its cap evicts.
 *
 * Counterpart to `auth/account_routes.ts`, which keeps the cookie-lifecycle flows
 * (`login`, `logout`, `password`, `signup`, `bootstrap`) on REST.
 *
 * @module
 */

import { rpc_action, type ActionAuthContext, type RpcAction } from '../actions/action_rpc.ts';
import { queue_connection_close } from '../actions/connection_closer.ts';
import { to_session_account, type SessionAccountJson } from './account_schema.ts';
import {
	query_session_list_for_account,
	query_session_revoke_for_account,
	query_session_revoke_all_for_account
} from './session_queries.ts';
import {
	query_api_token_enforce_limit,
	query_api_token_list_for_account,
	query_create_api_token,
	query_revoke_api_token_for_account
} from './api_token_queries.ts';
import {
	parse_stored_token_scope,
	token_scope_from_input,
	token_scope_label
} from './token_scope.ts';
import { token_lifetime_to_expires_at } from './token_lifetime.ts';
import { generate_api_token } from './api_token.ts';
import { DEFAULT_MAX_TOKENS } from './account_route_schema.ts';
import type { RevokingActionFactoryDeps } from './deps.ts';
import { to_iso8601_seconds } from '../timestamp.ts';
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
	type TokenRevokeOutput
} from './account_action_specs.ts';

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
 * Create the self-service account RPC actions.
 *
 * @param deps - `RevokingActionFactoryDeps` (`log`, `audit`,
 *   `connection_closer`). `audit.emit` writes audit rows via the captured
 *   pool; the bound emitter encapsulates `on_audit_event` fan-out and the
 *   optional `AuditLogConfig`. `connection_closer` closes a revoked
 *   credential's live connections after the revocation commits.
 * @param options - per-factory configuration
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_account_actions = (
	deps: RevokingActionFactoryDeps,
	options: AccountActionOptions = {}
): Array<RpcAction> => {
	const { max_tokens = DEFAULT_MAX_TOKENS } = options;
	const { connection_closer } = deps;

	const verify_handler = (_input: VerifyInput, ctx: ActionAuthContext): SessionAccountJson => {
		return to_session_account(ctx.auth.account);
	};

	const session_list_handler = async (
		_input: SessionListInput,
		ctx: ActionAuthContext
	): Promise<SessionListOutput> => {
		const sessions = await query_session_list_for_account(ctx, ctx.auth.account.id);
		return { sessions };
	};

	const session_revoke_handler = async (
		input: SessionRevokeInput,
		ctx: ActionAuthContext
	): Promise<SessionRevokeOutput> => {
		const revoked = await query_session_revoke_for_account(
			ctx,
			input.session_id,
			ctx.auth.account.id
		);
		// Close the connections this session opened, once the revoke has
		// committed — queued, so it never runs before the commit or for a
		// revoke that rolled back, and it does not depend on the audit write
		// below. Only on success: a failed revoke carries a caller-supplied
		// session_id, and closing on it would let any account close another's
		// connections by guessing a hash. The audit listener repeats the close
		// on the announced row; closing is idempotent.
		if (revoked) {
			queue_connection_close(ctx, connection_closer, {
				kind: 'session',
				session_token_hash: input.session_id
			});
		}
		deps.audit.emit(ctx, {
			event_type: 'session_revoke',
			outcome: revoked ? 'success' : 'failure',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			// `credential_type` defense in depth — see `docs/security.md` §Credential-channel gating.
			metadata: { session_id: input.session_id, credential_type: ctx.credential_type ?? undefined }
		});
		return { ok: true, revoked };
	};

	const session_revoke_all_handler = async (
		_input: SessionRevokeAllInput,
		ctx: ActionAuthContext
	): Promise<SessionRevokeAllOutput> => {
		const count = await query_session_revoke_all_for_account(ctx, ctx.auth.account.id);
		// Post-commit close — see session_revoke_handler. Queued regardless of
		// `count` (today `count >= 1` always — the caller is using a session
		// it is revoking), symmetric with the admin revoke-all handlers in
		// `admin_actions.ts`, where `count: 0` is a real outcome.
		queue_connection_close(ctx, connection_closer, {
			kind: 'account',
			account_id: ctx.auth.account.id
		});
		deps.audit.emit(ctx, {
			event_type: 'session_revoke_all',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			metadata: { count, credential_type: ctx.credential_type ?? undefined }
		});
		return { ok: true, count };
	};

	const token_create_handler = async (
		input: TokenCreateInput,
		ctx: ActionAuthContext
	): Promise<TokenCreateOutput> => {
		const { token, id, token_hash } = generate_api_token();
		// `input.scope` is required by `TokenCreateInput` — default-deny at mint.
		// There is deliberately no permissive fallback here: an omitted scope is
		// a validation error upstream, not a full-authority token.
		const scope = token_scope_from_input(input.scope);
		// `input.lifetime` is required for the same reason — an omitted lifetime
		// is a validation error, never an eternal token.
		const expires_at = token_lifetime_to_expires_at(input.lifetime);
		await query_create_api_token(
			ctx,
			id,
			ctx.auth.account.id,
			input.name,
			token_hash,
			scope,
			expires_at
		);
		if (max_tokens != null) {
			const evicted = await query_api_token_enforce_limit(ctx, ctx.auth.account.id, max_tokens);
			// The cap deleted the evicted rows; the connections they opened end
			// only when closed, and only after the commit — the same post-commit
			// close the revocations use. No audit row: there is no eviction
			// event, and `token_create` records the mint that caused it.
			for (const api_token_id of evicted) {
				queue_connection_close(ctx, connection_closer, { kind: 'token', api_token_id });
			}
		}
		deps.audit.emit(ctx, {
			event_type: 'token_create',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				token_id: id,
				name: input.name,
				credential_type: ctx.credential_type ?? undefined
			}
		});
		return {
			ok: true,
			token,
			id,
			name: input.name,
			// the canonical wire shape, matching what `token_list` reads back
			// through `api_token`'s ISO-8601 projection
			expires_at: expires_at === null ? null : to_iso8601_seconds(expires_at)
		};
	};

	const token_list_handler = async (
		_input: TokenListInput,
		ctx: ActionAuthContext
	): Promise<TokenListOutput> => {
		const rows = await query_api_token_list_for_account(ctx, ctx.auth.account.id);
		// Project the stored document down to its display label. Display-only, so
		// an unreadable document degrades to a marker rather than failing the
		// list — the opposite of the resolve path, and deliberately so: this is
		// the surface an operator uses to *find* a bad token.
		const tokens = rows.map(({ scope, ...rest }) => {
			const parsed = parse_stored_token_scope(scope);
			return { ...rest, scope: parsed ? token_scope_label(parsed) : 'unreadable' };
		});
		return { tokens };
	};

	const token_revoke_handler = async (
		input: TokenRevokeInput,
		ctx: ActionAuthContext
	): Promise<TokenRevokeOutput> => {
		const revoked = await query_revoke_api_token_for_account(
			ctx,
			input.token_id,
			ctx.auth.account.id
		);
		// Post-commit close, on success only — see session_revoke_handler.
		if (revoked) {
			queue_connection_close(ctx, connection_closer, {
				kind: 'token',
				api_token_id: input.token_id
			});
		}
		deps.audit.emit(ctx, {
			event_type: 'token_revoke',
			outcome: revoked ? 'success' : 'failure',
			account_id: ctx.auth.account.id,
			ip: ctx.client_ip,
			metadata: { token_id: input.token_id, credential_type: ctx.credential_type ?? undefined }
		});
		return { ok: true, revoked };
	};

	return [
		rpc_action(account_verify_action_spec, verify_handler),
		rpc_action(account_session_list_action_spec, session_list_handler),
		rpc_action(account_session_revoke_action_spec, session_revoke_handler),
		rpc_action(account_session_revoke_all_action_spec, session_revoke_all_handler),
		rpc_action(account_token_create_action_spec, token_create_handler),
		rpc_action(account_token_list_action_spec, token_list_handler),
		rpc_action(account_token_revoke_action_spec, token_revoke_handler)
	];
};
