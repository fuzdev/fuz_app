/**
 * Combined admin + role-grant-offer + account RPC actions for fuz_app consumers.
 *
 * The canonical "standard" RPC surface: every stock fuz_app RPC action a
 * typical web consumer wants on one endpoint. Consumers that want a
 * narrower surface drop down to the per-domain factories directly
 * (`create_admin_actions` / `create_role_grant_offer_actions` /
 * `create_account_actions`).
 *
 * Option routing: shared `roles` flows to both admin and role-grant-offer;
 * `app_settings` goes to admin only; `default_ttl_ms` and `authorize` go
 * to role-grant-offer only; `max_tokens` goes to account only;
 * `notification_sender` reaches role-grant-offer transparently (admin + account
 * ignore it).
 *
 * Paired with `create_admin_rpc_adapters` on the UI side.
 *
 * @module
 */

import {create_admin_actions, type AdminActionOptions} from './admin_actions.js';
import {
	create_role_grant_offer_actions,
	type RoleGrantOfferActionOptions,
} from './role_grant_offer_actions.js';
import {create_account_actions, type AccountActionOptions} from './account_actions.js';
import type {RouteFactoryDeps} from './deps.js';
import type {NotificationSender} from './role_grant_offer_notifications.js';
import type {RpcAction} from '../actions/action_rpc.js';

/**
 * Options for `create_standard_rpc_actions`.
 *
 * Composes `AdminActionOptions` (`roles`, `app_settings`),
 * `RoleGrantOfferActionOptions` (`roles`, `default_ttl_ms`, `authorize`), and
 * `AccountActionOptions` (`max_tokens`). `roles` is shared between admin
 * and role-grant-offer — the caller supplies it once and the helper threads
 * the same reference to both.
 */
export interface StandardRpcActionsOptions
	extends AdminActionOptions, RoleGrantOfferActionOptions, AccountActionOptions {}

/**
 * Dependencies for `create_standard_rpc_actions`.
 *
 * Stack-standard `RouteFactoryDeps` slice (`log`, `audit`) plus an optional
 * `notification_sender` consumed only by the role-grant-offer sub-factory
 * for WS fan-out. Admin and account sub-factories ignore
 * `notification_sender`.
 */
export interface StandardRpcActionsDeps extends Pick<RouteFactoryDeps, 'log' | 'audit'> {
	notification_sender?: NotificationSender | null;
}

/**
 * Build the combined admin + role-grant-offer + account RPC action set.
 *
 * Spreads `create_admin_actions(deps, {roles, app_settings})`,
 * `create_role_grant_offer_actions(deps, {roles, default_ttl_ms, authorize})`,
 * and `create_account_actions(deps, {max_tokens})`. The shared `roles`
 * option flows to admin + role-grant-offer.
 *
 * @param deps - `StandardRpcActionsDeps` (`log`, `audit` from `RouteFactoryDeps`; optional `notification_sender` for WS fan-out)
 * @param options - role schema, optional app-settings ref, role-grant-offer config, account config
 * @returns RPC actions to pass as `rpc_endpoints` or spread into `create_rpc_endpoint`
 */
export const create_standard_rpc_actions = (
	deps: StandardRpcActionsDeps,
	options: StandardRpcActionsOptions = {},
): Array<RpcAction> => [
	...create_admin_actions(deps, options),
	...create_role_grant_offer_actions(deps, options),
	...create_account_actions(deps, options),
];
