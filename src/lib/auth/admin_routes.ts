/**
 * Generic admin route specs — session and token revocation.
 *
 * Account listing is RPC-only (see `admin_account_list` in
 * `admin_actions.ts`). Permit grant and revoke are RPC-only (see
 * `permit_offer_create` and `permit_revoke` in `permit_offer_actions.ts`).
 * All routes require the `admin` role.
 *
 * @module
 */

import {z} from 'zod';

import {require_request_context} from './request_context.js';
import {get_route_params, type RouteSpec} from '../http/route_spec.js';
import {query_account_by_id} from './account_queries.js';
import {query_session_revoke_all_for_account} from './session_queries.js';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {RouteFactoryDeps} from './deps.js';
import {ERROR_ACCOUNT_NOT_FOUND} from '../http/error_schemas.js';
import {get_client_ip} from '../http/proxy.js';

/**
 * Dependencies for `create_admin_account_route_specs`.
 */
export type AdminAccountRouteDeps = Pick<RouteFactoryDeps, 'log' | 'on_audit_event'>;

/**
 * Create admin route specs for session and token revocation.
 *
 * Account listing and permit grant / revoke / retract are not routes here —
 * they live on the RPC surface (`admin_account_list`, `permit_offer_create`,
 * `permit_revoke`, `permit_offer_retract`).
 *
 * @param deps - stateless capabilities (log, on_audit_event)
 * @returns route specs for admin session and token revocation
 */
export const create_admin_account_route_specs = (deps: AdminAccountRouteDeps): Array<RouteSpec> => {
	const role = 'admin';
	const {on_audit_event} = deps;

	return [
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
