/**
 * Combined admin + permit-offer RPC actions for fuz_app consumers.
 *
 * Consumers that want the stock fuz_app admin surface spread into their
 * JSON-RPC endpoint import this helper instead of hand-wiring
 * `create_admin_actions` + `create_permit_offer_actions`. The shared `roles`
 * schema flows to both factories; `app_settings` goes to admin only;
 * `default_ttl_ms` and `authorize` go to permit-offer only;
 * `notification_sender` reaches permit-offer transparently (admin ignores it).
 *
 * Paired with `create_admin_rpc_adapters` on the UI side — same "admin RPC
 * surface" concept expressed on each wire endpoint.
 *
 * @module
 */

import {create_admin_actions, type AdminActionOptions} from './admin_actions.js';
import {
	create_permit_offer_actions,
	type PermitOfferActionDeps,
	type PermitOfferActionOptions,
} from './permit_offer_actions.js';
import type {RpcAction} from '../actions/action_rpc.js';

/**
 * Options for `create_admin_rpc_actions`.
 *
 * Composes `AdminActionOptions` (`roles`, `app_settings`) with
 * `PermitOfferActionOptions` (`roles`, `default_ttl_ms`, `authorize`). `roles`
 * is shared between both factories — the caller supplies it once and the
 * helper threads the same reference to both.
 */
export interface AdminRpcActionsOptions extends AdminActionOptions, PermitOfferActionOptions {}

/**
 * Dependencies for `create_admin_rpc_actions`.
 *
 * Same shape as `PermitOfferActionDeps` — `log`, `on_audit_event`, and an
 * optional `notification_sender` for permit-offer WS fan-out. The admin
 * factory only reads `log` + `on_audit_event`; the extra field is harmless.
 */
export type AdminRpcActionsDeps = PermitOfferActionDeps;

/**
 * Build the combined admin + permit-offer RPC action set.
 *
 * Spreads `create_admin_actions(deps, {roles, app_settings})` and
 * `create_permit_offer_actions(deps, {roles, default_ttl_ms, authorize})`.
 * The shared `roles` option flows to both.
 *
 * @param deps - stateless capabilities (log, on_audit_event, optional notification_sender)
 * @param options - role schema, optional app-settings ref, permit-offer TTL and authorize
 * @returns RPC actions to pass as `rpc_endpoints` or spread into `create_rpc_endpoint`
 */
export const create_admin_rpc_actions = (
	deps: AdminRpcActionsDeps,
	options: AdminRpcActionsOptions = {},
): Array<RpcAction> => [
	...create_admin_actions(deps, options),
	...create_permit_offer_actions(deps, options),
];
