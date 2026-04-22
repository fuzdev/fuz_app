/**
 * Admin RPC actions — admin-only operations exposed on the JSON-RPC surface.
 *
 * Currently ships `admin_account_list` (`side_effects: false`, admin-only,
 * empty input) — the RPC form of the former `GET /api/admin/accounts` REST
 * route. Future Phase 6 migrations (session/token revoke-all, audit log
 * read) land here alongside it.
 *
 * Authorization is enforced in each handler rather than at the spec's
 * `auth` field — mirrors `permit_revoke` in `permit_offer_actions.ts` and
 * leaves room for actions in this module that need tighter or different
 * gating (e.g. keeper-only diagnostics).
 *
 * @module
 */

import {z} from 'zod';

import {RequestResponseActionSpec} from '../actions/action_spec.js';
import type {ActionContext, RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {BUILTIN_ROLE_OPTIONS, ROLE_ADMIN, RoleName, type RoleSchemaResult} from './role_schema.js';
import {AdminAccountEntryJson} from './account_schema.js';
import {query_admin_account_list} from './account_queries.js';
import {has_role} from './request_context.js';
import type {RouteFactoryDeps} from './deps.js';
import {ERROR_INSUFFICIENT_PERMISSIONS} from '../http/error_schemas.js';

// -- Method names -----------------------------------------------------------

export const ADMIN_ACCOUNT_LIST_METHOD = 'admin_account_list';

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
 * deps to both factories. `admin_account_list` itself does not read
 * `on_audit_event` — the field is reserved for future admin mutations
 * (session/token revoke-all) that will emit audit events.
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
	_deps: AdminActionDeps,
	options: AdminActionOptions = {},
): Array<RpcAction> => {
	const role_options = options.roles?.role_options ?? BUILTIN_ROLE_OPTIONS;
	const grantable_roles: Array<string> = [];
	for (const [name, rc] of role_options) {
		if (rc.web_grantable) grantable_roles.push(name);
	}

	const account_list_spec = RequestResponseActionSpec.parse({
		method: ADMIN_ACCOUNT_LIST_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
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
		// Admin-role gate. `auth: 'authenticated'` narrows `ctx.auth` to
		// non-null; role enforcement is the handler's job so this module
		// can host actions with varying auth requirements in the future.
		if (!ctx.auth || !has_role(ctx.auth, ROLE_ADMIN)) {
			throw jsonrpc_errors.forbidden('admin role required', {
				reason: ERROR_INSUFFICIENT_PERMISSIONS,
			});
		}
		const accounts = await query_admin_account_list(ctx);
		return {accounts, grantable_roles};
	};

	return [{spec: account_list_spec, handler: account_list_handler as RpcAction['handler']}];
};
