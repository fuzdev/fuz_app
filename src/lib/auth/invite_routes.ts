/**
 * Admin invite route specs for invite-based signup.
 *
 * All routes require the `admin` role. Provides CRUD for invites
 * that gate who can sign up.
 *
 * @module
 */

import {z} from 'zod';

import {get_route_input, get_route_params, type RouteSpec} from '../http/route_spec.js';
import {require_request_context} from './request_context.js';
import {get_client_ip} from '../http/proxy.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import {query_account_by_username, query_account_by_email} from './account_queries.js';
import {
	query_create_invite,
	query_invite_list_all_with_usernames,
	query_invite_delete_unclaimed,
} from './invite_queries.js';
import {InviteJson, InviteWithUsernamesJson} from './invite_schema.js';
import {Username, Email} from './account_schema.js';
import type {RouteFactoryDeps} from './deps.js';
import {is_pg_unique_violation} from '../db/pg_error.js';
import {
	ERROR_INVITE_NOT_FOUND,
	ERROR_INVITE_MISSING_IDENTIFIER,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
} from '../http/error_schemas.js';

/**
 * Create admin invite route specs.
 *
 * @param deps - stateless capabilities (log)
 * @returns route specs for invite management
 */
export const create_invite_route_specs = (
	deps: Pick<RouteFactoryDeps, 'log' | 'on_audit_event'>,
): Array<RouteSpec> => {
	return [
		{
			method: 'POST',
			path: '/invites',
			auth: {type: 'role', role: 'admin'},
			description: 'Create an invite',
			input: z.strictObject({
				email: Email.nullish(),
				username: Username.nullish(),
			}),
			output: z.strictObject({ok: z.literal(true), invite: InviteJson}),
			errors: {
				400: z.looseObject({error: z.literal(ERROR_INVITE_MISSING_IDENTIFIER)}),
				409: z.looseObject({
					error: z.enum([
						ERROR_INVITE_DUPLICATE,
						ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
						ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
					]),
				}),
			},
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const {email, username} = get_route_input<{
					email?: string | null;
					username?: string | null;
				}>(c);

				if (!email && !username) {
					return c.json({error: ERROR_INVITE_MISSING_IDENTIFIER}, 400);
				}

				if (username) {
					const existing = await query_account_by_username(route, username);
					if (existing) {
						return c.json({error: ERROR_INVITE_ACCOUNT_EXISTS_USERNAME}, 409);
					}
				}
				if (email) {
					const existing = await query_account_by_email(route, email);
					if (existing) {
						return c.json({error: ERROR_INVITE_ACCOUNT_EXISTS_EMAIL}, 409);
					}
				}

				let invite;
				try {
					invite = await query_create_invite(route, {
						email: email ?? null,
						username: username ?? null,
						created_by: ctx.actor.id,
					});
				} catch (e: unknown) {
					if (is_pg_unique_violation(e)) {
						return c.json({error: ERROR_INVITE_DUPLICATE}, 409);
					}
					throw e;
				}

				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'invite_create',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {invite_id: invite.id, email: email ?? null, username: username ?? null},
					},
					deps.log,
					deps.on_audit_event,
				);
				return c.json({ok: true, invite});
			},
		},
		{
			method: 'GET',
			path: '/invites',
			auth: {type: 'role', role: 'admin'},
			description: 'List all invites',
			input: z.null(),
			output: z.strictObject({invites: z.array(InviteWithUsernamesJson)}),
			handler: async (c, route) => {
				const invites = await query_invite_list_all_with_usernames(route);
				return c.json({invites});
			},
		},
		{
			method: 'DELETE',
			path: '/invites/:id',
			auth: {type: 'role', role: 'admin'},
			description: 'Delete an unclaimed invite',
			params: z.strictObject({id: z.uuid()}),
			input: z.null(),
			output: z.strictObject({ok: z.literal(true)}),
			errors: {404: z.looseObject({error: z.literal(ERROR_INVITE_NOT_FOUND)})},
			handler: async (c, route) => {
				const {id} = get_route_params<{id: string}>(c);
				const deleted = await query_invite_delete_unclaimed(route, id);
				if (!deleted) {
					return c.json({error: ERROR_INVITE_NOT_FOUND}, 404);
				}

				const ctx = require_request_context(c);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'invite_delete',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {invite_id: id},
					},
					deps.log,
					deps.on_audit_event,
				);
				return c.json({ok: true});
			},
		},
	];
};
