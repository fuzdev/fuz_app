/**
 * Cell-field RPC handlers.
 *
 * Three `request_response` actions bound to the specs in
 * `./cell_field_action_specs.ts`:
 *
 * - `cell_field_set` — admin / owner / editor-grant on `source` may set;
 *   `target` must be view-admitted (so a caller can't link to a cell they
 *   couldn't otherwise see). Idempotent UPSERT on `(source_id, name)`.
 * - `cell_field_delete` — admin / owner / editor-grant on `source`.
 *   Idempotent: `deleted: false` when no row matched.
 * - `cell_field_list` — bidirectional. Forward (pass `source_id`) is
 *   gated on `can_view_cell(source)` and filters targets to those the
 *   caller may view (strict target-visibility, batched). Reverse (pass
 *   `target_id`) has 2-layer authz: gate on `can_view_cell(target)`
 *   first, then filter rows by `can_view_cell(source)`.
 *
 * IDOR-mask 404s on cell-miss / cell-unviewable, mirroring the existence-
 * leak guards in `cell_actions.ts` / `cell_grant_actions.ts`.
 *
 * Audit events `cell_field_set` / `cell_field_delete` carry IDs only —
 * see `./cell_field_audit_metadata.ts`.
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
import type {RouteFactoryDeps} from './deps.js';

import {
	cell_field_set_action_spec,
	cell_field_delete_action_spec,
	cell_field_list_action_spec,
	type CellFieldSetInput,
	type CellFieldSetOutput,
	type CellFieldDeleteInput,
	type CellFieldDeleteOutput,
	type CellFieldListInput,
	type CellFieldListOutput,
	type FieldJson,
} from './cell_field_action_specs.js';
import {ERROR_CELL_NOT_FOUND} from './cell_action_specs.js';
import {can_view_cell, can_edit_cell} from './cell_authorize.js';
import {filter_visible_target_ids} from './cell_relation_visibility.js';
import {query_cell_get} from '../db/cell_queries.js';
import {query_cell_grant_list_for_cell} from '../db/cell_grant_queries.js';
import {
	query_cell_field_set,
	query_cell_field_delete,
	query_cell_field_list_for_source,
	query_cell_field_list_for_target,
	type CellFieldRow,
} from '../db/cell_field_queries.js';
import type {
	CellFieldSetAuditMetadata,
	CellFieldDeleteAuditMetadata,
} from './cell_field_audit_metadata.js';

export type CellFieldActionDeps = Pick<RouteFactoryDeps, 'log' | 'audit'>;

export const to_field_json = (row: CellFieldRow): FieldJson => ({
	source_id: row.source_id,
	name: row.name,
	target_id: row.target_id,
	created_at: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
});

/** Create the three `cell_field_*` RPC actions. */
export const create_cell_field_actions = (deps: CellFieldActionDeps): Array<RpcAction> => {
	const set_handler = async (
		input: CellFieldSetInput,
		ctx: ActionActorContext,
	): Promise<CellFieldSetOutput> => {
		const auth = ctx.auth;
		const source = await query_cell_get(ctx, input.source_id);
		if (!source) {
			// IDOR mask: same code as cell_get's miss/unviewable.
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const source_grants = await query_cell_grant_list_for_cell(ctx, source.id);
		if (!can_edit_cell(auth, source, source_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const target = await query_cell_get(ctx, input.target_id);
		if (!target) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Target must be view-admitted — otherwise a caller could probe for
		// the existence of private cells by trying to point a field at them
		// (and observe whether the call 404s vs. succeeds).
		const target_grants = await query_cell_grant_list_for_cell(ctx, target.id);
		if (!can_view_cell(auth, target, target_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const row = await query_cell_field_set(ctx, {
			source_id: input.source_id,
			name: input.name,
			target_id: input.target_id,
		});
		deps.audit.emit(ctx, {
			event_type: 'cell_field_set',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				source_id: row.source_id,
				name: row.name,
				target_id: row.target_id,
			} satisfies CellFieldSetAuditMetadata,
		});
		return {field: to_field_json(row)};
	};

	const delete_handler = async (
		input: CellFieldDeleteInput,
		ctx: ActionActorContext,
	): Promise<CellFieldDeleteOutput> => {
		const auth = ctx.auth;
		const source = await query_cell_get(ctx, input.source_id);
		if (!source) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const source_grants = await query_cell_grant_list_for_cell(ctx, source.id);
		if (!can_edit_cell(auth, source, source_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const deleted = await query_cell_field_delete(ctx, input.source_id, input.name);
		if (deleted) {
			deps.audit.emit(ctx, {
				event_type: 'cell_field_delete',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {
					source_id: deleted.source_id,
					name: deleted.name,
					target_id: deleted.target_id,
				} satisfies CellFieldDeleteAuditMetadata,
			});
		}
		return {ok: true, deleted: deleted !== null};
	};

	const list_handler = async (
		input: CellFieldListInput,
		ctx: ActionContext,
	): Promise<CellFieldListOutput> => {
		const auth = ctx.auth;
		// Forward listing: gate on can_view_cell(source), then filter the
		// targets to those the caller may view (strict target-visibility).
		if (input.source_id !== undefined) {
			const source = await query_cell_get(ctx, input.source_id);
			if (!source) {
				throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
			}
			const source_grants = auth ? await query_cell_grant_list_for_cell(ctx, source.id) : null;
			if (!can_view_cell(auth, source, source_grants)) {
				throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
			}
			const rows = await query_cell_field_list_for_source(ctx, source.id, {
				limit: input.limit,
				name_after: input.name_after,
			});
			const visible_targets = await filter_visible_target_ids(
				ctx,
				auth,
				rows.map((r) => r.target_id),
			);
			return {fields: rows.filter((r) => visible_targets.has(r.target_id)).map(to_field_json)};
		}
		// Reverse listing: 2-layer authz. First, can_view_cell(target).
		// Without this, the count of returned rows leaks "at least N
		// viewable cells link to this private target."
		const target = await query_cell_get(ctx, input.target_id!);
		if (!target) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const target_grants = auth ? await query_cell_grant_list_for_cell(ctx, target.id) : null;
		if (!can_view_cell(auth, target, target_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Then filter rows by per-source can_view_cell. Batched (not N+1):
		// one bulk visibility filter over all source ids, same as the forward
		// branch. Bounded by `limit` at the query so a heavily inbound-linked
		// target can't force an unbounded fetch on this public endpoint.
		const rows = await query_cell_field_list_for_target(ctx, target.id, {limit: input.limit});
		const visible_sources = await filter_visible_target_ids(
			ctx,
			auth,
			rows.map((r) => r.source_id),
		);
		return {fields: rows.filter((r) => visible_sources.has(r.source_id)).map(to_field_json)};
	};

	return [
		rpc_action(cell_field_set_action_spec, set_handler),
		rpc_action(cell_field_delete_action_spec, delete_handler),
		rpc_action(cell_field_list_action_spec, list_handler),
	];
};
