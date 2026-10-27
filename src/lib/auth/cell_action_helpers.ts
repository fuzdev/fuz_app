/**
 * The cell verbs' shared gates and audit emit.
 *
 * Every gate loads the cell, reads its grants where the tier consults them,
 * applies the tier's predicate, and answers a miss and a denial with the same
 * `cell_not_found` 404. A 403 on denial would confirm the row exists, so a
 * caller with no authority could walk ids and read a private cell's existence
 * off the difference; one wire shape for both is the IDOR mask. Each gate
 * returns the loaded row, so a handler that needs it doesn't re-read it.
 *
 * Twins of the Rust `fuz_cell_actions` helpers; `require_viewable_cell`
 * covers both of Rust's authenticated and `_optional_auth` read gates.
 *
 * @module
 */

import type { ActionActorContext, ActionContext } from '../actions/action_types.ts';
import { jsonrpc_errors } from '../http/jsonrpc_errors.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { query_cell_get, type CellRow } from '../db/cell_queries.ts';
import { query_cell_grant_list_for_cell, type CellGrantRow } from '../db/cell_grant_queries.ts';
import type { Uuid } from '../primitive_schemas.ts';
import type { AuditLogInput } from './audit_log_schema.ts';
import type { AuditEmitter } from './audit_emitter.ts';
import { ERROR_CELL_NOT_FOUND } from './cell_action_specs.ts';
import { can_edit_cell, can_manage_cell, can_view_cell } from './cell_authorize.ts';
import type { RequestActorContext, RequestContext } from './request_context.ts';

/**
 * The 404 every cell gate answers for a miss and a denial alike.
 *
 * @returns the `cell_not_found` JSON-RPC error
 */
export const cell_not_found_error = (): ReturnType<typeof jsonrpc_errors.not_found> =>
	jsonrpc_errors.not_found('cell', { reason: ERROR_CELL_NOT_FOUND });

/**
 * The `load → 404 → grants → predicate → 404` sequence the grant-consulting
 * tiers share. Grants are read from the loaded row's id, and only for an
 * authenticated caller: only the public arm of `can_view_cell` admits a
 * `null` caller, so a grant read would be waste.
 */
const require_admitted_cell = async (
	deps: QueryDeps,
	auth: RequestContext | null,
	cell_id: Uuid,
	admits: (
		auth: RequestContext | null,
		cell: CellRow,
		grants: ReadonlyArray<CellGrantRow> | null
	) => boolean
): Promise<CellRow> => {
	const row = await query_cell_get(deps, cell_id);
	if (!row) throw cell_not_found_error();
	const grants = auth ? await query_cell_grant_list_for_cell(deps, row.id) : null;
	if (!admits(auth, row, grants)) throw cell_not_found_error();
	return row;
};

/**
 * Load a cell and gate the caller on `can_view_cell`, 404-masking a miss and a
 * denial alike.
 *
 * The read tier: a create's parent, a clone's source, the far endpoint a write
 * links to (so a link is no existence oracle), and the endpoints of the
 * public relation lists, where `auth` may be `null`.
 *
 * @param deps - query deps
 * @param auth - the caller, or `null` when unauthenticated
 * @param cell_id - the cell to load
 * @returns the loaded row
 * @throws the `cell_not_found` 404 on a miss or a denial
 */
export const require_viewable_cell = (
	deps: QueryDeps,
	auth: RequestContext | null,
	cell_id: Uuid
): Promise<CellRow> => require_admitted_cell(deps, auth, cell_id, can_view_cell);

/**
 * Load a cell and gate the caller on `can_edit_cell`, 404-masking a miss and a
 * denial alike.
 *
 * The write tier: `cell_update` / `cell_delete`, the source a field write
 * writes, and the parent every item mutation writes.
 *
 * @param deps - query deps
 * @param auth - the caller
 * @param cell_id - the cell to load
 * @returns the loaded row
 * @throws the `cell_not_found` 404 on a miss or a denial
 */
export const require_editable_cell = (
	deps: QueryDeps,
	auth: RequestActorContext,
	cell_id: Uuid
): Promise<CellRow> => require_admitted_cell(deps, auth, cell_id, can_edit_cell);

/**
 * Load a cell and gate the caller on `can_manage_cell`, 404-masking a miss and
 * a denial alike.
 *
 * The manage tier: `cell_audit_list`, `cell_grant_create`, `cell_grant_list`.
 * Manage is admin-or-owner and not a grant level, so no grant is read. A
 * viewer or an editor gets the same mask a stranger does: an audit timeline
 * and a share list say who touched the cell, which is more sensitive than the
 * content.
 *
 * @param deps - query deps
 * @param auth - the caller
 * @param cell_id - the cell to load
 * @returns the loaded row
 * @throws the `cell_not_found` 404 on a miss or a denial
 */
export const require_manageable_cell = async (
	deps: QueryDeps,
	auth: RequestActorContext,
	cell_id: Uuid
): Promise<CellRow> => {
	const row = await query_cell_get(deps, cell_id);
	if (!row || !can_manage_cell(auth, row)) throw cell_not_found_error();
	return row;
};

/**
 * Emit a cell-domain audit event for the caller, with `actor_id`,
 * `account_id`, and `ip` lifted from `auth` and `ctx`. `metadata` is the
 * event's own envelope.
 *
 * @param ctx - the action context
 * @param audit - the bound audit emitter
 * @param auth - the caller
 * @param event_type - the cell event
 * @param metadata - the event's metadata envelope
 * @mutates `audit_log` table - inserts the row through `audit.emit`
 */
export const emit_cell_audit = <T extends string>(
	ctx: ActionContext | ActionActorContext,
	audit: AuditEmitter,
	auth: RequestActorContext,
	event_type: T,
	metadata: AuditLogInput<T>['metadata']
): void => {
	audit.emit(ctx, {
		event_type,
		actor_id: auth.actor.id,
		account_id: auth.account.id,
		ip: ctx.client_ip,
		metadata
	});
};
