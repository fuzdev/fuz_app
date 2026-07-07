/**
 * Generic cell RPC action handlers.
 *
 * Six `request_response` actions bound to the specs in
 * `auth/cell_action_specs.ts`:
 *
 * - Mutations: `cell_create`, `cell_update`, `cell_delete`, `cell_clone`.
 * - Reads: `cell_get`, `cell_list`.
 *
 * Authorization model:
 *
 * - `cell_create` is authenticated at the spec level. The handler stamps
 *   `created_by` from `auth.actor.id`. `path` writes are admin-only —
 *   non-admin callers supplying `path` get `ERROR_CELL_PATH_ADMIN_ONLY`.
 * - `cell_get` is `optional` auth at the spec level. Per-row authorization
 *   via `can_view_cell(auth, cell)`. Misses + unauthorized reads both 404,
 *   so private-cell existence doesn't leak through the wire. Bundled
 *   relations are filtered to viewable targets (strict target-visibility).
 * - `cell_update` / `cell_delete` are authenticated at the spec level
 *   with per-row `can_edit_cell` enforcement. `path` writes on update
 *   are admin-only; `visibility` writes require the manage tier
 *   (`can_manage_cell`).
 * - `cell_list` is `optional` auth at the spec level. The SQL-side
 *   visibility predicate in `query_cell_list` admits null auth to
 *   public-only rows and authed callers to owned + public + grant-admitted
 *   rows; admin sees all. SQL-side because post-filtering in JS would
 *   silently truncate pages. The handler rejects the `created_by` filter
 *   for null auth (account-id enumeration guard).
 *
 * Mutations emit `cell_create` / `cell_update` / `cell_delete` audit
 * events via `deps.audit.emit(...)`. The `AuditLogConfig` threaded through
 * the consumer's `audit_factory` (see `create_app_backend`) must declare
 * the cell event types (see `auth/cell_audit_metadata.ts`).
 *
 * App vocabulary (e.g., collection / entry kinds) lives in client-side
 * helpers and per-app `validate_data` deps — this layer is generic-only
 * by construction.
 *
 * @module
 */

import {z} from 'zod';

import {
	rpc_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction,
} from '../actions/action_rpc.ts';
import {jsonrpc_errors, dev_only} from '../http/jsonrpc_errors.ts';
import {is_pg_unique_violation} from '../db/pg_error.ts';
import {has_role, type RequestActorContext} from './request_context.ts';
import {ROLE_ADMIN} from './role_schema.ts';
import type {ActionFactoryDeps} from './deps.ts';
import type {Json} from '@fuzdev/fuz_util/json.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import {
	cell_create_action_spec,
	cell_get_action_spec,
	cell_update_action_spec,
	cell_delete_action_spec,
	cell_list_action_spec,
	cell_clone_action_spec,
	cell_moderate_action_spec,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_PATH_ADMIN_ONLY,
	ERROR_CELL_PATH_TAKEN,
	ERROR_CELL_VISIBILITY_MANAGE_ONLY,
	ERROR_CELL_GET_REQUIRES_ID_OR_PATH,
	ERROR_CELL_KIND_IN_DATA,
	ERROR_CELL_KIND_EMPTY,
	ERROR_CELL_CREATE_FORBIDDEN,
	ERROR_CELL_MODERATE_FORBIDDEN,
	ERROR_CELL_NOT_A_CONTRIBUTION,
	ERROR_CELL_LIST_CREATED_BY_REQUIRES_AUTH,
	ERROR_CELL_LIST_SHARED_WITH_REQUIRES_AUTH,
	CELL_LIST_LIMIT_DEFAULT,
	CELL_RELATIONS_BUNDLE_LIMIT,
	type CellModerateInput,
	type CellModerateOutput,
	type CellCreateInput,
	type CellCreateOutput,
	type CellGetInput,
	type CellGetOutput,
	type CellUpdateInput,
	type CellUpdateOutput,
	type CellDeleteInput,
	type CellDeleteOutput,
	type CellListInput,
	type CellListOutput,
	type CellCloneInput,
	type CellCloneOutput,
	type CellJson,
	type CellPath,
} from './cell_action_specs.ts';
import {
	query_cell_create,
	query_cell_get,
	query_cell_get_by_path,
	query_cell_update,
	query_cell_delete,
	query_cell_set_moderation,
	query_cell_list,
	query_cell_load_many,
	type CellRow,
} from '../db/cell_queries.ts';
import {
	query_cell_grant_list_for_cell,
	query_cell_grants_for_caller_in_cells,
} from '../db/cell_grant_queries.ts';
import {query_cell_field_list_for_source, query_cell_field_set} from '../db/cell_field_queries.ts';
import {
	query_cell_item_insert,
	query_cell_item_list_for_parent,
	type CellItemRow,
} from '../db/cell_item_queries.ts';
import {can_view_cell, can_edit_cell, can_manage_cell} from './cell_authorize.ts';
import {filter_visible_target_ids} from './cell_relation_visibility.ts';
import {to_grant_json} from './cell_grant_actions.ts';
import {to_field_json} from './cell_field_actions.ts';
import {to_item_json} from './cell_item_actions.ts';
import type {GrantJson} from './cell_grant_action_specs.ts';
import type {
	CellAuditMetadata,
	CellCloneAuditMetadata,
	CellModerateAuditMetadata,
} from './cell_audit_metadata.ts';
import type {CellData} from './cell_data_schema.ts';

/**
 * Input to a `CellCreateAuthorize` callback — the TS twin of the Rust
 * `CellCreateAuthorizeInput`. **Parent-aware**: it carries the directory
 * context (`parent_id` / the handler-resolved `root_id`) so the authorizer can
 * resolve the governing root's policy.
 */
export interface CellCreateAuthorizeInput {
	/** The cell's `kind` (the top-level `cell.kind` value); `null` for a typeless cell. */
	kind: string | null;
	/** The cell `data` (kind-free — a `kind` key is rejected upstream). For richer M3-era policies (e.g. content pre-screen). */
	data: CellData;
	/** The immediate container the create targets. `null` = a root creation; otherwise a contribution under that parent. */
	parent_id: Uuid | null;
	/** The governing root of the directory subtree, resolved by the handler from the parent (`parent.root_id ?? parent.id`). `null` for a root creation. */
	root_id: Uuid | null;
	/** The governing root's `data` — the handler reads it in-tx (when an authorizer is mounted) and hands it over, so a directory-aware authorizer resolves `root.data.policy[kind]` **without a DB read of its own** (pure predicate; reading in-tx avoids the single-connection PGlite deadlock a separate handle would hit). `null` for a root creation, or when no authorizer is mounted. */
	root_data: CellData | null;
	/** Target scope — designed-in for M2 space-scoping; **always `null` in v1** (cells carry no scope column). */
	scope_id: Uuid | null;
}

/**
 * An authorizer's decision for a `cell_create` — the TS twin of the Rust
 * `Verdict`. Folds the moderation outcome into the authority decision (one
 * policy resolution, not two): `{allow: false}` denies (the handler surfaces a
 * 403 `forbidden` for a viewable parent / a root creation), `{allow: true,
 * moderation_required}` admits — `true` → born `pending` + private, `false` →
 * born `approved` at the author's visibility.
 */
export type CellCreateVerdict = {allow: false} | {allow: true; moderation_required: boolean};

/**
 * Opt-in, parent-aware creation authorizer — the TS twin of the Rust
 * `CellCreateAuthorize` trait. Gates both roots (`parent_id = null`) and
 * contributions; answers "may *this actor* create *this kind* here?" and
 * returns a `CellCreateVerdict`. Runs in `cell_create` after `validate_data`
 * and after the handler resolves `root_id` from the parent (an unviewable
 * parent already 404-masks before this runs). Omitted = today's open create
 * (all consumers untouched). Async-capable (DB / policy calls) — a DB-backed
 * impl closes over its own `db` (the create handler stays unaware).
 */
export type CellCreateAuthorize = (
	auth: RequestActorContext,
	input: CellCreateAuthorizeInput,
) => CellCreateVerdict | Promise<CellCreateVerdict>;

/**
 * Dependencies for `create_cell_actions`.
 *
 * `validate_data` is the optional sub-API hook for per-kind shape
 * validation (e.g., a collection/entry registry). It runs on every
 * incoming `data` payload (create, update, clone-merged) and may throw
 * a `ZodError` — the handler converts that into the standard
 * `invalid_params` JSON-RPC error so per-kind validation failures
 * surface to clients with code -32602 (not -32603 / internal). When
 * omitted, payloads pass through as-is.
 *
 * `authorize_create` is the optional creation-gate hook (see
 * `CellCreateAuthorize`). When omitted, create is open (today's behavior).
 */
export type CellActionDeps = ActionFactoryDeps & {
	validate_data?: (data: CellData) => CellData;
	authorize_create?: CellCreateAuthorize;
};

const to_iso_nullable = (value: Date | string | null): string | null => {
	if (value === null) return null;
	return typeof value === 'string' ? value : value.toISOString();
};

/**
 * Translate the `idx_cell_path_unique` violation into a clean `conflict`
 * (409) reason. `path` is the only unique constraint a cell write can hit
 * (the id is a server-generated UUID), so a `23505` on a path-bearing
 * write is unambiguously a path collision.
 */
const path_taken_error = (): ReturnType<typeof jsonrpc_errors.conflict> =>
	jsonrpc_errors.conflict('cell.path is already taken', {reason: ERROR_CELL_PATH_TAKEN});

/**
 * Reject a `kind` key supplied inside `data`. `kind` is the top-level
 * `cell.kind` column (write-once capability axis), so a copy inside the
 * loose `data` blob would be a second source of truth that silently
 * diverges on update. Fail-loud `invalid_params` at every wire-`data`
 * boundary (create / update / clone-patch).
 */
const reject_kind_in_data = (data: CellData): void => {
	if (Object.hasOwn(data, 'kind')) {
		throw jsonrpc_errors.invalid_params(
			'cell.data must not contain `kind` (it is a top-level field)',
			{
				reason: ERROR_CELL_KIND_IN_DATA,
			},
		);
	}
};

export const to_cell_json = (row: CellRow): CellJson => ({
	id: row.id,
	path: row.path as CellPath | null,
	data: row.data,
	kind: row.kind,
	visibility: row.visibility,
	refs: row.refs,
	parent_id: row.parent_id,
	root_id: row.root_id,
	moderation: row.moderation,
	created_by: row.created_by,
	updated_by: row.updated_by,
	created_at: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
	updated_at: to_iso_nullable(row.updated_at),
	deleted_at: to_iso_nullable(row.deleted_at),
	grant_count: row.grant_count,
});

/**
 * Emit a cell-mutation audit event with the standard `{cell_id, kind?,
 * path?}` envelope. Relation-graph mutations are tracked independently
 * via per-row `cell_item_*` / `cell_field_*` events.
 */
const emit_cell_audit = (
	ctx: ActionContext | ActionActorContext,
	event_type: 'cell_create' | 'cell_update' | 'cell_delete',
	row: CellRow,
	deps: CellActionDeps,
	auth: RequestActorContext,
): void => {
	deps.audit.emit(ctx, {
		event_type,
		actor_id: auth.actor.id,
		account_id: auth.account.id,
		ip: ctx.client_ip,
		metadata: {
			cell_id: row.id,
			kind: row.kind ?? undefined,
			path: row.path,
		} satisfies CellAuditMetadata,
	});
};

/** Create the six generic cell RPC actions. */
export const create_cell_actions = (deps: CellActionDeps): Array<RpcAction> => {
	const {validate_data, authorize_create} = deps;

	/**
	 * Run the optional `validate_data` deps callback and convert any thrown
	 * `ZodError` into the standard `invalid_params` JSON-RPC error so per-
	 * kind validation failures surface to clients with code -32602 (not
	 * -32603 / internal). The dispatcher only auto-converts ZodError for
	 * wire-level input schemas; sub-API validation runs inside the handler.
	 */
	const validate_data_or_throw = (data: CellData): CellData => {
		if (validate_data === undefined) return data;
		try {
			return validate_data(data);
		} catch (err) {
			if (err instanceof z.ZodError) {
				throw jsonrpc_errors.invalid_params(
					'cell.data shape validation failed',
					dev_only({issues: err.issues}),
				);
			}
			throw err;
		}
	};

	const create_handler = async (
		input: CellCreateInput,
		ctx: ActionActorContext,
	): Promise<CellCreateOutput> => {
		const auth = ctx.auth;
		// Path writes are admin-only. Reject before the insert so the audit
		// + DB are clean.
		if (input.path !== undefined && input.path !== null && !has_role(auth, ROLE_ADMIN)) {
			throw jsonrpc_errors.forbidden('cell.path is admin-only', {
				reason: ERROR_CELL_PATH_ADMIN_ONLY,
			});
		}
		// `kind` is the top-level column — reject a stray copy inside `data`,
		// and reject an empty `kind` (a tag tags nothing — `null` is the typeless
		// state), so `kind` stays a clean `null | non-empty-string`. Both run
		// after the path-admin gate so an unauthorized caller sees that first.
		reject_kind_in_data(input.data);
		if (input.kind === '') {
			throw jsonrpc_errors.invalid_params(
				'cell.kind must not be empty (use null for a typeless cell)',
				{reason: ERROR_CELL_KIND_EMPTY},
			);
		}
		// Per-kind shape validation (sub-API). Unknown kinds pass through;
		// known kinds with malformed payloads surface as invalid_params.
		const validated_data = validate_data_or_throw(input.data);
		const kind = input.kind ?? null;
		// Directory tree: resolve the governing `root_id` from the parent (and
		// the root's `data` for the authorizer's policy read). Runs whether or
		// not an authorizer is mounted — `root_id` is written regardless, and an
		// unviewable parent 404-masks the attempt (the same IDOR mask the read
		// path uses; never reveals a hidden container). A root creation
		// (`parent_id` null/absent) has `root_id = null`. `root_data` is read
		// **in-tx** (only when an authorizer is mounted), reusing the parent row
		// when the parent *is* the root, else one read by `root_id` — so the
		// authorizer stays pure + the read rides the handler's connection (no
		// separate-handle deadlock on the single-connection PGlite).
		const parent_id = input.parent_id ?? null;
		let root_id: Uuid | null = null;
		let root_data: CellData | null = null;
		if (parent_id !== null) {
			const parent = await query_cell_get(ctx, parent_id);
			if (!parent) throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
			const parent_grants = await query_cell_grant_list_for_cell(ctx, parent.id);
			if (!can_view_cell(auth, parent, parent_grants)) {
				throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
			}
			root_id = parent.root_id ?? parent.id;
			if (authorize_create) {
				root_data =
					root_id === parent.id
						? parent.data
						: ((await query_cell_get(ctx, root_id))?.data ?? null);
			}
		}
		// Parent-aware creation authorizer (opt-in). Runs after shape validation
		// and after the parent-resolve (a hidden parent already 404-masked).
		// `{allow: false}` for a *viewable* parent / a root creation is a 403
		// `forbidden` (not the 404 mask); an `{allow: true}` verdict folds the
		// moderation outcome. Receives the **raw** `input.data` (not the
		// `validate_data`-normalized value) to match the Rust twin, so a consumer
		// with a transforming validator can't diverge TS↔Rust. `scope_id` is
		// `null` in v1. Without an authorizer, create is open: `moderation` stays
		// null and the author's visibility holds.
		let moderation: string | null = null;
		let visibility = input.visibility;
		if (authorize_create) {
			const verdict = await authorize_create(auth, {
				kind,
				data: input.data,
				parent_id,
				root_id,
				root_data,
				scope_id: null,
			});
			if (!verdict.allow) {
				throw jsonrpc_errors.forbidden('cell creation is not permitted here', {
					reason: ERROR_CELL_CREATE_FORBIDDEN,
				});
			}
			// Moderation is a *contribution* concept — only stamp it for a create
			// with a parent. A root / unparented create stays `moderation = null`
			// at the author's visibility even under a mounted authorizer (there is
			// no container to be moderated under).
			if (parent_id !== null) {
				if (verdict.moderation_required) {
					// Born pending: stays private until `cell_moderate` approves it.
					moderation = 'pending';
					visibility = 'private';
				} else {
					// Born approved + live immediately at the author's visibility.
					moderation = 'approved';
				}
			}
		}
		let row: CellRow;
		try {
			row = await query_cell_create(ctx, {
				// Boundary cast: `CellData` is structurally JSON-compatible at
				// runtime (loose object of JSON-safe values), but its inferred
				// type carries `T | undefined` from `.optional()` which doesn't
				// extend `Json`. The DB column is JSONB; the cast trusts the
				// schema-validated runtime shape.
				data: validated_data as unknown as Json,
				kind,
				visibility,
				path: input.path ?? null,
				parent_id,
				root_id,
				moderation,
				created_by: auth.actor.id,
			});
		} catch (err) {
			if (input.path != null && is_pg_unique_violation(err)) throw path_taken_error();
			throw err;
		}
		emit_cell_audit(ctx, 'cell_create', row, deps, auth);
		return {cell: to_cell_json(row)};
	};

	const get_handler = async (input: CellGetInput, ctx: ActionContext): Promise<CellGetOutput> => {
		// Defense in depth: spec already refines for "id or path". Surface
		// the same error code from the handler so adversarial callers that
		// bypass the wire schema get the same error shape.
		if (input.id === undefined && input.path === undefined) {
			throw jsonrpc_errors.invalid_params('cell_get requires id or path', {
				reason: ERROR_CELL_GET_REQUIRES_ID_OR_PATH,
			});
		}
		const auth = ctx.auth;
		const row =
			input.id !== undefined
				? await query_cell_get(ctx, input.id)
				: await query_cell_get_by_path(ctx, input.path!);
		if (!row) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Run the three post-cell fetches in parallel — they share only
		// `row.id` and have no inter-dependency. Bundle fetches one over the
		// cap so we can detect truncation without a separate count query.
		// Skip the grant fetch for unauthenticated callers — no grant can
		// admit a null auth, so the predicate either short-circuits via
		// `cell_is_public` or returns false either way.
		const [grants, fields, items] = await Promise.all([
			auth ? query_cell_grant_list_for_cell(ctx, row.id) : Promise.resolve(null),
			query_cell_field_list_for_source(ctx, row.id, {
				limit: CELL_RELATIONS_BUNDLE_LIMIT + 1,
			}),
			query_cell_item_list_for_parent(ctx, row.id, {
				limit: CELL_RELATIONS_BUNDLE_LIMIT + 1,
			}),
		]);
		// 404 covers both "no such cell" and "exists but caller can't view"
		// — same response code so private-cell existence doesn't leak.
		if (!can_view_cell(auth, row, grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const can_edit = can_edit_cell(auth, row, grants);
		// `can_grant` gates the share UI — managing grants is a manage-tier
		// affordance (admin / owner), so it tracks `can_manage_cell` rather
		// than the broader `can_edit` (editor-grant holders edit, but the
		// share list is the manager's to curate).
		const can_grant = can_manage_cell(auth, row);
		const fields_truncated = fields.length > CELL_RELATIONS_BUNDLE_LIMIT;
		const fields_bundled = fields_truncated ? fields.slice(0, CELL_RELATIONS_BUNDLE_LIMIT) : fields;
		const items_truncated = items.length > CELL_RELATIONS_BUNDLE_LIMIT;
		const items_bundled = items_truncated ? items.slice(0, CELL_RELATIONS_BUNDLE_LIMIT) : items;
		// Strict target-visibility (D8): drop bundled relations whose target
		// the caller can't view, so a viewer of this cell can't enumerate
		// private linked cells by id. One batched filter over both relation
		// id-sets. `*_truncated` still reflects the raw relation size.
		const visible_targets = await filter_visible_target_ids(ctx, auth, [
			...fields_bundled.map((f) => f.target_id),
			...items_bundled.map((i) => i.child_id),
		]);
		const fields_visible = fields_bundled.filter((f) => visible_targets.has(f.target_id));
		const items_visible = items_bundled.filter((i) => visible_targets.has(i.child_id));
		return {
			cell: to_cell_json(row),
			fields: fields_visible.map(to_field_json),
			fields_truncated,
			items: items_visible.map(to_item_json),
			items_truncated,
			can_edit,
			can_grant,
		};
	};

	const update_handler = async (
		input: CellUpdateInput,
		ctx: ActionActorContext,
	): Promise<CellUpdateOutput> => {
		const auth = ctx.auth;
		const path_provided = Object.hasOwn(input, 'path');
		// `path` writes are admin-only. Check before fetching so non-admins
		// can't probe for cell existence by varying `path` shape.
		if (path_provided && !has_role(auth, ROLE_ADMIN)) {
			throw jsonrpc_errors.forbidden('cell.path is admin-only', {
				reason: ERROR_CELL_PATH_ADMIN_ONLY,
			});
		}
		const existing = await query_cell_get(ctx, input.cell_id);
		if (!existing) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const grants = await query_cell_grant_list_for_cell(ctx, existing.id);
		if (!can_edit_cell(auth, existing, grants)) {
			// IDOR mask: 404, not 403 — same shape as cell_get.
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Visibility writes are manage-tier only (admin / owner). An
		// editor-grant holder may edit `data` but cannot flip the cell's
		// visibility — that would let a delegated editor expose a private
		// cell or hide a public one. Gated on an actual change so a client
		// round-tripping the unchanged value isn't rejected.
		if (
			input.visibility !== undefined &&
			input.visibility !== existing.visibility &&
			!can_manage_cell(auth, existing)
		) {
			throw jsonrpc_errors.forbidden('cell.visibility is manage-tier only', {
				reason: ERROR_CELL_VISIBILITY_MANAGE_ONLY,
			});
		}
		// Per-kind shape validation when `data` is supplied. Patch-only —
		// we don't validate the existing row's data on update (validation
		// is for incoming patches). `data` writes fully replace, so the
		// patch IS the post-update state. A stray `kind` inside it is rejected
		// (kind is the write-once top-level column — `cell_update` cannot
		// change it, structurally: it is not even a field on `CellUpdateInput`).
		if (input.data !== undefined) reject_kind_in_data(input.data);
		const validated_data =
			input.data !== undefined ? validate_data_or_throw(input.data) : undefined;
		let updated: CellRow | null;
		try {
			updated = await query_cell_update(ctx, input.cell_id, {
				// Boundary cast (see `create_handler`).
				data: validated_data as unknown as Json | undefined,
				visibility: input.visibility,
				path: path_provided ? (input.path ?? null) : undefined,
				updated_by: auth.actor.id,
			});
		} catch (err) {
			if (path_provided && input.path != null && is_pg_unique_violation(err)) {
				throw path_taken_error();
			}
			throw err;
		}
		if (!updated) {
			// Raced with a deleter between the visibility check and the UPDATE.
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		emit_cell_audit(ctx, 'cell_update', updated, deps, auth);
		return {cell: to_cell_json(updated)};
	};

	const delete_handler = async (
		input: CellDeleteInput,
		ctx: ActionActorContext,
	): Promise<CellDeleteOutput> => {
		const auth = ctx.auth;
		// Fetch first so we can audit `kind` + `path` after the soft-delete
		// flips `deleted_at`.
		const existing = await query_cell_get(ctx, input.cell_id);
		if (!existing) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const grants = await query_cell_grant_list_for_cell(ctx, existing.id);
		if (!can_edit_cell(auth, existing, grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const deleted = await query_cell_delete(ctx, input.cell_id, {deleted_by: auth.actor.id});
		if (!deleted) {
			// Raced with another deleter.
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		emit_cell_audit(ctx, 'cell_delete', existing, deps, auth);
		return {ok: true, deleted: true};
	};

	const moderate_handler = async (
		input: CellModerateInput,
		ctx: ActionActorContext,
	): Promise<CellModerateOutput> => {
		const auth = ctx.auth;
		const existing = await query_cell_get(ctx, input.cell_id);
		// 404 covers miss + unviewable so a pending (private) contribution
		// doesn't leak existence to a non-viewer.
		if (!existing) throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		const grants = await query_cell_grant_list_for_cell(ctx, existing.id);
		if (!can_view_cell(auth, existing, grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		// Only a contribution (with a governing root) is moderatable.
		if (existing.root_id === null) {
			throw jsonrpc_errors.invalid_params(
				'cell is not a contribution (no governing root to moderate under)',
				{reason: ERROR_CELL_NOT_A_CONTRIBUTION},
			);
		}
		// Authority is over the governing ROOT (admin / root owner), not the
		// contribution — the author manages the contribution and could otherwise
		// self-approve. A viewable-but-unauthorized caller (incl. the author) → 403.
		const root = await query_cell_get(ctx, existing.root_id);
		if (!root) throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		if (!can_manage_cell(auth, root)) {
			throw jsonrpc_errors.forbidden(
				'cell_moderate requires moderation authority over the governing root',
				{reason: ERROR_CELL_MODERATE_FORBIDDEN},
			);
		}
		const approved = input.moderation === 'approved';
		const updated = await query_cell_set_moderation(ctx, input.cell_id, input.moderation, {
			set_visibility_public: approved,
			updated_by: auth.actor.id,
		});
		// Raced with a deleter between the authz check and the UPDATE.
		if (!updated) throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		deps.audit.emit(ctx, {
			event_type: 'cell_moderate',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				cell_id: updated.id,
				root_id: existing.root_id,
				moderation: input.moderation,
			} satisfies CellModerateAuditMetadata,
		});
		return {cell: to_cell_json(updated)};
	};

	/**
	 * Insert one cloned cell row owned by the caller.
	 *
	 * `data` is `{...source.data, ...patch}` — patch wins last for
	 * predictable merge semantics. `path` is always nulled (admin-only
	 * paths can't auto-clone — no admin escalation through clone).
	 * Relations (`cell_field`, `cell_item`) are NOT copied here; the
	 * caller copies fields shallowly and walks items per the clone
	 * semantics in `clone_handler`. Provenance lives only in the
	 * `cell_clone` audit row's `source_id`; `data` carries no
	 * server-stamped provenance fields.
	 */
	const clone_one_cell_row = async (
		ctx: ActionContext | ActionActorContext,
		source: CellRow,
		auth: RequestActorContext,
		options: {patch_data?: CellData},
	): Promise<CellRow> => {
		// A patch is wire-supplied `data` — reject a stray `kind` (kind is the
		// immutable top-level column; the clone inherits `source.kind`).
		if (options.patch_data !== undefined) reject_kind_in_data(options.patch_data);
		// Both `source.data` and `options.patch_data` are CellData (loose
		// objects). Patch-last shallow merge composes cleanly.
		const merged_data: CellData =
			options.patch_data !== undefined ? {...source.data, ...options.patch_data} : source.data;
		// Per-kind shape validation runs on the merged result (sub-API).
		// Source rows are validated on their original create; the patch
		// could violate the kind shape (e.g., remove a required field).
		const validated_data = validate_data_or_throw(merged_data);
		return query_cell_create(ctx, {
			// Boundary cast (see `create_handler`).
			data: validated_data as unknown as Json,
			// Clone inherits the source's kind verbatim — kind is fixed at
			// birth and a `with_data_patch` can't reach the column.
			kind: source.kind,
			visibility: source.visibility,
			path: null, // admin-only paths cannot auto-clone
			created_by: auth.actor.id,
		});
	};

	const clone_handler = async (
		input: CellCloneInput,
		ctx: ActionActorContext,
	): Promise<CellCloneOutput> => {
		const auth = ctx.auth;
		const source = await query_cell_get(ctx, input.source_id);
		if (!source) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}
		const source_grants = await query_cell_grant_list_for_cell(ctx, source.id);
		// 404 covers both miss and unauthorized read — same shape as cell_get
		// so the existence of private cells doesn't leak through clones.
		if (!can_view_cell(auth, source, source_grants)) {
			throw jsonrpc_errors.not_found('cell', {reason: ERROR_CELL_NOT_FOUND});
		}

		const deep = input.deep === true;
		// Pre-fetch source relations OUTSIDE the transaction so authz checks
		// (per-child `can_view_cell`) on `query_cell_get`-fetched grants
		// don't bloat the transaction. The fetch sees the world as of
		// pre-transaction; the inserts inside the transaction commit
		// atomically together.
		const source_fields = await query_cell_field_list_for_source(ctx, source.id);
		const source_items = deep
			? await query_cell_item_list_for_parent(ctx, source.id)
			: ([] as Array<CellItemRow>);

		// In deep mode, pre-resolve which children are viewable so we can
		// skip un-viewable ones silently (strict per-target view filter, D8).
		// Batched (not per-child): one bulk row load + one batched visibility
		// filter over the whole child id-set — same shape the forward reads
		// and `filter_visible_target_ids` use, instead of an N+1 walk. Done
		// outside the transaction for the same reason as the relation fetch.
		const cloneable_items: Array<CellItemRow> = [];
		const cloneable_children = new Map<string, CellRow>();
		if (deep) {
			const child_ids = source_items.map((i) => i.child_id);
			const [child_rows, visible_children] = await Promise.all([
				query_cell_load_many(ctx, child_ids),
				filter_visible_target_ids(ctx, auth, child_ids),
			]);
			const child_by_id = new Map(child_rows.map((r) => [r.id, r]));
			for (const item of source_items) {
				const child = child_by_id.get(item.child_id);
				// Skip missing (soft-deleted/vanished) and non-viewable children
				// silently — no count is surfaced, so the source's hidden-child
				// count never leaks to the cloner (D8).
				if (!child || !visible_children.has(item.child_id)) continue;
				cloneable_items.push(item);
				cloneable_children.set(item.child_id, child);
			}
		}

		// `cell_clone_action_spec.side_effects = true`, so the RPC
		// dispatcher already wraps the handler in a transaction —
		// `ctx.db` is transaction-scoped. Every write below participates
		// in that single transaction and rolls back together on any
		// failure. No nested `ctx.db.transaction(...)` here.
		const cloned_root = await clone_one_cell_row(ctx, source, auth, {
			patch_data: input.with_data_patch,
		});

		// Copy outgoing fields shallowly: the clone points at the same
		// targets the source did (fields are JSON references, not
		// contents). Cloning `foo` should not deep-clone `foo.author`.
		//
		// Strict target-visibility (D8): only copy field edges whose target
		// the caller may view. `cell_field_set` gates the target on
		// `can_view_cell`, so without this filter clone would be a side door
		// to owning edges that point at private cells the cloner can't see.
		// Non-viewable targets are dropped silently.
		const field_targets_visible = await filter_visible_target_ids(
			ctx,
			auth,
			source_fields.map((f) => f.target_id),
		);
		for (const f of source_fields) {
			if (!field_targets_visible.has(f.target_id)) continue;
			// Route through the query layer (not raw SQL) for parity with the
			// item-copy path below. The clone target is fresh, so the UPSERT's
			// `ON CONFLICT` is a no-op — behaviorally a plain insert.
			await query_cell_field_set(ctx, {
				source_id: cloned_root.id,
				name: f.name,
				target_id: f.target_id,
			});
		}

		if (deep) {
			// Deep mode: clone each viewable direct child, attach via new
			// cell_item rows reusing the source position. Reusing the
			// position keeps lex order stable and avoids the
			// fractional_index machinery for an internal walk that can't
			// collide (the clone's `(parent_id, position)` slot is fresh —
			// no concurrent writer).
			for (const item of cloneable_items) {
				const child = cloneable_children.get(item.child_id)!;
				const cloned_child = await clone_one_cell_row(ctx, child, auth, {});
				await query_cell_item_insert(ctx, {
					parent_id: cloned_root.id,
					position: item.position,
					child_id: cloned_child.id,
				});
			}
		} else {
			// Shallow: copy `cell_item` rows referencing the source's
			// children, sharing both `child_id` and `position`. Preserves
			// the "shallow copies the clone's outgoing edges, sharing
			// targets with the source" invariant.
			//
			// Strict target-visibility (D8): only copy item edges whose child
			// the caller may view — the same invariant the deep walk and
			// `cell_item_insert` enforce. Non-viewable children are skipped
			// silently (no count surfaced — see the deep-walk note on the
			// hidden-child-count leak).
			const shallow_items = await query_cell_item_list_for_parent(ctx, source.id);
			const shallow_children_visible = await filter_visible_target_ids(
				ctx,
				auth,
				shallow_items.map((i) => i.child_id),
			);
			for (const item of shallow_items) {
				if (!shallow_children_visible.has(item.child_id)) continue;
				await query_cell_item_insert(ctx, {
					parent_id: cloned_root.id,
					position: item.position,
					child_id: item.child_id,
				});
			}
		}

		// Audit envelope is richer than the standard cell-mutation envelope
		// — emit directly rather than threading it through `emit_cell_audit`.
		// `kind` is read from `source.data` (not the cloned row) so the
		// audit trail attributes the clone to the source's shape.
		const source_kind = source.kind ?? undefined;
		const cloned_child_count = deep ? cloneable_items.length : 0;
		deps.audit.emit(ctx, {
			event_type: 'cell_clone',
			actor_id: auth.actor.id,
			account_id: auth.account.id,
			ip: ctx.client_ip,
			metadata: {
				source_id: source.id,
				new_id: cloned_root.id,
				deep,
				item_count: cloned_child_count,
				...(source_kind !== undefined ? {kind: source_kind} : {}),
			} satisfies CellCloneAuditMetadata,
		});
		return {cell: to_cell_json(cloned_root)};
	};

	const list_handler = async (
		input: CellListInput,
		ctx: ActionContext,
	): Promise<CellListOutput> => {
		const auth = ctx.auth;
		// Null auth + `created_by` is a soft account-id enumeration probe
		// ("does account X have any public cells?") — require auth to use it.
		if (auth === null && input.created_by !== undefined) {
			throw jsonrpc_errors.invalid_params('cell_list created_by requires authentication', {
				reason: ERROR_CELL_LIST_CREATED_BY_REQUIRES_AUTH,
			});
		}
		// `shared_with: 'me'` resolves to the caller's actor + role_grants;
		// no auth means no caller, no admit path.
		if (auth === null && input.shared_with !== undefined) {
			throw jsonrpc_errors.invalid_params('cell_list shared_with requires authentication', {
				reason: ERROR_CELL_LIST_SHARED_WITH_REQUIRES_AUTH,
			});
		}
		// Project the active role_grant set into parallel arrays for the
		// `cell_grant` role-shaped EXISTS. Middleware (`request_context`)
		// has already filtered to active-only role_grants; we trust that and
		// pass NULL `scope_id`s through (global-scope role_grants).
		const role_grant_roles = auth ? auth.role_grants.map((p) => p.role) : [];
		const role_grant_scope_ids = auth ? auth.role_grants.map((p) => p.scope_id) : [];
		const caller_actor_id = auth?.actor?.id ?? null;
		const rows = await query_cell_list(ctx, {
			ids: input.ids,
			kind: input.kind,
			visibility: input.visibility,
			ref: input.ref,
			created_by: input.created_by,
			path_prefix: input.path_prefix,
			root_id: input.root_id,
			moderation: input.moderation,
			viewer_actor_id: caller_actor_id,
			viewer_is_admin: auth ? has_role(auth, ROLE_ADMIN) : false,
			caller_actor_id,
			caller_role_grant_roles: role_grant_roles,
			caller_role_grant_scope_ids: role_grant_scope_ids,
			shared_with_caller_only: input.shared_with === 'me',
			order_by: input.order_by,
			order_direction: input.order_direction,
			// Apply the default cap when caller omits `limit`. Without this
			// the SQL `LIMIT NULL` returns every matching row.
			limit: input.limit ?? CELL_LIST_LIMIT_DEFAULT,
			offset: input.offset,
		});
		let cell_grants: Record<string, Array<GrantJson>> | undefined;
		if (input.shared_with === 'me' && rows.length > 0 && caller_actor_id !== null) {
			const grant_rows = await query_cell_grants_for_caller_in_cells(
				ctx,
				rows.map((r) => r.id),
				caller_actor_id,
				role_grant_roles,
				role_grant_scope_ids,
			);
			cell_grants = {};
			for (const g of grant_rows) {
				(cell_grants[g.cell_id] ??= []).push(to_grant_json(g));
			}
		}
		return {cells: rows.map(to_cell_json), cell_grants};
	};

	return [
		rpc_action(cell_create_action_spec, create_handler),
		rpc_action(cell_get_action_spec, get_handler),
		rpc_action(cell_update_action_spec, update_handler),
		rpc_action(cell_delete_action_spec, delete_handler),
		rpc_action(cell_list_action_spec, list_handler),
		rpc_action(cell_clone_action_spec, clone_handler),
		rpc_action(cell_moderate_action_spec, moderate_handler),
	];
};
