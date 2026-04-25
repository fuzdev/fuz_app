/**
 * Combined admin + permit-offer + account RPC actions for fuz_app consumers.
 *
 * The canonical "standard" RPC surface: every stock fuz_app RPC action a
 * typical web consumer wants on one endpoint. Consumers that want a
 * narrower surface drop down to the per-domain factories directly
 * (`create_admin_actions` / `create_permit_offer_actions` /
 * `create_account_actions`).
 *
 * Option routing: shared `roles` flows to both admin and permit-offer;
 * `app_settings` goes to admin only; `default_ttl_ms` and `authorize` go
 * to permit-offer only; `max_tokens` goes to account only;
 * `notification_sender` reaches permit-offer transparently (admin + account
 * ignore it).
 *
 * Paired with `create_admin_rpc_adapters` on the UI side.
 *
 * @module
 */

import {create_admin_actions, type AdminActionOptions} from './admin_actions.js';
import {
	create_permit_offer_actions,
	type PermitOfferActionDeps,
	type PermitOfferActionOptions,
} from './permit_offer_actions.js';
import {create_account_actions, type AccountActionOptions} from './account_actions.js';
import type {RpcAction} from '../actions/action_rpc.js';

/**
 * Options for `create_standard_rpc_actions`.
 *
 * Composes `AdminActionOptions` (`roles`, `app_settings`),
 * `PermitOfferActionOptions` (`roles`, `default_ttl_ms`, `authorize`), and
 * `AccountActionOptions` (`max_tokens`). `roles` is shared between admin
 * and permit-offer — the caller supplies it once and the helper threads
 * the same reference to both.
 */
export interface StandardRpcActionsOptions
	extends AdminActionOptions, PermitOfferActionOptions, AccountActionOptions {}

/**
 * Dependencies for `create_standard_rpc_actions`.
 *
 * Same shape as `PermitOfferActionDeps` — `log`, `on_audit_event`, and an
 * optional `notification_sender` for permit-offer WS fan-out. Admin and
 * account factories only read `log` + `on_audit_event`; the extra field
 * is harmless.
 */
export type StandardRpcActionsDeps = PermitOfferActionDeps;

/**
 * Build the combined admin + permit-offer + account RPC action set.
 *
 * Spreads `create_admin_actions(deps, {roles, app_settings})`,
 * `create_permit_offer_actions(deps, {roles, default_ttl_ms, authorize})`,
 * and `create_account_actions(deps, {max_tokens})`. The shared `roles`
 * option flows to admin + permit-offer.
 *
 * @param deps - `StandardRpcActionsDeps` (`log`, `on_audit_event`, optional `audit_log_config` from `AppDeps`; optional `notification_sender` for WS fan-out)
 * @param options - role schema, optional app-settings ref, permit-offer config, account config
 * @returns RPC actions to pass as `rpc_endpoints` or spread into `create_rpc_endpoint`
 */
export const create_standard_rpc_actions = (
	deps: StandardRpcActionsDeps,
	options: StandardRpcActionsOptions = {},
): Array<RpcAction> => [
	...create_admin_actions(deps, options),
	...create_permit_offer_actions(deps, options),
	...create_account_actions(deps, options),
];
