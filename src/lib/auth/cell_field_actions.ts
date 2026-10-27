/**
 * Cell-field RPC handlers.
 *
 * Three `request_response` actions bound to the specs in
 * `auth/cell_field_action_specs.ts`:
 *
 * - `cell_field_set` — admin / owner / editor-grant on `source` may set;
 *   `target` must be view-admitted (so a caller can't link to a cell they
 *   couldn't otherwise see). Idempotent UPSERT on `(source_id, name)`.
 * - `cell_field_delete` — admin / owner / editor-grant on `source`.
 *   Idempotent: `deleted: false` when no row matched.
 * - `cell_field_list` — bidirectional, a page of up to `limit` fields
 *   whose other end the caller may view (filtered in SQL, before the
 *   limit). Forward (pass `source_id`) is gated on `can_view_cell(source)`
 *   and pages the fields whose target is viewable (strict
 *   target-visibility). Reverse (pass `target_id`) has 2-layer authz: gate
 *   on `can_view_cell(target)` first, then page the fields whose source is
 *   viewable.
 *
 * IDOR-mask 404s on cell-miss / cell-unviewable, mirroring the existence-
 * leak guards in `auth/cell_actions.ts` / `auth/cell_grant_actions.ts`.
 *
 * Audit events `cell_field_set` / `cell_field_delete` carry IDs only —
 * see `auth/cell_field_audit_metadata.ts`.
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
import type { ActionFactoryDeps } from './deps.ts';

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
	ERROR_CELL_FIELD_LIST_REQUIRES_SOURCE_OR_TARGET
} from './cell_field_action_specs.ts';
import { cell_viewer_from_auth } from './cell_authorize.ts';
import {
	emit_cell_audit,
	require_editable_cell,
	require_viewable_cell
} from './cell_action_helpers.ts';
import { CELL_RELATION_LIST_LIMIT_DEFAULT } from './cell_relation_list_limit.ts';
import {
	query_cell_field_set,
	query_cell_field_delete,
	query_cell_field_list_for_source,
	query_cell_field_list_for_target,
	type CellFieldRow
} from '../db/cell_field_queries.ts';
import type {
	CellFieldSetAuditMetadata,
	CellFieldDeleteAuditMetadata
} from './cell_field_audit_metadata.ts';

export type CellFieldActionDeps = ActionFactoryDeps;

export const to_field_json = (row: CellFieldRow): FieldJson => ({
	source_id: row.source_id,
	name: row.name,
	target_id: row.target_id,
	created_at: row.created_at
});

/** Create the three `cell_field_*` RPC actions. */
export const create_cell_field_actions = (deps: CellFieldActionDeps): Array<RpcAction> => {
	const set_handler = async (
		input: CellFieldSetInput,
		ctx: ActionActorContext
	): Promise<CellFieldSetOutput> => {
		const auth = ctx.auth;
		await require_editable_cell(ctx, auth, input.source_id);
		// Target must be view-admitted — otherwise a caller could probe for
		// the existence of private cells by trying to point a field at them
		// (and observe whether the call 404s vs. succeeds).
		await require_viewable_cell(ctx, auth, input.target_id);
		const row = await query_cell_field_set(ctx, {
			source_id: input.source_id,
			name: input.name,
			target_id: input.target_id
		});
		emit_cell_audit(ctx, deps.audit, auth, 'cell_field_set', {
			source_id: row.source_id,
			name: row.name,
			target_id: row.target_id
		} satisfies CellFieldSetAuditMetadata);
		return { field: to_field_json(row) };
	};

	const delete_handler = async (
		input: CellFieldDeleteInput,
		ctx: ActionActorContext
	): Promise<CellFieldDeleteOutput> => {
		const auth = ctx.auth;
		await require_editable_cell(ctx, auth, input.source_id);
		const deleted = await query_cell_field_delete(ctx, input.source_id, input.name);
		if (deleted) {
			emit_cell_audit(ctx, deps.audit, auth, 'cell_field_delete', {
				source_id: deleted.source_id,
				name: deleted.name,
				target_id: deleted.target_id
			} satisfies CellFieldDeleteAuditMetadata);
		}
		return { ok: true, deleted: deleted !== null };
	};

	const list_handler = async (
		input: CellFieldListInput,
		ctx: ActionContext
	): Promise<CellFieldListOutput> => {
		const auth = ctx.auth;
		// exactly one endpoint — both optional on the wire, so the handler
		// holds the rule and names it in the reason
		if ((input.source_id === undefined) === (input.target_id === undefined)) {
			throw jsonrpc_errors.invalid_params('invalid params', {
				reason: ERROR_CELL_FIELD_LIST_REQUIRES_SOURCE_OR_TARGET
			});
		}
		// an omitted limit is the default page, either direction
		const limit = input.limit ?? CELL_RELATION_LIST_LIMIT_DEFAULT;
		// Forward listing: gate on can_view_cell(source), then page the fields
		// whose target the caller may view (strict target-visibility, in SQL
		// before the limit).
		if (input.source_id !== undefined) {
			const source = await require_viewable_cell(ctx, auth, input.source_id);
			const rows = await query_cell_field_list_for_source(
				ctx,
				cell_viewer_from_auth(auth),
				source.id,
				{ limit, name_after: input.name_after }
			);
			return { fields: rows.map(to_field_json) };
		}
		// Reverse listing: 2-layer authz. First, can_view_cell(target).
		// Without this, the count of returned rows leaks "at least N
		// viewable cells link to this private target."
		const target = await require_viewable_cell(ctx, auth, input.target_id!);
		// Then page the fields whose source the caller may view — filtered in
		// SQL before the limit, so hidden sources never crowd out visible ones,
		// and bounded so a heavily inbound-linked target can't force an
		// unbounded read on this public endpoint.
		const rows = await query_cell_field_list_for_target(
			ctx,
			cell_viewer_from_auth(auth),
			target.id,
			{
				limit
			}
		);
		return { fields: rows.map(to_field_json) };
	};

	return [
		rpc_action(cell_field_set_action_spec, set_handler),
		rpc_action(cell_field_delete_action_spec, delete_handler),
		rpc_action(cell_field_list_action_spec, list_handler)
	];
};
