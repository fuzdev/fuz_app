/**
 * Cell-item RPC handlers.
 *
 * Four `request_response` actions bound to the specs in
 * `auth/cell_item_action_specs.ts`:
 *
 * - `cell_item_insert` — admin / owner / editor-grant on `parent` may
 *   insert; `child` must be view-admitted. Returns
 *   `cell_item_position_taken` on `(parent_id, position)` unique
 *   violation; client refreshes bracket and retries.
 * - `cell_item_move` — admin / owner / editor-grant on `parent`. Same
 *   collision-error shape as insert.
 * - `cell_item_delete` — admin / owner / editor-grant on `parent`.
 *   Idempotent: `deleted: false` when no row matched.
 * - `cell_item_list` — bidirectional, a page of up to `limit` items whose
 *   other end the caller may view (filtered in SQL, before the limit).
 *   Forward (pass `parent_id`) is gated on `can_view_cell(parent)` and
 *   pages the items whose child is viewable (strict target-visibility).
 *   Reverse (pass `child_id`) has 2-layer authz: gate on
 *   `can_view_cell(child)`, then page the items whose parent is viewable.
 *
 * IDOR-mask 404s on cell-miss / cell-unviewable, mirroring the existence-
 * leak guards in `auth/cell_actions.ts`.
 *
 * Audit events `cell_item_insert` / `cell_item_move` / `cell_item_delete`
 * carry IDs only — see `auth/cell_item_audit_metadata.ts`.
 *
 * @module
 */

import {
	rpc_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction
} from '../actions/action_types.ts';
import { jsonrpc_errors } from '../http/jsonrpc_errors.ts';
import { is_pg_unique_violation } from '../db/pg_error.ts';
import type { ActionFactoryDeps } from './deps.ts';

import {
	cell_item_insert_action_spec,
	cell_item_move_action_spec,
	cell_item_delete_action_spec,
	cell_item_list_action_spec,
	ERROR_CELL_ITEM_POSITION_TAKEN,
	ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD,
	type CellItemInsertInput,
	type CellItemInsertOutput,
	type CellItemMoveInput,
	type CellItemMoveOutput,
	type CellItemDeleteInput,
	type CellItemDeleteOutput,
	type CellItemListInput,
	type CellItemListOutput,
	type CellItemPosition,
	type ItemJson
} from './cell_item_action_specs.ts';
import { ERROR_CELL_NOT_FOUND } from './cell_action_specs.ts';
import { cell_viewer_from_auth } from './cell_authorize.ts';
import {
	emit_cell_audit,
	require_editable_cell,
	require_viewable_cell
} from './cell_action_helpers.ts';
import { CELL_RELATION_LIST_LIMIT_DEFAULT } from './cell_relation_list_limit.ts';
import {
	query_cell_item_insert,
	query_cell_item_move,
	query_cell_item_delete,
	query_cell_item_list_for_parent,
	query_cell_item_list_for_child,
	type CellItemRow
} from '../db/cell_item_queries.ts';
import type {
	CellItemInsertAuditMetadata,
	CellItemMoveAuditMetadata,
	CellItemDeleteAuditMetadata
} from './cell_item_audit_metadata.ts';

export type CellItemActionDeps = ActionFactoryDeps;

export const to_item_json = (row: CellItemRow): ItemJson => ({
	parent_id: row.parent_id,
	// `cell.position` is a DB-shape string; brand at the wire boundary so
	// consumers can round-trip it without casting (the DB CHECK constraint
	// is the runtime validator on egress, the Zod brand is the validator
	// on ingress).
	position: row.position as CellItemPosition,
	child_id: row.child_id,
	created_at: row.created_at
});

const position_taken_error = (): ReturnType<typeof jsonrpc_errors.invalid_params> =>
	jsonrpc_errors.invalid_params('cell_item position taken', {
		reason: ERROR_CELL_ITEM_POSITION_TAKEN
	});

/** Create the four `cell_item_*` RPC actions. */
export const create_cell_item_actions = (deps: CellItemActionDeps): Array<RpcAction> => {
	const insert_handler = async (
		input: CellItemInsertInput,
		ctx: ActionActorContext
	): Promise<CellItemInsertOutput> => {
		const auth = ctx.auth;
		await require_editable_cell(ctx, auth, input.parent_id);
		// Child must be view-admitted — otherwise insert leaks existence.
		await require_viewable_cell(ctx, auth, input.child_id);
		let row: CellItemRow;
		try {
			row = await query_cell_item_insert(ctx, {
				parent_id: input.parent_id,
				position: input.position,
				child_id: input.child_id
			});
		} catch (err) {
			if (is_pg_unique_violation(err)) throw position_taken_error();
			throw err;
		}
		emit_cell_audit(ctx, deps.audit, auth, 'cell_item_insert', {
			parent_id: row.parent_id,
			position: row.position,
			child_id: row.child_id
		} satisfies CellItemInsertAuditMetadata);
		return { item: to_item_json(row) };
	};

	const move_handler = async (
		input: CellItemMoveInput,
		ctx: ActionActorContext
	): Promise<CellItemMoveOutput> => {
		const auth = ctx.auth;
		await require_editable_cell(ctx, auth, input.parent_id);
		let row: CellItemRow | null;
		try {
			row = await query_cell_item_move(ctx, input.parent_id, input.position, input.new_position);
		} catch (err) {
			if (is_pg_unique_violation(err)) throw position_taken_error();
			throw err;
		}
		if (!row) {
			// Source row missing — raced with deleter. 404 covers the gap.
			throw jsonrpc_errors.not_found('cell_item', { reason: ERROR_CELL_NOT_FOUND });
		}
		emit_cell_audit(ctx, deps.audit, auth, 'cell_item_move', {
			parent_id: row.parent_id,
			position_old: input.position,
			position_new: row.position
		} satisfies CellItemMoveAuditMetadata);
		return { item: to_item_json(row) };
	};

	const delete_handler = async (
		input: CellItemDeleteInput,
		ctx: ActionActorContext
	): Promise<CellItemDeleteOutput> => {
		const auth = ctx.auth;
		await require_editable_cell(ctx, auth, input.parent_id);
		const deleted = await query_cell_item_delete(ctx, input.parent_id, input.position);
		if (deleted) {
			emit_cell_audit(ctx, deps.audit, auth, 'cell_item_delete', {
				parent_id: deleted.parent_id,
				position: deleted.position,
				child_id: deleted.child_id
			} satisfies CellItemDeleteAuditMetadata);
		}
		return { ok: true, deleted: deleted !== null };
	};

	const list_handler = async (
		input: CellItemListInput,
		ctx: ActionContext
	): Promise<CellItemListOutput> => {
		const auth = ctx.auth;
		// exactly one endpoint — both optional on the wire, so the handler
		// holds the rule and names it in the reason
		if ((input.parent_id === undefined) === (input.child_id === undefined)) {
			throw jsonrpc_errors.invalid_params('invalid params', {
				reason: ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD
			});
		}
		// an omitted limit is the default page, either direction
		const limit = input.limit ?? CELL_RELATION_LIST_LIMIT_DEFAULT;
		// Forward listing: gate on can_view_cell(parent), then page the items
		// whose child the caller may view (strict target-visibility, in SQL
		// before the limit).
		if (input.parent_id !== undefined) {
			const parent = await require_viewable_cell(ctx, auth, input.parent_id);
			const rows = await query_cell_item_list_for_parent(
				ctx,
				cell_viewer_from_auth(auth),
				parent.id,
				{ limit, position_after: input.position_after }
			);
			return { items: rows.map(to_item_json) };
		}
		// Reverse listing: 2-layer authz. First, can_view_cell(child).
		const child = await require_viewable_cell(ctx, auth, input.child_id!);
		// Then page the items whose parent the caller may view — filtered in
		// SQL before the limit, so hidden parents never crowd out visible ones,
		// and bounded so a heavily inbound-linked child can't force an
		// unbounded read on this public endpoint.
		const rows = await query_cell_item_list_for_child(ctx, cell_viewer_from_auth(auth), child.id, {
			limit
		});
		return { items: rows.map(to_item_json) };
	};

	return [
		rpc_action(cell_item_insert_action_spec, insert_handler),
		rpc_action(cell_item_move_action_spec, move_handler),
		rpc_action(cell_item_delete_action_spec, delete_handler),
		rpc_action(cell_item_list_action_spec, list_handler)
	];
};
