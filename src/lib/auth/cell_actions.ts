/**
 * Generic cell RPC action handlers.
 *
 * The generic `request_response` actions bound to the specs in
 * `auth/cell_action_specs.ts`:
 *
 * - Mutations: `cell_create`, `cell_update`, `cell_delete`, `cell_clone`,
 *   `cell_moderate`, `cell_policy_set`.
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
 * - `cell_policy_set` is the one writer of a root's contribution `policy` past
 *   its create — manage-tier, root-only, and validated by the mounted
 *   `authorize_create` (the authorizer that interprets the policy is what
 *   accepts one; none mounted refuses every non-null policy). `cell_update`
 *   never touches it.
 * - `cell_list` is `optional` auth at the spec level. The SQL-side
 *   visibility predicate in `query_cell_list` admits null auth to
 *   public-only rows and authed callers to owned + public + grant-admitted
 *   rows; admin sees all. SQL-side because post-filtering in JS would
 *   silently truncate pages. The handler rejects the `created_by` filter
 *   for null auth (account-id enumeration guard).
 *
 * - `cell_create`, `cell_update`, and `cell_clone` gate the fact refs their
 *   `data` introduces on **possession**: a non-admin write may add a ref only
 *   to a fact its acting actor holds, else 403 `ERROR_CELL_REF_NOT_HELD` —
 *   answered from `fact_holder` rows alone, so it says nothing about whether a
 *   fact exists. Refs a cell (or a clone's source row) already carries stay
 *   admitted. The last gate before the write; see `auth/cell_ref_admission.ts`.
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

import { z } from 'zod';

import {
	rpc_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction
} from '../actions/action_types.ts';
import { jsonrpc_errors, dev_only } from '../http/jsonrpc_errors.ts';
import { is_pg_unique_violation } from '../db/pg_error.ts';
import {
	has_scoped_role,
	type RequestActorContext,
	type RequestContext
} from './request_context.ts';
import { ROLE_ADMIN } from './role_schema.ts';
import type { ActionFactoryDeps } from './deps.ts';
import type { Json } from '@fuzdev/fuz_util/json.ts';
import type { Uuid } from '../primitive_schemas.ts';

import {
	cell_create_action_spec,
	cell_get_action_spec,
	cell_update_action_spec,
	cell_delete_action_spec,
	cell_list_action_spec,
	cell_clone_action_spec,
	cell_moderate_action_spec,
	cell_policy_set_action_spec,
	ERROR_CELL_PATH_ADMIN_ONLY,
	ERROR_CELL_PATH_TAKEN,
	ERROR_CELL_VISIBILITY_MANAGE_ONLY,
	ERROR_CELL_GET_REQUIRES_ID_OR_PATH,
	ERROR_CELL_KIND_IN_DATA,
	ERROR_CELL_KIND_EMPTY,
	ERROR_CELL_CREATE_FORBIDDEN,
	ERROR_CELL_MODERATE_FORBIDDEN,
	ERROR_CELL_NOT_A_CONTRIBUTION,
	ERROR_CELL_NOT_PENDING,
	ERROR_CELL_POLICY_MANAGE_ONLY,
	ERROR_CELL_POLICY_ROOT_ONLY,
	ERROR_CELL_POLICY_UNSUPPORTED,
	ERROR_CELL_LIST_CREATED_BY_REQUIRES_AUTH,
	ERROR_CELL_LIST_SHARED_WITH_REQUIRES_AUTH,
	CELL_LIST_LIMIT_DEFAULT,
	CELL_RELATIONS_BUNDLE_LIMIT,
	type CellModerateInput,
	type CellModerateOutput,
	type CellPolicy,
	type CellPolicySetInput,
	type CellPolicySetOutput,
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
	type CellPath
} from './cell_action_specs.ts';
import {
	query_cell_create,
	query_cell_get,
	query_cell_get_by_path,
	query_cell_update,
	query_cell_delete,
	query_cell_set_moderation,
	query_cell_set_policy,
	query_cell_list,
	query_cell_load_many,
	type CellRow
} from '../db/cell_queries.ts';
import {
	query_cell_grant_list_for_cell,
	query_cell_grants_for_caller_in_cells,
	type CellGrantRow
} from '../db/cell_grant_queries.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import {
	query_cell_field_list_for_source,
	query_cell_field_set
} from '../db/cell_field_queries.ts';
import {
	query_cell_item_insert,
	query_cell_item_list_for_parent,
	type CellItemRow
} from '../db/cell_item_queries.ts';
import {
	can_view_cell,
	can_edit_cell,
	can_manage_cell,
	cell_viewer_from_auth
} from './cell_authorize.ts';
import { filter_visible_target_ids } from './cell_relation_visibility.ts';
import { CELL_VIEWER_UNRESTRICTED } from '../db/cell_view_sql.ts';
import { cell_steward_admits } from './cell_steward.ts';
import {
	cell_not_found_error,
	emit_cell_audit,
	require_editable_cell,
	require_viewable_cell
} from './cell_action_helpers.ts';
import { require_new_refs_held } from './cell_ref_admission.ts';
import { to_grant_json } from './cell_grant_actions.ts';
import { to_field_json } from './cell_field_actions.ts';
import { to_item_json } from './cell_item_actions.ts';
import type { GrantJson } from './cell_grant_action_specs.ts';
import type {
	CellAuditMetadata,
	CellCloneAuditMetadata,
	CellModerateAuditMetadata,
	CellPolicySetAuditMetadata
} from './cell_audit_metadata.ts';
import type { CellData } from './cell_data_schema.ts';

/**
 * Input to `CellCreateAuthorize.authorize` — the TS twin of the Rust
 * `CellCreateAuthorizeInput`. **Parent-aware**: it carries the directory
 * context (`parent_id` / the handler-resolved `root_id`) and the governing
 * root's `policy`, so the authorizer resolves the rule that applies.
 */
export interface CellCreateAuthorizeInput {
	/** The cell's `kind` (the top-level `cell.kind` value); `null` for a typeless cell. */
	kind: string | null;
	/** The cell `data` (kind-free — a `kind` key is rejected upstream). For richer M3-era policies (e.g. content pre-screen). */
	data: CellData;
	/** The immediate container the create targets. `null` = a root creation; otherwise a contribution under that parent. */
	parent_id: Uuid | null;
	/** The immediate container's `kind` column, read by the handler with the parent — so an authorizer checks the parent → child edge (which kinds may sit under which) without a read of its own. `null` for a root creation and for a typeless parent. */
	parent_kind: string | null;
	/** The governing root of the directory subtree, resolved by the handler from the parent (`parent.root_id ?? parent.id`). `null` for a root creation. */
	root_id: Uuid | null;
	/** The governing root's contribution `policy` column — the handler reads the root in-tx and hands its policy over, so a directory-aware authorizer resolves `root_policy[kind]` **without a DB read of its own**. `null` for a root creation and for a root carrying no policy (the authorizer's floor governs); a missing or soft-deleted root answers `cell_not_found` before the authorizer runs. Never the root's `data`: an editor grant can rewrite `data`, so a policy read from it would be the editor's to loosen. */
	root_policy: CellPolicy | null;
}

/**
 * An authorizer's decision for a `cell_create` — the TS twin of the Rust
 * `Verdict`. Folds the moderation outcome into the authority decision (one
 * policy resolution, not two): `{allow: false}` denies (the handler surfaces a
 * 403 `forbidden` for a viewable parent / a root creation), `{allow: true,
 * moderation_required}` admits — `true` → born `pending` + private, `false` →
 * born `approved` at the author's visibility.
 */
export type CellCreateVerdict = { allow: false } | { allow: true; moderation_required: boolean };

/**
 * Opt-in, parent-aware creation authorizer — the TS twin of the Rust
 * `CellCreateAuthorize` trait, its two members the trait's two methods.
 * Omitted = open create, and every non-null policy write refused
 * `ERROR_CELL_POLICY_UNSUPPORTED`.
 *
 * - `authorize` gates both roots (`parent_id = null`) and contributions;
 *   answers "may *this actor* create *this kind* here?" and returns a
 *   `CellCreateVerdict`. Runs in `cell_create` after `validate_data` and after
 *   the handler resolves `root_id` and `root_policy` from the parent (an
 *   unviewable parent or a missing or soft-deleted root already 404-masks
 *   before this runs). `ctx` is the request's: `cell_create` and `cell_clone`
 *   have side effects, so `ctx.db` is the request transaction, and an impl
 *   needing more than `root_policy` (a content pre-screen, say) reads through
 *   it. **Read-only** — the authorizer decides, it never writes; a write would
 *   commit or roll back with the create, and nothing enforces this but the
 *   impl.
 * - `validate_policy` accepts or refuses a root `policy` before it is written
 *   (a root's `cell_create`, `cell_policy_set`) — the shape `authorize` reads.
 *   It runs after the manage and root-only gates, so it decides validity, never
 *   authority: throw `jsonrpc_errors.invalid_params` with
 *   `ERROR_CELL_POLICY_INVALID` (or a reason of the consumer's), or a
 *   `ZodError`, which the handler turns into `invalid_params`. **Omitted
 *   refuses every policy** (`ERROR_CELL_POLICY_UNSUPPORTED`, the Rust trait's
 *   default): an authorizer that reads no policy stores none.
 */
export interface CellCreateAuthorize {
	authorize: (
		auth: RequestActorContext,
		input: CellCreateAuthorizeInput,
		ctx: ActionContext
	) => CellCreateVerdict | Promise<CellCreateVerdict>;
	validate_policy?: (policy: CellPolicy) => void;
}

/**
 * Dependencies for `create_cell_actions`.
 *
 * `validate_data` is the optional sub-API hook for per-kind shape
 * validation (e.g., a collection/entry registry), the TS twin of the Rust
 * `CellDataValidator`. It is called as `(kind, data)` — `kind` is the cell's
 * top-level `kind` column, so it dispatches on it: the input's on create, the
 * existing cell's on an update carrying `data` (`kind` is write-once), the
 * source's for every row a clone writes (on the merged data). It accepts or
 * throws, never rewrites: the handler stores the caller's `data` as sent, and
 * it must not mutate it. A thrown `ZodError` becomes the standard
 * `invalid_params` JSON-RPC error so per-kind validation failures surface to
 * clients with code -32602 (not -32603 / internal); throw a `JsonrpcError`
 * (`jsonrpc_errors.invalid_params` with a reason) to choose the reason. When
 * omitted, payloads pass through as-is.
 *
 * `authorize_create` is the optional creation-gate hook (see
 * `CellCreateAuthorize`). When omitted, create is open, and every non-null
 * root policy write is refused.
 */
export type CellActionDeps = ActionFactoryDeps & {
	validate_data?: (kind: string | null, data: Readonly<CellData>) => void;
	authorize_create?: CellCreateAuthorize;
};

/**
 * Translate the `idx_cell_path_unique` violation into a clean `conflict`
 * (409) reason. `path` is the only unique constraint a cell write can hit
 * (the id is a server-generated UUID), so a `23505` on a path-bearing
 * write is unambiguously a path collision.
 */
const path_taken_error = (): ReturnType<typeof jsonrpc_errors.conflict> =>
	jsonrpc_errors.conflict('cell.path is already taken', { reason: ERROR_CELL_PATH_TAKEN });

/** The refusal of a policy write nothing can interpret. */
const cell_policy_unsupported_error = (): ReturnType<typeof jsonrpc_errors.invalid_params> =>
	jsonrpc_errors.invalid_params('cell.policy needs a create authorizer that accepts it', {
		reason: ERROR_CELL_POLICY_UNSUPPORTED
	});

/** The refusal of a policy write on a cell with a parent. */
const cell_policy_root_only_error = (): ReturnType<typeof jsonrpc_errors.invalid_params> =>
	jsonrpc_errors.invalid_params('cell.policy is set only on a root (a cell without a parent)', {
		reason: ERROR_CELL_POLICY_ROOT_ONLY
	});

/** The `cell_moderate` refusal of a transition the contribution's state doesn't allow. */
const cell_not_pending_error = (): ReturnType<typeof jsonrpc_errors.invalid_params> =>
	jsonrpc_errors.invalid_params('cell is not pending moderation', {
		reason: ERROR_CELL_NOT_PENDING
	});

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
				reason: ERROR_CELL_KIND_IN_DATA
			}
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
	policy: row.policy,
	created_by: row.created_by,
	updated_by: row.updated_by,
	created_at: row.created_at,
	updated_at: row.updated_at,
	deleted_at: row.deleted_at,
	grant_count: row.grant_count
});

/**
 * The `{cell_id, kind?, path?}` envelope of the `cell_create` /
 * `cell_update` / `cell_delete` audit rows, `kind` and `path` omitted when
 * null. Relation-graph mutations are tracked independently via per-row
 * `cell_item_*` / `cell_field_*` events.
 */
const cell_mutation_metadata = (row: CellRow): CellAuditMetadata => ({
	cell_id: row.id,
	...(row.kind !== null ? { kind: row.kind } : {}),
	...(row.path !== null ? { path: row.path } : {})
});

/**
 * Gate a loaded cell on `can_view_cell` or, when that denies, the steward arm
 * (`cell_steward_admits` — the governing root's manager reading a pending or
 * rejected contribution), 404-masking a denial.
 *
 * The read gate of the surfaces a moderator works from: `cell_get` and
 * `cell_moderate`'s view step. It is **not** for `cell_clone`'s source, a
 * contribution's parent, the relation endpoint gates, or the grant paths —
 * those keep `can_view_cell` alone (`auth/cell_steward.ts` says why), so a
 * later sweep must not route them here. The steward check runs only after the
 * view check denies, so an admitted read costs no root load.
 */
const admit_viewable_or_stewarded_cell = async (
	deps: QueryDeps,
	auth: RequestContext | null,
	row: CellRow,
	grants: ReadonlyArray<CellGrantRow> | null
): Promise<void> => {
	if (can_view_cell(auth, row, grants)) return;
	if (await cell_steward_admits(deps, auth, row)) return;
	throw cell_not_found_error();
};

/**
 * Load a cell and gate the caller through `admit_viewable_or_stewarded_cell`,
 * 404-masking a miss and a denial alike. `cell_moderate`'s view step — it lets
 * a non-admin root owner reach the root-authority check.
 */
const require_viewable_or_stewarded_cell = async (
	deps: QueryDeps,
	auth: RequestActorContext,
	cell_id: Uuid
): Promise<CellRow> => {
	const row = await query_cell_get(deps, cell_id);
	if (!row) throw cell_not_found_error();
	const grants = await query_cell_grant_list_for_cell(deps, row.id);
	await admit_viewable_or_stewarded_cell(deps, auth, row, grants);
	return row;
};

/** Create the generic cell RPC actions. */
export const create_cell_actions = (deps: CellActionDeps): Array<RpcAction> => {
	const { validate_data, authorize_create } = deps;

	/**
	 * Run the optional `validate_data` deps callback and convert any thrown
	 * `ZodError` into the standard `invalid_params` JSON-RPC error so per-
	 * kind validation failures surface to clients with code -32602 (not
	 * -32603 / internal). The dispatcher only auto-converts ZodError for
	 * wire-level input schemas; sub-API validation runs inside the handler.
	 */
	const validate_data_or_throw = (kind: string | null, data: CellData): void => {
		if (validate_data === undefined) return;
		try {
			validate_data(kind, data);
		} catch (err) {
			if (err instanceof z.ZodError) {
				throw jsonrpc_errors.invalid_params(
					'cell.data shape validation failed',
					dev_only({ issues: err.issues })
				);
			}
			throw err;
		}
	};

	/**
	 * Validate a non-null policy write through the mounted authorizer's
	 * `validate_policy` — `ERROR_CELL_POLICY_UNSUPPORTED` when there is none
	 * (no authorizer, or one without the member). A thrown `ZodError` becomes
	 * `invalid_params`, as `validate_data_or_throw` does.
	 */
	const validate_policy_write = (policy: CellPolicy): void => {
		if (authorize_create?.validate_policy === undefined) throw cell_policy_unsupported_error();
		try {
			authorize_create.validate_policy(policy);
		} catch (err) {
			if (err instanceof z.ZodError) {
				throw jsonrpc_errors.invalid_params(
					'cell.policy validation failed',
					dev_only({ issues: err.issues })
				);
			}
			throw err;
		}
	};

	const create_handler = async (
		input: CellCreateInput,
		ctx: ActionActorContext
	): Promise<CellCreateOutput> => {
		const auth = ctx.auth;
		// Path writes are admin-only. Reject before the insert so the audit
		// + DB are clean.
		if (
			input.path !== undefined &&
			input.path !== null &&
			!has_scoped_role(auth, ROLE_ADMIN, null)
		) {
			throw jsonrpc_errors.forbidden('cell.path is admin-only', {
				reason: ERROR_CELL_PATH_ADMIN_ONLY
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
				{ reason: ERROR_CELL_KIND_EMPTY }
			);
		}
		// Per-kind shape validation (sub-API). Unknown kinds pass through;
		// known kinds with malformed payloads surface as invalid_params.
		const kind = input.kind ?? null;
		validate_data_or_throw(kind, input.data);
		const parent_id = input.parent_id ?? null;
		const policy = input.policy ?? null;
		// A contribution policy is a root's alone, and the mounted authorizer —
		// what interprets it — must accept it (none mounted refuses it). The
		// authorizer does not gate it: a root's creator manages the root anyway.
		if (policy !== null) {
			if (parent_id !== null) throw cell_policy_root_only_error();
			validate_policy_write(policy);
		}
		// Directory tree: resolve the governing `root_id` from the parent (and
		// the root's `policy` for the authorizer). Runs whether or
		// not an authorizer is mounted — `root_id` is written regardless, and an
		// unviewable parent 404-masks the attempt (the same IDOR mask the read
		// path uses; never reveals a hidden container). A root creation
		// (`parent_id` null/absent) has `root_id = null`. The root is read
		// **in-tx**, reusing the parent row when the parent *is* the root, else
		// one read by `root_id` — so the authorizer stays pure + the read rides
		// the handler's connection (no separate-handle deadlock on the
		// single-connection in-memory drivers). A missing or soft-deleted root
		// answers `cell_not_found` like a missing parent (soft delete doesn't
		// cascade, so a live parent can sit under a tombstoned root): nothing is
		// written pointing at the tombstone, and an authorizer never sees a root
		// id it can't read.
		let root_id: Uuid | null = null;
		let root_policy: CellPolicy | null = null;
		let parent_kind: string | null = null;
		if (parent_id !== null) {
			const parent = await require_viewable_cell(ctx, auth, parent_id);
			parent_kind = parent.kind;
			root_id = parent.root_id ?? parent.id;
			if (root_id === parent.id) {
				root_policy = parent.policy;
			} else {
				const root = await query_cell_get(ctx, root_id);
				if (!root) throw cell_not_found_error();
				root_policy = root.policy;
			}
		}
		// Parent-aware creation authorizer (opt-in). Runs after shape validation
		// and after the parent-resolve (a hidden parent already 404-masked).
		// `{allow: false}` for a *viewable* parent / a root creation is a 403
		// `forbidden` (not the 404 mask); an `{allow: true}` verdict folds the
		// moderation outcome. Without an authorizer, create is open: `moderation`
		// stays null and the author's visibility holds.
		let moderation: string | null = null;
		let visibility = input.visibility;
		if (authorize_create) {
			const verdict = await authorize_create.authorize(
				auth,
				{
					kind,
					data: input.data,
					parent_id,
					parent_kind,
					root_id,
					root_policy
				},
				ctx
			);
			if (!verdict.allow) {
				throw jsonrpc_errors.forbidden('cell creation is not permitted here', {
					reason: ERROR_CELL_CREATE_FORBIDDEN
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
		// Possession-gated ref admission, the last gate before the write — every
		// ref is new on a create.
		await require_new_refs_held(ctx, auth, null, input.data as unknown as Json);
		let row: CellRow;
		try {
			row = await query_cell_create(ctx, {
				// Boundary cast: `CellData` is structurally JSON-compatible at
				// runtime (loose object of JSON-safe values), but its inferred
				// type carries `T | undefined` from `.optional()` which doesn't
				// extend `Json`. The DB column is JSONB; the cast trusts the
				// schema-validated runtime shape.
				data: input.data as unknown as Json,
				kind,
				visibility,
				path: input.path ?? null,
				parent_id,
				root_id,
				moderation,
				policy,
				created_by: auth.actor.id
			});
		} catch (err) {
			if (input.path != null && is_pg_unique_violation(err)) throw path_taken_error();
			throw err;
		}
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_create', cell_mutation_metadata(row));
		return { cell: to_cell_json(row) };
	};

	const get_handler = async (input: CellGetInput, ctx: ActionContext): Promise<CellGetOutput> => {
		// both optional on the wire, so the handler holds "id or path" and
		// names it in the reason (`id` wins when both are given)
		if (input.id === undefined && input.path === undefined) {
			throw jsonrpc_errors.invalid_params('cell_get requires id or path', {
				reason: ERROR_CELL_GET_REQUIRES_ID_OR_PATH
			});
		}
		const auth = ctx.auth;
		const row =
			input.id !== undefined
				? await query_cell_get(ctx, input.id)
				: await query_cell_get_by_path(ctx, input.path!);
		if (!row) {
			throw cell_not_found_error();
		}
		// Run the three post-cell fetches in parallel — they share only
		// `row.id` and have no inter-dependency. Bundle fetches one over the
		// cap so we can detect truncation without a separate count query.
		// Skip the grant fetch for unauthenticated callers — no grant can
		// admit a null auth, so the predicate either admits via the public
		// arm or returns false either way.
		const [grants, fields, items] = await Promise.all([
			auth ? query_cell_grant_list_for_cell(ctx, row.id) : Promise.resolve(null),
			query_cell_field_list_for_source(ctx, CELL_VIEWER_UNRESTRICTED, row.id, {
				limit: CELL_RELATIONS_BUNDLE_LIMIT + 1
			}),
			query_cell_item_list_for_parent(ctx, CELL_VIEWER_UNRESTRICTED, row.id, {
				limit: CELL_RELATIONS_BUNDLE_LIMIT + 1
			})
		]);
		// 404 covers both "no such cell" and "exists but caller can't view"
		// — same response code so private-cell existence doesn't leak. The
		// governing root's manager also reads a pending or rejected
		// contribution here (the steward arm); `can_edit` / `can_grant` stay on
		// the base predicates, so a steward reads `false` / `false`.
		await admit_viewable_or_stewarded_cell(ctx, auth, row, grants);
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
			...items_bundled.map((i) => i.child_id)
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
			can_grant
		};
	};

	const update_handler = async (
		input: CellUpdateInput,
		ctx: ActionActorContext
	): Promise<CellUpdateOutput> => {
		const auth = ctx.auth;
		const path_provided = Object.hasOwn(input, 'path');
		// `path` writes are admin-only. Check before fetching so non-admins
		// can't probe for cell existence by varying `path` shape.
		if (path_provided && !has_scoped_role(auth, ROLE_ADMIN, null)) {
			throw jsonrpc_errors.forbidden('cell.path is admin-only', {
				reason: ERROR_CELL_PATH_ADMIN_ONLY
			});
		}
		const existing = await require_editable_cell(ctx, auth, input.cell_id);
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
				reason: ERROR_CELL_VISIBILITY_MANAGE_ONLY
			});
		}
		// Per-kind shape validation when `data` is supplied, against the
		// existing cell's `kind`. Patch-only — we don't validate the existing
		// row's data on update (validation is for incoming patches). `data`
		// writes fully replace, so the patch IS the post-update state. A stray
		// `kind` inside it is rejected (kind is the write-once top-level column —
		// `cell_update` cannot change it, structurally: it is not even a field on
		// `CellUpdateInput`).
		if (input.data !== undefined) {
			reject_kind_in_data(input.data);
			validate_data_or_throw(existing.kind, input.data);
			// Possession-gated ref admission against the cell's current refs: refs
			// the cell already carries stay, whoever introduced them. A write with
			// no `data` writes no refs and reads no holders.
			await require_new_refs_held(ctx, auth, existing.refs, input.data as unknown as Json);
		}
		let updated: CellRow | null;
		try {
			updated = await query_cell_update(ctx, input.cell_id, {
				// Boundary cast (see `create_handler`).
				data: input.data as unknown as Json | undefined,
				visibility: input.visibility,
				path: path_provided ? (input.path ?? null) : undefined,
				updated_by: auth.actor.id
			});
		} catch (err) {
			if (path_provided && input.path != null && is_pg_unique_violation(err)) {
				throw path_taken_error();
			}
			throw err;
		}
		if (!updated) {
			// Raced with a deleter between the visibility check and the UPDATE.
			throw cell_not_found_error();
		}
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_update', cell_mutation_metadata(updated));
		return { cell: to_cell_json(updated) };
	};

	const delete_handler = async (
		input: CellDeleteInput,
		ctx: ActionActorContext
	): Promise<CellDeleteOutput> => {
		const auth = ctx.auth;
		// Fetch first so we can audit `kind` + `path` after the soft-delete
		// flips `deleted_at`.
		const existing = await require_editable_cell(ctx, auth, input.cell_id);
		const deleted = await query_cell_delete(ctx, input.cell_id, { deleted_by: auth.actor.id });
		if (!deleted) {
			// Raced with another deleter.
			throw cell_not_found_error();
		}
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_delete', cell_mutation_metadata(existing));
		return { ok: true, deleted: true };
	};

	const moderate_handler = async (
		input: CellModerateInput,
		ctx: ActionActorContext
	): Promise<CellModerateOutput> => {
		const auth = ctx.auth;
		// 404 covers miss + unviewable so a pending contribution doesn't leak
		// existence to a non-viewer; the governing root's manager stewards it,
		// which is how a non-admin root owner reaches the root check below. An
		// approved contribution its author narrowed to private is not
		// stewarded, so its root owner gets the 404 there.
		const existing = await require_viewable_or_stewarded_cell(ctx, auth, input.cell_id);
		// Only a contribution (with a governing root) is moderatable.
		if (existing.root_id === null) {
			throw jsonrpc_errors.invalid_params(
				'cell is not a contribution (no governing root to moderate under)',
				{ reason: ERROR_CELL_NOT_A_CONTRIBUTION }
			);
		}
		// Authority is over the governing ROOT (admin / root owner), not the
		// contribution — the author manages the contribution and could otherwise
		// self-approve. A viewable-but-unauthorized caller (incl. the author) → 403.
		const root = await query_cell_get(ctx, existing.root_id);
		if (!root) throw cell_not_found_error();
		if (!can_manage_cell(auth, root)) {
			throw jsonrpc_errors.forbidden(
				'cell_moderate requires moderation authority over the governing root',
				{ reason: ERROR_CELL_MODERATE_FORBIDDEN }
			);
		}
		// The UPDATE carries the allowed from-states: an approval moves only a
		// pending contribution, a rejection a pending or approved one (the
		// takedown); a rejected or unmoderated one never moves.
		const approved = input.moderation === 'approved';
		const updated = await query_cell_set_moderation(ctx, input.cell_id, input.moderation, {
			set_visibility_public: approved,
			updated_by: auth.actor.id
		});
		if (!updated) {
			// No row in an allowed from-state: the transition is refused (or
			// another moderator moved it first) — or a deleter won the race (404).
			if (await query_cell_get(ctx, input.cell_id)) throw cell_not_pending_error();
			throw cell_not_found_error();
		}
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_moderate', {
			cell_id: updated.id,
			root_id: existing.root_id,
			moderation: input.moderation
		} satisfies CellModerateAuditMetadata);
		return { cell: to_cell_json(updated) };
	};

	/**
	 * `cell_policy_set` — replace (or clear) a root's contribution policy,
	 * manage-tier on the root. Order: the 404 mask (a caller who can't view the
	 * cell), the manage check (403 `cell_policy_manage_only` — an editor grant
	 * edits `data` but never the policy that decides who may contribute),
	 * root-only (400 `cell_policy_root_only`), then a non-null policy's
	 * validation through the mounted authorizer. Audited with the policy written
	 * and the one it replaced.
	 */
	const policy_set_handler = async (
		input: CellPolicySetInput,
		ctx: ActionActorContext
	): Promise<CellPolicySetOutput> => {
		const auth = ctx.auth;
		const existing = await require_viewable_cell(ctx, auth, input.cell_id);
		if (!can_manage_cell(auth, existing)) {
			throw jsonrpc_errors.forbidden('cell.policy is manage-tier only', {
				reason: ERROR_CELL_POLICY_MANAGE_ONLY
			});
		}
		if (existing.parent_id !== null) throw cell_policy_root_only_error();
		if (input.policy !== null) validate_policy_write(input.policy);
		const result = await query_cell_set_policy(ctx, input.cell_id, input.policy, {
			updated_by: auth.actor.id
		});
		// Raced with a deleter between the gates and the UPDATE.
		if (!result) throw cell_not_found_error();
		const updated = result.cell;
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_policy_set', {
			cell_id: updated.id,
			policy: updated.policy,
			// read under the UPDATE's row lock, not from `existing`, which a set
			// racing past the gates may already have overwritten
			previous_policy: result.previous_policy
		} satisfies CellPolicySetAuditMetadata);
		return { cell: to_cell_json(updated) };
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
	 *
	 * Each cloned row is a creation — a fresh, unparented cell of the
	 * source's kind — so a mounted `authorize_create` gates it exactly as it
	 * gates a parentless `cell_create`: `{allow: false}` is the same 403
	 * `cell_create_forbidden`, and an allow stamps no moderation (a root has
	 * no container to be moderated under). So clone is no side door past the
	 * creation policy: a caller denied a root `cell_create` of some kind can't
	 * clone a viewable cell of that kind into one they own.
	 *
	 * Each row then passes ref admission against **its own source row's** refs
	 * (`require_new_refs_held`): what the source already carries is cloned
	 * without holding it, and only a ref the root's `patch` adds needs
	 * possession.
	 */
	const clone_one_cell_row = async (
		ctx: ActionContext | ActionActorContext,
		source: CellRow,
		auth: RequestActorContext,
		options: { patch_data?: CellData }
	): Promise<CellRow> => {
		// A patch is wire-supplied `data` — reject a stray `kind` (kind is the
		// immutable top-level column; the clone inherits `source.kind`).
		if (options.patch_data !== undefined) reject_kind_in_data(options.patch_data);
		// Both `source.data` and `options.patch_data` are CellData (loose
		// objects). Patch-last shallow merge composes cleanly.
		const merged_data: CellData =
			options.patch_data !== undefined ? { ...source.data, ...options.patch_data } : source.data;
		// Per-kind shape validation runs on the merged result (sub-API), under
		// the source's kind (the clone inherits it). Source rows are validated
		// on their original create; the patch could violate the kind shape
		// (e.g., remove a required field).
		validate_data_or_throw(source.kind, merged_data);
		// Creation-capability gate, after the shape check (the `cell_create`
		// order). The clone is parentless, so no `parent_kind` / `root_id` /
		// `root_policy`.
		if (authorize_create) {
			const verdict = await authorize_create.authorize(
				auth,
				{
					kind: source.kind,
					data: merged_data,
					parent_id: null,
					parent_kind: null,
					root_id: null,
					root_policy: null
				},
				ctx
			);
			if (!verdict.allow) {
				throw jsonrpc_errors.forbidden('cell creation is not permitted here', {
					reason: ERROR_CELL_CREATE_FORBIDDEN
				});
			}
		}
		// Possession-gated ref admission against the source row's refs: a clone
		// carries what the source already serves to this viewer; a patch adding a
		// ref needs the caller to hold it.
		await require_new_refs_held(ctx, auth, source.refs, merged_data as unknown as Json);
		return query_cell_create(ctx, {
			// Boundary cast (see `create_handler`).
			data: merged_data as unknown as Json,
			// Clone inherits the source's kind verbatim — kind is fixed at
			// birth and a `with_data_patch` can't reach the column.
			kind: source.kind,
			visibility: source.visibility,
			path: null, // admin-only paths cannot auto-clone
			// no `policy`: a clone is born without one, so cloning a root never
			// copies its governance onto a cell the cloner owns
			created_by: auth.actor.id
		});
	};

	const clone_handler = async (
		input: CellCloneInput,
		ctx: ActionActorContext
	): Promise<CellCloneOutput> => {
		const auth = ctx.auth;
		// 404 covers both miss and unauthorized read — same shape as cell_get
		// so the existence of private cells doesn't leak through clones.
		const source = await require_viewable_cell(ctx, auth, input.source_id);

		const deep = input.deep === true;
		// Pre-fetch source relations OUTSIDE the transaction so authz checks
		// (per-child `can_view_cell`) on `query_cell_get`-fetched grants
		// don't bloat the transaction. The fetch sees the world as of
		// pre-transaction; the inserts inside the transaction commit
		// atomically together.
		const source_fields = await query_cell_field_list_for_source(
			ctx,
			CELL_VIEWER_UNRESTRICTED,
			source.id
		);
		const source_items = deep
			? await query_cell_item_list_for_parent(ctx, CELL_VIEWER_UNRESTRICTED, source.id)
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
				filter_visible_target_ids(ctx, auth, child_ids)
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
			patch_data: input.with_data_patch
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
			source_fields.map((f) => f.target_id)
		);
		for (const f of source_fields) {
			if (!field_targets_visible.has(f.target_id)) continue;
			// Route through the query layer (not raw SQL) for parity with the
			// item-copy path below. The clone target is fresh, so the UPSERT's
			// `ON CONFLICT` is a no-op — behaviorally a plain insert.
			await query_cell_field_set(ctx, {
				source_id: cloned_root.id,
				name: f.name,
				target_id: f.target_id
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
					child_id: cloned_child.id
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
			const shallow_items = await query_cell_item_list_for_parent(
				ctx,
				CELL_VIEWER_UNRESTRICTED,
				source.id
			);
			const shallow_children_visible = await filter_visible_target_ids(
				ctx,
				auth,
				shallow_items.map((i) => i.child_id)
			);
			for (const item of shallow_items) {
				if (!shallow_children_visible.has(item.child_id)) continue;
				await query_cell_item_insert(ctx, {
					parent_id: cloned_root.id,
					position: item.position,
					child_id: item.child_id
				});
			}
		}

		// `kind` is the source's (not the cloned row's) so the audit trail
		// attributes the clone to the source's shape.
		const cloned_child_count = deep ? cloneable_items.length : 0;
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_clone', {
			source_id: source.id,
			new_id: cloned_root.id,
			deep,
			item_count: cloned_child_count,
			...(source.kind !== null ? { kind: source.kind } : {})
		} satisfies CellCloneAuditMetadata);
		return { cell: to_cell_json(cloned_root) };
	};

	const list_handler = async (
		input: CellListInput,
		ctx: ActionContext
	): Promise<CellListOutput> => {
		const auth = ctx.auth;
		// Null auth + `created_by` is a soft account-id enumeration probe
		// ("does account X have any public cells?") — require auth to use it.
		if (auth === null && input.created_by !== undefined) {
			throw jsonrpc_errors.invalid_params('cell_list created_by requires authentication', {
				reason: ERROR_CELL_LIST_CREATED_BY_REQUIRES_AUTH
			});
		}
		// `shared_with: 'me'` resolves to the caller's actor + role_grants;
		// no auth means no caller, no admit path.
		if (auth === null && input.shared_with !== undefined) {
			throw jsonrpc_errors.invalid_params('cell_list shared_with requires authentication', {
				reason: ERROR_CELL_LIST_SHARED_WITH_REQUIRES_AUTH
			});
		}
		// The caller the SQL view predicate binds — the facts `can_view_cell`
		// reads, its active role grants projected into parallel arrays for the
		// `cell_grant` role-shaped EXISTS (NULL `scope_id`s pass through as
		// global-scope role_grants).
		const viewer = cell_viewer_from_auth(auth);
		const rows = await query_cell_list(ctx, {
			ids: input.ids,
			kind: input.kind,
			visibility: input.visibility,
			ref: input.ref,
			created_by: input.created_by,
			path_prefix: input.path_prefix,
			root_id: input.root_id,
			moderation: input.moderation,
			viewer,
			shared_with_caller_only: input.shared_with === 'me',
			order_by: input.order_by,
			order_direction: input.order_direction,
			// Apply the default cap when caller omits `limit`. Without this
			// the SQL `LIMIT NULL` returns every matching row.
			limit: input.limit ?? CELL_LIST_LIMIT_DEFAULT,
			offset: input.offset
		});
		let cell_grants: Record<string, Array<GrantJson>> | undefined;
		if (input.shared_with === 'me' && rows.length > 0 && viewer.actor_id !== null) {
			const grant_rows = await query_cell_grants_for_caller_in_cells(
				ctx,
				rows.map((r) => r.id),
				viewer
			);
			cell_grants = {};
			for (const g of grant_rows) {
				(cell_grants[g.cell_id] ??= []).push(to_grant_json(g));
			}
		}
		return { cells: rows.map(to_cell_json), cell_grants };
	};

	return [
		rpc_action(cell_create_action_spec, create_handler),
		rpc_action(cell_get_action_spec, get_handler),
		rpc_action(cell_update_action_spec, update_handler),
		rpc_action(cell_delete_action_spec, delete_handler),
		rpc_action(cell_list_action_spec, list_handler),
		rpc_action(cell_clone_action_spec, clone_handler),
		rpc_action(cell_moderate_action_spec, moderate_handler),
		rpc_action(cell_policy_set_action_spec, policy_set_handler)
	];
};
