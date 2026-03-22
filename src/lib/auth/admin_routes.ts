/**
 * Generic admin route specs — account listing, permit management, session and token revocation.
 *
 * All routes require the `admin` role.
 *
 * @module
 */

import {z} from 'zod';

import {BUILTIN_ROLE_OPTIONS, BuiltinRole, RoleName, type RoleSchemaResult} from './role_schema.js';
import {AdminAccountEntryJson} from './account_schema.js';
import {require_request_context} from './request_context.js';
import {get_route_input, get_route_params, type RouteSpec} from '../http/route_spec.js';
import {
	query_account_by_id,
	query_actor_by_account,
	query_admin_account_list,
} from './account_queries.js';
import {query_grant_permit, query_revoke_permit} from './permit_queries.js';
import {query_session_revoke_all_for_account} from './session_queries.js';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {RouteFactoryDeps} from './deps.js';
import {
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
	ERROR_PERMIT_NOT_FOUND,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '../http/error_schemas.js';
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
 * Create admin route specs for account listing and permit management.
 *
 * @param deps - stateless capabilities (log)
 * @param options - optional options with role schema for validation
 * @returns route specs for admin account management
 */
export const create_admin_account_route_specs = (
	deps: Pick<RouteFactoryDeps, 'log' | 'on_audit_event'>,
	options?: AdminRouteOptions,
): Array<RouteSpec> => {
	const role = 'admin';
	const {on_audit_event} = deps;
	const role_schema = options?.roles?.Role ?? BuiltinRole;
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
			path: '/accounts/:account_id/permits/grant',
			auth: {type: 'role', role},
			description: 'Grant a role permit to an account',
			params: z.strictObject({account_id: z.uuid()}),
			input: z.strictObject({role: role_schema}),
			output: z.strictObject({
				ok: z.literal(true),
				permit: z.strictObject({id: z.string(), role: z.string()}),
			}),
			errors: {
				403: z.looseObject({
					error: z.enum([ERROR_INSUFFICIENT_PERMISSIONS, ERROR_ROLE_NOT_WEB_GRANTABLE]),
				}),
				404: z.looseObject({error: z.literal(ERROR_ACCOUNT_NOT_FOUND)}),
			},
			handler: async (c, route) => {
				const {account_id} = get_route_params<{account_id: string}>(c);
				const {role: role_name} = get_route_input<{role: string}>(c);

				// Enforce web_grantable — direct API calls must respect the same
				// restrictions as the UI. Keeper role can only be granted via daemon token.
				const rc = role_options.get(role_name);
				if (!rc?.web_grantable) {
					return c.json({error: ERROR_ROLE_NOT_WEB_GRANTABLE}, 403);
				}

				const actor = await query_actor_by_account(route, account_id);
				if (!actor) {
					return c.json({error: ERROR_ACCOUNT_NOT_FOUND}, 404);
				}

				const ctx = require_request_context(c);
				const permit = await query_grant_permit(route, {
					actor_id: actor.id,
					role: role_name,
					granted_by: ctx.actor.id,
				});

				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'permit_grant',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						target_account_id: account_id,
						ip: get_client_ip(c),
						metadata: {role: role_name, permit_id: permit.id},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, permit: {id: permit.id, role: permit.role}});
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
		{
			method: 'POST',
			path: '/accounts/:account_id/permits/:permit_id/revoke',
			auth: {type: 'role', role},
			description: 'Revoke a permit',
			params: z.strictObject({account_id: z.uuid(), permit_id: z.uuid()}),
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), revoked: z.literal(true)}),
			errors: {
				404: z.looseObject({
					error: z.enum([ERROR_ACCOUNT_NOT_FOUND, ERROR_PERMIT_NOT_FOUND]),
				}),
			},
			handler: async (c, route) => {
				const {account_id, permit_id} = get_route_params<{
					account_id: string;
					permit_id: string;
				}>(c);
				const ctx = require_request_context(c);

				// resolve the target actor from the URL account_id to prevent IDOR
				const target_actor = await query_actor_by_account(route, account_id);
				if (!target_actor) {
					return c.json({error: ERROR_ACCOUNT_NOT_FOUND}, 404);
				}

				const result = await query_revoke_permit(route, permit_id, target_actor.id, ctx.actor.id);
				if (!result) {
					return c.json({error: ERROR_PERMIT_NOT_FOUND}, 404);
				}

				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'permit_revoke',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						target_account_id: account_id,
						ip: get_client_ip(c),
						metadata: {role: result.role, permit_id},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, revoked: true});
			},
		},
	];
};
