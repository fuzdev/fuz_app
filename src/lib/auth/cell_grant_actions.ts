/**
 * Cell-grant ACL RPC handlers.
 *
 * Three `request_response` actions bound to specs in
 * `auth/cell_grant_action_specs.ts`:
 *
 * Grant management is **manage-tier only** (`can_manage_cell` = admin /
 * owner). Editor-grant holders may edit a cell's content + relations but
 * cannot manage its grants — delegating the share list would let an editor
 * widen access or mint peer editors and escape the manager's authority.
 *
 * - `cell_grant_create` — admin / owner only. Validates role-shaped
 *   principals against the role schema; rejects owner-as-principal.
 *   Actor-shaped principals carry a pre-resolved `actor_id` (callers pick
 *   via `actor_search`). Idempotent — re-granting the same principal
 *   updates `level` via UPSERT.
 * - `cell_grant_revoke` — admin / owner, plus self for actor-shaped grants
 *   ("leave shared cell"). Returns `still_admitted` computed by re-running
 *   `can_view_cell` against the remaining grants.
 * - `cell_grant_list` — admin / owner only. Viewers and editors alike get
 *   the IDOR-mask 404 (the share list is the manager's to curate).
 *
 * All three 404 with `cell_not_found` on cell-miss / cell-unviewable, and
 * with `cell_grant_not_found` on grant-miss, mirroring the existence-leak
 * guards in `auth/cell_actions.ts`.
 *
 * Audit events `cell_grant_create` / `cell_grant_revoke` carry IDs only
 * (no display-name snapshots); see `auth/cell_grant_audit_metadata.ts`.
 *
 * @module
 */

import {rpc_action, type ActionActorContext, type RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import type {RoleSchemaResult} from './role_schema.js';
import type {RouteFactoryDeps} from './deps.js';

import {
	cell_grant_create_action_spec,
	cell_grant_revoke_action_spec,
	cell_grant_list_action_spec,
	ERROR_CELL_GRANT_NOT_FOUND,
	ERROR_CELL_GRANT_PRINCIPAL_IS_OWNER,
	ERROR_CELL_GRANT_UNKNOWN_ROLE,
	type CellGrantCreateInput,
	type CellGrantCreateOutput,
	type CellGrantRevokeInput,
	type CellGrantRevokeOutput,
	type CellGrantListInput,
	type CellGrantListOutput,
	type GrantJson,
} from './cell_grant_action_specs.js';
import {ERROR_CELL_NOT_FOUND} from './cell_action_specs.js';
import {can_view_cell, can_manage_cell} from './cell_authorize.js';
import {query_cell_get, type CellRow} from '../db/cell_queries.js';
import {
	query_cell_grant_create,
	query_cell_grant_get,
	query_cell_grant_delete,
	query_cell_grant_list_for_cell,
	type CellGrantRow,
	type CellGrantPrincipalQueryInput,
} from '../db/cell_grant_queries.js';
import type {
	CellGrantCreateAuditMetadata,
	CellGrantRevokeAuditMetadata,
	CellGrantPrincipalAuditMetadata,
} from './cell_grant_audit_metadata.js';

/**
 * Dependencies for `create_cell_grant_actions`.
 *
 * `roles` is the role schema — read for the role-validity gate on
 * `cell_grant_create`. The other slots match `CellActionDeps` so
 * audit-log emit goes through the same fire-and-forget plumbing.
 */
export type CellGrantActionDeps = Pick<RouteFactoryDeps, 'log' | 'audit'> & {
	roles: RoleSchemaResult;
};

export const to_grant_json = (row: CellGrantRow): GrantJson => ({
	id: row.id,
	cell_id: row.cell_id,
	level: row.level,
	actor_id: row.actor_id,
	role: row.role,
	scope_id: row.scope_id,
	granted_by: row.granted_by,
	created_at: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
});

/**
 * Build the audit-metadata principal envelope from a `cell_grant` row.
 * Picks the actor-shape branch when `actor_id IS NOT NULL`,
 * otherwise the role-shape branch. The CHECK constraint guarantees
 * exactly one of the two holds.
 */
const principal_from_row = (row: CellGrantRow): CellGrantPrincipalAuditMetadata =>
	row.actor_id !== null ? {actor_id: row.actor_id} : {role: row.role!, scope_id: row.scope_id};

/**
 * Map the wire-input principal to the query-input shape. Both arms pass
 * through unchanged — the wire and query shapes are aligned (pickers run
 * `actor_search` upstream and submit the resolved id).
 */
const to_query_principal = (
	principal: CellGrantCreateInput['principal'],
): CellGrantPrincipalQueryInput => {
	if (principal.kind === 'actor') {
		return {kind: 'actor', actor_id: principal.actor_id};
	}
	return {
		kind: 'role',
		role: principal.role,
		scope_id: principal.scope_id ?? null,
	};
};

/**
 * Reject the create when the principal actor is the cell's owner.
 * Skipped for role-shaped principals (a role isn't a single actor) and
 * for system cells (`created_by IS NULL`). With actor-grain principals
 * the comparison is direct — `cell.created_by` is already an actor id.
 */
const assert_principal_is_not_owner = (
	cell: CellRow,
	principal: CellGrantPrincipalQueryInput,
): void => {
	if (principal.kind !== 'actor') return;
	if (cell.created_by === null) return;
	if (cell.created_by === principal.actor_id) {
		throw jsonrpc_errors.invalid_params('grant principal is the cell owner', {
			reason: ERROR_CELL_GRANT_PRINCIPAL_IS_OWNER,
		});
	}
};

/** Create the three `cell_grant_*` RPC actions. */
export const create_cell_grant_actions = (deps: CellGrantActionDeps): Array<RpcAction> => {
	const {roles} = deps;

	const create_handler = async (
		input: CellGrantCreateInput,
		ctx: ActionActorContext,
	): Promise<CellGrantCreateOutput> => {
		const auth = ctx.auth;
		const cell = await query_cell_get(ctx, input.cell_id);
		if (!cell) {
			// IDOR mask: same code as cell_get's miss/unviewable so probing
			// for cells via the share endpoint is no easier than via cell_get.
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Grant management is manage-tier only (admin / owner). Editor-grant
		// holders may edit the cell's content + relations but cannot mint
		// grants of any level — delegating the share list would let editors
		// widen access (or mint peer editors) and escape the manager's
		// authority. Non-managers get the IDOR-mask 404, same as a non-viewer
		// on the read path.
		if (!can_manage_cell(auth, cell)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const principal = to_query_principal(input.principal);
		// Role validity — only relevant for role-shaped principals; reject
		// before insert so dead grant rows nothing can match are foreclosed.
		if (principal.kind === 'role' && !roles.role_specs.has(principal.role)) {
			throw jsonrpc_errors.invalid_params(`unknown role "${principal.role}"`, {
				reason: ERROR_CELL_GRANT_UNKNOWN_ROLE,
			});
		}
		assert_principal_is_not_owner(cell, principal);
		const row = await query_cell_grant_create(ctx, {
			cell_id: cell.id,
			level: input.level,
			principal,
			granted_by: auth.actor.id,
		});
		deps.audit.emit(ctx, {
			event_type: 'cell_grant_create',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				cell_id: row.cell_id,
				grant_id: row.id,
				level: row.level,
				principal: principal_from_row(row),
			} satisfies CellGrantCreateAuditMetadata,
		});
		return {grant: to_grant_json(row)};
	};

	const revoke_handler = async (
		input: CellGrantRevokeInput,
		ctx: ActionActorContext,
	): Promise<CellGrantRevokeOutput> => {
		const auth = ctx.auth;
		const grant = await query_cell_grant_get(ctx, input.grant_id);
		if (!grant) {
			throw jsonrpc_errors.not_found('cell grant', {reason: ERROR_CELL_GRANT_NOT_FOUND});
		}
		const cell = await query_cell_get(ctx, grant.cell_id);
		if (!cell) {
			// Grant exists but its cell is gone (soft-deleted out from under
			// it). Treat as a grant miss for the IDOR mask.
			throw jsonrpc_errors.not_found('cell grant', {reason: ERROR_CELL_GRANT_NOT_FOUND});
		}
		const is_manager = can_manage_cell(auth, cell);
		// "Is the grant being revoked the caller's own actor-shaped grant?"
		// Self-revoke is the leave-shared-cell affordance — open regardless of
		// authority path. Owner-with-self-grant can't happen
		// (`assert_principal_is_not_owner` blocks it at create time).
		const is_self_actor_grant = grant.actor_id !== null && grant.actor_id === auth.actor.id;
		// Grant management is manage-tier only (admin / owner); editor-grant
		// holders cannot revoke grants (mirrors the create gate). The sole
		// exception is self-revoke. Non-qualifying callers get the IDOR mask.
		if (!is_manager && !is_self_actor_grant) {
			throw jsonrpc_errors.not_found('cell grant', {reason: ERROR_CELL_GRANT_NOT_FOUND});
		}
		const deleted = await query_cell_grant_delete(ctx, grant.id);
		if (!deleted) {
			// Raced with another revoker. Same shape as cell_actions.ts —
			// 404 covers the gap.
			throw jsonrpc_errors.not_found('cell grant', {reason: ERROR_CELL_GRANT_NOT_FOUND});
		}
		// Recompute admit state against the remaining grants. Always true
		// for non-self revokes (caller didn't admit via this row), but the
		// recompute is uniform shape — let `can_view_cell` decide.
		const remaining = await query_cell_grant_list_for_cell(ctx, cell.id);
		const still_admitted = can_view_cell(auth, cell, remaining);
		const audit_metadata: CellGrantRevokeAuditMetadata = {
			cell_id: deleted.cell_id,
			grant_id: deleted.id,
			level: deleted.level,
			principal: principal_from_row(deleted),
			...(is_self_actor_grant ? {self: true as const} : {}),
		};
		deps.audit.emit(ctx, {
			event_type: 'cell_grant_revoke',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: audit_metadata,
		});
		return {ok: true, still_admitted};
	};

	const list_handler = async (
		input: CellGrantListInput,
		ctx: ActionActorContext,
	): Promise<CellGrantListOutput> => {
		const auth = ctx.auth;
		const cell = await query_cell_get(ctx, input.cell_id);
		if (!cell) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Same authz gate as create — manage tier only (admin / owner). The
		// share list is the manager's to curate; viewers and editors alike
		// fall through to the IDOR-mask 404.
		if (!can_manage_cell(auth, cell)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const grants = await query_cell_grant_list_for_cell(ctx, cell.id);
		return {grants: grants.map(to_grant_json)};
	};

	return [
		rpc_action(cell_grant_create_action_spec, create_handler),
		rpc_action(cell_grant_revoke_action_spec, revoke_handler),
		rpc_action(cell_grant_list_action_spec, list_handler),
	];
};
