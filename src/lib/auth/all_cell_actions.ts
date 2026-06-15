import type {RpcAction} from '../actions/action_rpc.js';
import {create_cell_actions, type CellActionDeps} from './cell_actions.js';
import {create_cell_grant_actions} from './cell_grant_actions.js';
import {create_cell_field_actions} from './cell_field_actions.js';
import {create_cell_item_actions} from './cell_item_actions.js';
import {create_cell_audit_actions} from './cell_audit_actions.js';
import type {RoleSchemaResult} from './role_schema.js';

/**
 * Options for `create_all_cell_actions`.
 *
 * `roles` flows to the `cell_grant_*` sub-factory — actor-shaped grants are
 * role-validated against this registry, so callers thread their app's role
 * schema (the same one `create_standard_rpc_actions` takes).
 */
export interface AllCellActionsOptions {
	readonly roles: RoleSchemaResult;
}

/**
 * Build the full cell RPC action set — CRUD (`create_cell_actions`,
 * which also carries `cell_clone`) + grant ACL + field + item relations +
 * per-cell audit — as a single handler-bound bundle.
 *
 * The handler-side twin of the `all_cell_action_specs` spec bundle and the
 * sibling of `create_standard_rpc_actions`. Assembling the five cell factories
 * here means an HTTP-RPC mount and a WS mount (or two different backends)
 * can't silently diverge on which cell verbs they expose — the
 * `spine_method_coverage` reconciliation gate enforces that the spine's live
 * mount matches its coverage manifest, and this aggregator is the single list
 * every mount draws from.
 *
 * Distinct from `create_cell_actions` (the CRUD-only factory this bundles) —
 * reach for this whenever a backend mounts the complete cell layer.
 *
 * @param deps - `CellActionDeps` (`log`, `audit`, optional `validate_data`)
 * @param options - the role schema for grant validation
 * @returns every cell `RpcAction`, in mount order
 */
export const create_all_cell_actions = (
	deps: CellActionDeps,
	options: AllCellActionsOptions,
): Array<RpcAction> => [
	...create_cell_actions(deps),
	...create_cell_grant_actions({...deps, roles: options.roles}),
	...create_cell_field_actions(deps),
	...create_cell_item_actions(deps),
	...create_cell_audit_actions(),
];
