/**
 * Cell-item RPC handlers.
 *
 * Four `request_response` actions bound to the specs in
 * `./cell_item_action_specs.ts`:
 *
 * - `cell_item_insert` — admin / owner / editor-grant on `parent` may
 *   insert; `child` must be view-admitted. Returns
 *   `cell_item_position_taken` on `(parent_id, position)` unique
 *   violation; client refreshes bracket and retries.
 * - `cell_item_move` — admin / owner / editor-grant on `parent`. Same
 *   collision-error shape as insert.
 * - `cell_item_delete` — admin / owner / editor-grant on `parent`.
 *   Idempotent: `deleted: false` when no row matched.
 * - `cell_item_list` — bidirectional. Forward (pass `parent_id`) is
 *   gated on `can_view_cell(parent)` and filters children to those the
 *   caller may view (strict target-visibility, batched). Reverse (pass
 *   `child_id`) has 2-layer authz: gate on `can_view_cell(child)`, then
 *   filter rows by `can_view_cell(parent)`.
 *
 * IDOR-mask 404s on cell-miss / cell-unviewable, mirroring the existence-
 * leak guards in `cell_actions.ts`.
 *
 * Audit events `cell_item_insert` / `cell_item_move` / `cell_item_delete`
 * carry IDs only — see `./cell_item_audit_metadata.ts`.
 *
 * @module
 */

import {
	rpc_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction,
} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {is_pg_unique_violation} from '../db/pg_error.js';
import type {RouteFactoryDeps} from './deps.js';

import {
	cell_item_insert_action_spec,
	cell_item_move_action_spec,
	cell_item_delete_action_spec,
	cell_item_list_action_spec,
	ERROR_CELL_ITEM_POSITION_TAKEN,
	type CellItemInsertInput,
	type CellItemInsertOutput,
	type CellItemMoveInput,
	type CellItemMoveOutput,
	type CellItemDeleteInput,
	type CellItemDeleteOutput,
	type CellItemListInput,
	type CellItemListOutput,
	type CellItemPosition,
	type ItemJson,
} from './cell_item_action_specs.js';
import {ERROR_CELL_NOT_FOUND} from './cell_action_specs.js';
import {can_view_cell, can_edit_cell} from './cell_authorize.js';
import {filter_visible_target_ids} from './cell_relation_visibility.js';
import {query_cell_get} from '../db/cell_queries.js';
import {query_cell_grant_list_for_cell} from '../db/cell_grant_queries.js';
import {
	query_cell_item_insert,
	query_cell_item_move,
	query_cell_item_delete,
	query_cell_item_list_for_parent,
	query_cell_item_list_for_child,
	type CellItemRow,
} from '../db/cell_item_queries.js';
import type {
	CellItemInsertAuditMetadata,
	CellItemMoveAuditMetadata,
	CellItemDeleteAuditMetadata,
} from './cell_item_audit_metadata.js';

export type CellItemActionDeps = Pick<RouteFactoryDeps, 'log' | 'audit'>;

export const to_item_json = (row: CellItemRow): ItemJson => ({
	parent_id: row.parent_id,
	// `cell.position` is a DB-shape string; brand at the wire boundary so
	// consumers can round-trip it without casting (the DB CHECK constraint
	// is the runtime validator on egress, the Zod brand is the validator
	// on ingress).
	position: row.position as CellItemPosition,
	child_id: row.child_id,
	created_at: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
});

const position_taken_error = (): ReturnType<typeof jsonrpc_errors.invalid_params> =>
	jsonrpc_errors.invalid_params('cell_item position taken', {
		reason: ERROR_CELL_ITEM_POSITION_TAKEN,
	});

/** Create the four `cell_item_*` RPC actions. */
export const create_cell_item_actions = (deps: CellItemActionDeps): Array<RpcAction> => {
	const insert_handler = async (
		input: CellItemInsertInput,
		ctx: ActionActorContext,
	): Promise<CellItemInsertOutput> => {
		const auth = ctx.auth;
		const parent = await query_cell_get(ctx, input.parent_id);
		if (!parent) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const parent_grants = await query_cell_grant_list_for_cell(ctx, parent.id);
		if (!can_edit_cell(auth, parent, parent_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const child = await query_cell_get(ctx, input.child_id);
		if (!child) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Child must be view-admitted — otherwise insert leaks existence.
		const child_grants = await query_cell_grant_list_for_cell(ctx, child.id);
		if (!can_view_cell(auth, child, child_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		let row: CellItemRow;
		try {
			row = await query_cell_item_insert(ctx, {
				parent_id: input.parent_id,
				position: input.position,
				child_id: input.child_id,
			});
		} catch (err) {
			if (is_pg_unique_violation(err)) throw position_taken_error();
			throw err;
		}
		deps.audit.emit(ctx, {
			event_type: 'cell_item_insert',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				parent_id: row.parent_id,
				position: row.position,
				child_id: row.child_id,
			} satisfies CellItemInsertAuditMetadata,
		});
		return {item: to_item_json(row)};
	};

	const move_handler = async (
		input: CellItemMoveInput,
		ctx: ActionActorContext,
	): Promise<CellItemMoveOutput> => {
		const auth = ctx.auth;
		const parent = await query_cell_get(ctx, input.parent_id);
		if (!parent) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const parent_grants = await query_cell_grant_list_for_cell(ctx, parent.id);
		if (!can_edit_cell(auth, parent, parent_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		let row: CellItemRow | null;
		try {
			row = await query_cell_item_move(ctx, input.parent_id, input.position, input.new_position);
		} catch (err) {
			if (is_pg_unique_violation(err)) throw position_taken_error();
			throw err;
		}
		if (!row) {
			// Source row missing — raced with deleter. 404 covers the gap.
			throw jsonrpc_errors.not_found('cell_item', {reason: ERROR_CELL_NOT_FOUND});
		}
		deps.audit.emit(ctx, {
			event_type: 'cell_item_move',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				parent_id: row.parent_id,
				position_old: input.position,
				position_new: row.position,
			} satisfies CellItemMoveAuditMetadata,
		});
		return {item: to_item_json(row)};
	};

	const delete_handler = async (
		input: CellItemDeleteInput,
		ctx: ActionActorContext,
	): Promise<CellItemDeleteOutput> => {
		const auth = ctx.auth;
		const parent = await query_cell_get(ctx, input.parent_id);
		if (!parent) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const parent_grants = await query_cell_grant_list_for_cell(ctx, parent.id);
		if (!can_edit_cell(auth, parent, parent_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const deleted = await query_cell_item_delete(ctx, input.parent_id, input.position);
		if (deleted) {
			deps.audit.emit(ctx, {
				event_type: 'cell_item_delete',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {
					parent_id: deleted.parent_id,
					position: deleted.position,
					child_id: deleted.child_id,
				} satisfies CellItemDeleteAuditMetadata,
			});
		}
		return {ok: true, deleted: deleted !== null};
	};

	const list_handler = async (
		input: CellItemListInput,
		ctx: ActionContext,
	): Promise<CellItemListOutput> => {
		const auth = ctx.auth;
		// Forward listing: gate on can_view_cell(parent), then filter the
		// children to those the caller may view (strict target-visibility).
		if (input.parent_id !== undefined) {
			const parent = await query_cell_get(ctx, input.parent_id);
			if (!parent) {
				throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
			}
			const parent_grants = auth ? await query_cell_grant_list_for_cell(ctx, parent.id) : null;
			if (!can_view_cell(auth, parent, parent_grants)) {
				throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
			}
			const rows = await query_cell_item_list_for_parent(ctx, parent.id, {
				limit: input.limit,
				position_after: input.position_after,
			});
			const visible_children = await filter_visible_target_ids(
				ctx,
				auth,
				rows.map((r) => r.child_id),
			);
			return {items: rows.filter((r) => visible_children.has(r.child_id)).map(to_item_json)};
		}
		// Reverse listing: 2-layer authz. First, can_view_cell(child).
		const child = await query_cell_get(ctx, input.child_id!);
		if (!child) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const child_grants = auth ? await query_cell_grant_list_for_cell(ctx, child.id) : null;
		if (!can_view_cell(auth, child, child_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Then filter rows by per-parent can_view_cell. Batched (not N+1):
		// one bulk visibility filter over all parent ids, same as the forward
		// branch. Bounded by `limit` at the query so a heavily inbound-linked
		// child can't force an unbounded fetch on this public endpoint.
		const rows = await query_cell_item_list_for_child(ctx, child.id, {limit: input.limit});
		const visible_parents = await filter_visible_target_ids(
			ctx,
			auth,
			rows.map((r) => r.parent_id),
		);
		return {items: rows.filter((r) => visible_parents.has(r.parent_id)).map(to_item_json)};
	};

	return [
		rpc_action(cell_item_insert_action_spec, insert_handler),
		rpc_action(cell_item_move_action_spec, move_handler),
		rpc_action(cell_item_delete_action_spec, delete_handler),
		rpc_action(cell_item_list_action_spec, list_handler),
	];
};
