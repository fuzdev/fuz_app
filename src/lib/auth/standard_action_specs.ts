/**
 * Aggregate spec list mirroring `create_standard_rpc_actions` on the backend.
 *
 * `create_standard_rpc_actions` (in `auth/standard_rpc_actions.ts`) bundles three
 * action registries into one mounted RPC surface: admin + role_grant_offer +
 * account. Frontends mounting that surface need the matching spec list to
 * feed `create_rpc_client` so the typed Proxy knows about every standard
 * method.
 *
 * Without this aggregate, every consumer spreads three (or four with
 * self-service roles) `all_*_action_specs` imports at the typed-client
 * site, the codegen-sources table, and any other registry construction —
 * a triplicate that drifts silently on either side.
 *
 * Self-service role specs are **not** included — they're opt-in (require
 * `eligible_roles` configuration) and not bundled into
 * `create_standard_rpc_actions`. Consumers that mount them spread
 * `all_self_service_role_action_specs` separately.
 *
 * @module
 */

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {all_admin_action_specs} from './admin_action_specs.js';
import {all_role_grant_offer_action_specs} from './role_grant_offer_action_specs.js';
import {all_account_action_specs} from './account_action_specs.js';

/**
 * Combined spec registry for the standard RPC surface (admin +
 * role_grant_offer + account). Symmetric with `create_standard_rpc_actions`.
 *
 * Spec count is the sum of the three sub-registries. Adding a method to
 * any sub-registry surfaces here automatically.
 */
export const all_standard_action_specs: ReadonlyArray<RequestResponseActionSpec> = [
	...all_admin_action_specs,
	...all_role_grant_offer_action_specs,
	...all_account_action_specs,
];
