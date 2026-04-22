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
import {emit_after_commit} from '../http/pending_effects.js';
import {
	query_account_by_id,
	query_actor_by_account,
	query_admin_account_list,
} from './account_queries.js';
import {query_permit_find_active_role_for_actor, query_revoke_permit} from './permit_queries.js';
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
import {
	build_permit_offer_received_notification,
	build_permit_offer_supersede_notification,
	build_permit_revoke_notification,
	type NotificationSender,
} from './permit_offer_notifications.js';
import {
	PERMIT_OFFER_DEFAULT_TTL_MS,
	PermitOfferJson,
	to_permit_offer_json,
} from './permit_offer_schema.js';
import {query_permit_offer_create, PermitOfferSelfTargetError} from './permit_offer_queries.js';
import {ERROR_OFFER_SELF_TARGET} from './permit_offer_actions.js';
import type {Uuid} from '../uuid.js';

/** Options for admin route specs. */
export interface AdminRouteOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin roles only.
	 * Pass the full result to enable extended app-defined roles in the admin UI.
	 * Both `Role` and `role_options` come from the same call — passing them together
	 * via this field ensures they stay in sync.
	 */
	roles?: RoleSchemaResult;
	/**
	 * TTL applied to offers emitted by the admin grant route. Defaults to
	 * `PERMIT_OFFER_DEFAULT_TTL_MS`. Independent of
	 * `PermitOfferActionOptions.default_ttl_ms` so admin-issued offers (known
	 * grantor, operational context) can carry a different expiry than
	 * consumer-issued offers.
	 */
	permit_offer_default_ttl_ms?: number;
}

/**
 * Dependencies for {@link create_admin_account_route_specs}.
 *
 * `notification_sender` is optional — when absent, the permit-revoke and
 * offer-supersede WS fan-out is silently skipped. Consumers wiring
 * `BackendWebsocketTransport` assign its instance directly.
 */
export interface AdminAccountRouteDeps extends Pick<RouteFactoryDeps, 'log' | 'on_audit_event'> {
	/** Optional WS fan-out primitive. `null` or absent → notifications skipped. */
	notification_sender?: NotificationSender | null;
}

/**
 * Create admin route specs for account listing and permit management.
 *
 * @param deps - stateless capabilities (log, on_audit_event, optional notification_sender)
 * @param options - optional options with role schema for validation
 * @returns route specs for admin account management
 */
export const create_admin_account_route_specs = (
	deps: AdminAccountRouteDeps,
	options?: AdminRouteOptions,
): Array<RouteSpec> => {
	const role = 'admin';
	const {on_audit_event, notification_sender = null} = deps;
	const role_schema = options?.roles?.Role ?? BuiltinRole;
	const role_options = options?.roles?.role_options ?? BUILTIN_ROLE_OPTIONS;
	const permit_offer_default_ttl_ms =
		options?.permit_offer_default_ttl_ms ?? PERMIT_OFFER_DEFAULT_TTL_MS;
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
			description:
				'Offer a role permit to an account. Consentful grant — the recipient accepts or declines via the offer inbox before a permit materializes.',
			params: z.strictObject({account_id: z.uuid()}),
			input: z.strictObject({role: role_schema}),
			output: z.strictObject({
				ok: z.literal(true),
				offer: PermitOfferJson,
			}),
			errors: {
				400: z.looseObject({error: z.literal(ERROR_OFFER_SELF_TARGET)}),
				403: z.looseObject({
					error: z.enum([ERROR_INSUFFICIENT_PERMISSIONS, ERROR_ROLE_NOT_WEB_GRANTABLE]),
				}),
				404: z.looseObject({error: z.literal(ERROR_ACCOUNT_NOT_FOUND)}),
			},
			handler: async (c, route) => {
				const {account_id} = get_route_params<{account_id: string}>(c);
				const {role: role_name} = get_route_input<{role: string}>(c);
				const ctx = require_request_context(c);

				// Enforce web_grantable — direct API calls must respect the same
				// restrictions as the UI. Keeper role can only be granted via daemon token.
				const rc = role_options.get(role_name);
				if (!rc?.web_grantable) {
					void audit_log_fire_and_forget(
						route,
						{
							event_type: 'permit_offer_create',
							outcome: 'failure',
							actor_id: ctx.actor.id,
							account_id: ctx.account.id,
							target_account_id: account_id,
							ip: get_client_ip(c),
							metadata: {role: role_name, scope_id: null, to_account_id: account_id},
						},
						deps.log,
						on_audit_event,
					);
					return c.json({error: ERROR_ROLE_NOT_WEB_GRANTABLE}, 403);
				}

				// Preflight existence check so a bad :account_id yields a clean 404
				// instead of a FK violation from the offer insert.
				const target_account = await query_account_by_id(route, account_id);
				if (!target_account) {
					return c.json({error: ERROR_ACCOUNT_NOT_FOUND}, 404);
				}

				let offer;
				try {
					offer = await query_permit_offer_create(route, {
						from_actor_id: ctx.actor.id,
						to_account_id: account_id,
						role: role_name,
						scope_id: null,
						message: null,
						expires_at: new Date(Date.now() + permit_offer_default_ttl_ms),
					});
				} catch (err) {
					if (err instanceof PermitOfferSelfTargetError) {
						return c.json({error: ERROR_OFFER_SELF_TARGET}, 400);
					}
					throw err;
				}

				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'permit_offer_create',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						target_account_id: account_id,
						ip: get_client_ip(c),
						metadata: {
							offer_id: offer.id,
							role: offer.role,
							scope_id: offer.scope_id,
							to_account_id: offer.to_account_id,
						},
					},
					deps.log,
					on_audit_event,
				);

				const offer_json = to_permit_offer_json(offer);
				if (notification_sender) {
					emit_after_commit({log: deps.log, pending_effects: route.pending_effects}, () => {
						notification_sender.send_to_account(
							offer.to_account_id as Uuid,
							build_permit_offer_received_notification({offer: offer_json}),
						);
					});
				}

				return c.json({ok: true, offer: offer_json});
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
				403: z.looseObject({
					error: z.enum([ERROR_INSUFFICIENT_PERMISSIONS, ERROR_ROLE_NOT_WEB_GRANTABLE]),
				}),
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

				// Look up the permit's role so we can enforce web_grantable symmetrically
				// with the grant route. Without this, an admin could revoke the keeper
				// permit via the web, breaking the "only daemon token manages keeper" invariant.
				// Route wraps POST handlers in a transaction, so SELECT-then-UPDATE is atomic.
				const permit_row = await query_permit_find_active_role_for_actor(
					route,
					permit_id,
					target_actor.id,
				);
				if (!permit_row) {
					return c.json({error: ERROR_PERMIT_NOT_FOUND}, 404);
				}
				const rc = role_options.get(permit_row.role);
				if (!rc?.web_grantable) {
					void audit_log_fire_and_forget(
						route,
						{
							event_type: 'permit_revoke',
							outcome: 'failure',
							actor_id: ctx.actor.id,
							account_id: ctx.account.id,
							target_account_id: account_id,
							ip: get_client_ip(c),
							metadata: {role: permit_row.role, permit_id},
						},
						deps.log,
						on_audit_event,
					);
					return c.json({error: ERROR_ROLE_NOT_WEB_GRANTABLE}, 403);
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
						metadata: {role: result.role, permit_id, scope_id: result.scope_id},
					},
					deps.log,
					on_audit_event,
				);
				for (const offer of result.superseded_offers) {
					void audit_log_fire_and_forget(
						route,
						{
							event_type: 'permit_offer_supersede',
							actor_id: ctx.actor.id,
							account_id: offer.to_account_id,
							ip: get_client_ip(c),
							metadata: {
								offer_id: offer.id,
								role: offer.role,
								scope_id: offer.scope_id,
								reason: 'permit_revoked',
								cause_id: result.id,
							},
						},
						deps.log,
						on_audit_event,
					);
				}

				// Post-commit WS fan-out: notify the revokee and every grantor
				// whose pending offer was superseded by the revoke. The
				// current admin revoke route does not surface a reason input;
				// the notification's `reason` is null until the route gains one.
				if (notification_sender) {
					const superseded = result.superseded_offers.map(to_permit_offer_json);
					const cause_id = result.id as Uuid;
					emit_after_commit({log: deps.log, pending_effects: route.pending_effects}, () => {
						notification_sender.send_to_account(
							account_id as Uuid,
							build_permit_revoke_notification({
								permit_id: permit_id as Uuid,
								role: result.role,
								scope_id: result.scope_id as Uuid | null,
								reason: null,
							}),
						);
						for (let i = 0; i < superseded.length; i++) {
							const offer_json = superseded[i]!;
							const from_account_id = result.superseded_offers[i]!.from_account_id as Uuid;
							notification_sender.send_to_account(
								from_account_id,
								build_permit_offer_supersede_notification({
									offer: offer_json,
									reason: 'permit_revoked',
									cause_id,
								}),
							);
						}
					});
				}

				return c.json({ok: true, revoked: true});
			},
		},
	];
};
