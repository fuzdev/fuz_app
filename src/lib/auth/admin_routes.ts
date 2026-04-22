/**
 * Generic admin route specs — account listing, session and token revocation.
 *
 * Permit grant and revoke are RPC-only — see `permit_offer_create` and
 * `permit_revoke` in `permit_offer_actions.ts`. All routes require the
 * `admin` role.
 *
 * @module
 */

import {z} from 'zod';

import {BUILTIN_ROLE_OPTIONS, RoleName, type RoleSchemaResult} from './role_schema.js';
import {AdminAccountEntryJson} from './account_schema.js';
import {require_request_context} from './request_context.js';
import {get_route_params, type RouteSpec} from '../http/route_spec.js';
import {query_account_by_id, query_admin_account_list} from './account_queries.js';
import {query_session_revoke_all_for_account} from './session_queries.js';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {RouteFactoryDeps} from './deps.js';
import {ERROR_ACCOUNT_NOT_FOUND} from '../http/error_schemas.js';
import {get_client_ip} from '../http/proxy.js';

/** Options for admin route specs. */
export interface AdminRouteOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin roles only.
	 * Pass the full result to enable extended app-defined roles in the admin UI.
	 * Both `Role` and `role_options` come from the same call — passing them together
	 * via this field ensures they stay in sync.
	 */
	roles?: RoleSchemaResult;
}

/**
 * Dependencies for {@link create_admin_account_route_specs}.
 */
export type AdminAccountRouteDeps = Pick<RouteFactoryDeps, 'log' | 'on_audit_event'>;

/**
 * Create admin route specs for account listing and session/token revocation.
 *
 * Permit grant / revoke / retract are not routes here — they live on the
 * RPC surface (`permit_offer_create`, `permit_revoke`, `permit_offer_retract`).
 *
 * @param deps - stateless capabilities (log, on_audit_event)
 * @param options - optional options with role schema for validation
 * @returns route specs for admin account management
 */
export const create_admin_account_route_specs = (
	deps: AdminAccountRouteDeps,
	options?: AdminRouteOptions,
): Array<RouteSpec> => {
	const role = 'admin';
	const {on_audit_event} = deps;
	const role_options = options?.roles?.role_options ?? BUILTIN_ROLE_OPTIONS;
	const grantable_roles: Array<string> = [];
	for (const [name, rc] of role_options) {
		if (rc.web_grantable) grantable_roles.push(name);
	}

	return [
		{
			method: 'GET',
			path: '/accounts',
			auth: {type: 'role', role},
			description: 'List all accounts with their permits',
			input: z.null(),
			output: z.strictObject({
				accounts: z.array(AdminAccountEntryJson),
				grantable_roles: z.array(RoleName),
			}),
			handler: async (c, route) => {
				const accounts = await query_admin_account_list(route);
				return c.json({accounts, grantable_roles});
			},
		},
		{
			method: 'POST',
			path: '/accounts/:account_id/sessions/revoke-all',
			auth: {type: 'role', role},
			description: 'Revoke all sessions for an account',
			params: z.strictObject({account_id: z.uuid()}),
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), count: z.number()}),
			errors: {404: z.looseObject({error: z.literal(ERROR_ACCOUNT_NOT_FOUND)})},
			handler: async (c, route) => {
				const {account_id} = get_route_params<{account_id: string}>(c);
				const account = await query_account_by_id(route, account_id);
				if (!account) {
					return c.json({error: ERROR_ACCOUNT_NOT_FOUND}, 404);
				}
				const ctx = require_request_context(c);
				const count = await query_session_revoke_all_for_account(route, account_id);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'session_revoke_all',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						target_account_id: account_id,
						ip: get_client_ip(c),
						metadata: {count},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, count});
			},
		},
		{
			method: 'POST',
			path: '/accounts/:account_id/tokens/revoke-all',
			auth: {type: 'role', role},
			description: 'Revoke all API tokens for an account',
			params: z.strictObject({account_id: z.uuid()}),
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), count: z.number()}),
			errors: {404: z.looseObject({error: z.literal(ERROR_ACCOUNT_NOT_FOUND)})},
			handler: async (c, route) => {
				const {account_id} = get_route_params<{account_id: string}>(c);
				const account = await query_account_by_id(route, account_id);
				if (!account) {
					return c.json({error: ERROR_ACCOUNT_NOT_FOUND}, 404);
				}
				const ctx = require_request_context(c);
				const count = await query_revoke_all_api_tokens_for_account(route, account_id);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'token_revoke_all',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						target_account_id: account_id,
						ip: get_client_ip(c),
						metadata: {count},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, count});
			},
		},
	];
};
