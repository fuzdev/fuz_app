/**
 * `cell_audit_list` handler — per-cell audit timeline read.
 *
 * Authz is **manage-tier** (`can_manage_cell` = admin / owner), NOT
 * `can_view_cell`. The timeline surfaces the `actor_id` of every account
 * that touched the cell (including via `cell_field` / `cell_item` / clone
 * edges where the cell is the target / child / source); exposing that to
 * mere viewers — or, for a public cell, to any authenticated caller —
 * leaks who-touched-what. Gating to admin / owner mirrors
 * `cell_grant_list` ("the audit trail is the manager's to read"). Misses +
 * unauthorized reads both 404 with `cell_not_found` — private-cell
 * existence stays masked. No audit side effect (read-only).
 *
 * @module
 */

import {rpc_action, type ActionActorContext, type RpcAction} from '../actions/action_rpc.ts';
import {jsonrpc_errors} from '../http/jsonrpc_errors.ts';
import type {AuditLogEvent} from './audit_log_schema.ts';

import {
	cell_audit_list_action_spec,
	CELL_AUDIT_LIST_DEFAULT_LIMIT,
	type CellAuditEventJson,
	type CellAuditListInput,
	type CellAuditListOutput,
} from './cell_audit_action_specs.ts';
import {ERROR_CELL_NOT_FOUND} from './cell_action_specs.ts';
import {query_cell_get} from '../db/cell_queries.ts';
import {query_audit_log_list_by_cell} from '../db/cell_audit_queries.ts';
import {can_manage_cell} from './cell_authorize.ts';

/**
 * Project a DB row onto the narrowed wire shape. `account_id` /
 * `target_account_id` / `target_actor_id` / `metadata` / `ip` are
 * deliberately omitted — see `CellAuditEventJson` docstring for the
 * rationale.
 */
const to_cell_audit_event_json = (row: AuditLogEvent): CellAuditEventJson => ({
	id: row.id,
	seq: row.seq,
	event_type: row.event_type,
	outcome: row.outcome,
	actor_id: row.actor_id,
	created_at:
		typeof row.created_at === 'string' ? row.created_at : (row.created_at as Date).toISOString(),
});

export const create_cell_audit_actions = (): Array<RpcAction> => {
	const handler = async (
		input: CellAuditListInput,
		ctx: ActionActorContext,
	): Promise<CellAuditListOutput> => {
		const auth = ctx.auth;
		const cell = await query_cell_get(ctx, input.cell_id);
		if (!cell) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Manage-tier gate (admin / owner). A populated timeline leaks both
		// the existence of the cell and the actor IDs that touched it (incl.
		// across `cell_field` / `cell_item` / clone edges), so viewers — and
		// any authed caller on a public cell — must NOT read it. Non-managers
		// get the same 404 as a non-viewer on `cell_get` (IDOR mask). Grants
		// aren't consulted (manage tier is owner/admin only).
		if (!can_manage_cell(auth, cell)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const rows = await query_audit_log_list_by_cell(ctx, cell.id, {
			limit: CELL_AUDIT_LIST_DEFAULT_LIMIT,
		});
		return {events: rows.map(to_cell_audit_event_json)};
	};

	return [rpc_action(cell_audit_list_action_spec, handler)];
};
