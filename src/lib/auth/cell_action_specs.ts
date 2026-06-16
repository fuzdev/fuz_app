/**
 * Cell RPC action specs — the declarative contract for the six generic
 * cell verbs. App vocabulary (galleries, posts, events) lives in
 * client-side helpers; the wire stays generic.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';
import {FactHashSchema} from '@fuzdev/fuz_util/fact_hash.ts';

import type {RequestResponseActionSpec} from '../actions/action_spec.ts';
import {ActingActor} from '../http/auth_shape.ts';
import {
	all_cell_grant_action_specs,
	cell_grant_create_action_spec,
	cell_grant_revoke_action_spec,
	cell_grant_list_action_spec,
	GrantJson,
} from './cell_grant_action_specs.ts';
import {
	all_cell_field_action_specs,
	cell_field_set_action_spec,
	cell_field_delete_action_spec,
	cell_field_list_action_spec,
	FieldJson,
} from './cell_field_action_specs.ts';
import {
	all_cell_item_action_specs,
	cell_item_insert_action_spec,
	cell_item_move_action_spec,
	cell_item_delete_action_spec,
	cell_item_list_action_spec,
	ItemJson,
} from './cell_item_action_specs.ts';
import {
	all_cell_audit_action_specs,
	cell_audit_list_action_spec,
} from './cell_audit_action_specs.ts';
import {CellData} from './cell_data_schema.ts';

/**
 * Cell visibility — the coarse-grained access-control axis for a cell.
 * Sibling to `cell_grant` (the fine-grained allowlist of actor- /
 * role-shaped principals at `viewer` / `editor` levels). Together they
 * form the cell-layer access-control surface:
 *
 * - `cell.visibility = 'public'` admits everyone, including
 *   unauthenticated visitors. `cell_grant` rows still apply for edit-
 *   level admit; read is universal.
 * - `cell.visibility = 'private'` (default) restricts read to admin /
 *   owner (`created_by`) / `cell_grant`-admitted callers.
 *
 * Stored as a top-level PG enum column (`cell.visibility`) — NOT inside
 * `cell.data`, which is content metadata only. `can_view_cell` reads
 * the column directly.
 */
export const CellVisibility = z.enum(['private', 'public']);
export type CellVisibility = z.infer<typeof CellVisibility>;

// Re-exported so the codegen's `cell_specs.*` qualifier resolves them
// under the single cell-layer namespace. `cell_action_specs.ts` is the
// registry/aggregator module for the cell layer; the grant / field /
// item specs live in their own files for source-file separation but
// ride the same namespace.
export {cell_grant_create_action_spec, cell_grant_revoke_action_spec, cell_grant_list_action_spec};
export {cell_field_set_action_spec, cell_field_delete_action_spec, cell_field_list_action_spec};
export {
	cell_item_insert_action_spec,
	cell_item_move_action_spec,
	cell_item_delete_action_spec,
	cell_item_list_action_spec,
};
export {cell_audit_list_action_spec};

// -- Error reasons ----------------------------------------------------------

/** Error reason — cell id did not resolve, or caller can't view it. */
export const ERROR_CELL_NOT_FOUND = 'cell_not_found' as const;

/** Error reason — caller is not an admin and supplied a `path` write. */
export const ERROR_CELL_PATH_ADMIN_ONLY = 'cell_path_admin_only' as const;

/**
 * Error reason — a `path` write collided with an existing active cell's
 * path. `path` is globally unique on active rows (`idx_cell_path_unique`);
 * the create / update handlers translate the unique-index violation into
 * this `conflict` (409) reason rather than leaking a raw internal error.
 * Soft-deleted rows free their path (the index is partial on
 * `deleted_at IS NULL`), so reusing a deleted cell's path does not collide.
 */
export const ERROR_CELL_PATH_TAKEN = 'cell_path_taken' as const;

/**
 * Error reason — caller tried to write `cell.visibility` without the
 * manage tier (`can_manage_cell` = admin / owner). Editor-grant holders
 * may edit `data` but cannot flip a cell's visibility — that is a
 * manage-tier-only operation.
 */
export const ERROR_CELL_VISIBILITY_MANAGE_ONLY = 'cell_visibility_manage_only' as const;

/** Error reason — input shape for `cell_get` lacked both `id` and `path`. */
export const ERROR_CELL_GET_REQUIRES_ID_OR_PATH = 'cell_get_requires_id_or_path' as const;

/**
 * Error reason — `cell_clone` `with_data_patch` would change `data.kind`.
 * Per-kind shape validation can pass coincidentally (e.g., one kind's
 * schema accepts most of another's fields), so we reject the cross-kind
 * patch explicitly to prevent incoherent clones.
 */
export const ERROR_CELL_CLONE_KIND_MISMATCH = 'cell_clone_kind_mismatch' as const;

/**
 * Error reason — null-auth `cell_list` caller passed a `created_by`
 * filter. The filter is a soft account-id enumeration vector ("does
 * account X have any public cells?"), so we require an authenticated
 * caller to use it.
 */
export const ERROR_CELL_LIST_CREATED_BY_REQUIRES_AUTH =
	'cell_list_created_by_requires_auth' as const;

/**
 * Error reason — null-auth `cell_list` caller passed `shared_with: 'me'`.
 * The filter resolves to the caller's account + role_grants, which only
 * exist for an authenticated session.
 */
export const ERROR_CELL_LIST_SHARED_WITH_REQUIRES_AUTH =
	'cell_list_shared_with_requires_auth' as const;

// -- Shared schemas ---------------------------------------------------------

/**
 * Wire form for `cell.path`.
 *
 * At the spec level we only enforce that the value is a non-empty string
 * with a sane upper bound — the cell layer is generic and doesn't impose
 * a path grammar. App-side curation (well-known names like `/map/main`,
 * `/site/events`) is admin-driven.
 */
export const CELL_PATH_LENGTH_MAX = 256;

/**
 * Branded so the type system distinguishes a validated path from any other
 * string. Construct via `CellPath.parse(s)` at external boundaries; the
 * RPC dispatcher does this automatically when the wire schema (`CellCreateInput`,
 * `CellGetInput`, `CellUpdateInput`, `CellListInput`) is parsed at the entry
 * point. Frontend callers handing a raw string to `api.cell_*` cast at the
 * callsite (`as CellPath`) — the runtime check still runs server-side.
 */
export const CellPath = z.string().min(1).max(CELL_PATH_LENGTH_MAX).brand('CellPath');
export type CellPath = z.infer<typeof CellPath>;

/**
 * Soft cap on the size of a `cell.list` request page. Larger pages chew
 * memory both server- and client-side; combined with the visibility
 * predicate's filter cost, 200 is a safe ceiling.
 */
export const CELL_LIST_LIMIT_MAX = 200;
export const CELL_LIST_LIMIT_DEFAULT = 50;

/**
 * Hard cap on bundled relation arrays in `cell_get` (per-relation
 * `LIMIT`). Beyond this the response sets `*_truncated: true` and the
 * client paginates via `cell_item_list({parent_id, position_after})` /
 * `cell_field_list({source_id, name_after})`.
 */
export const CELL_RELATIONS_BUNDLE_LIMIT = 500;

/**
 * Wire form for a cell row. `data` is the typed-but-permissive `CellData`
 * shape (kind / label / summary typed-and-optional, additional fields
 * pass through). Per-kind shape validation is sub-API and handled by
 * the app's `validate_data` deps callback (see `auth/cell_actions.ts`).
 *
 * `visibility` is the access-control axis — a top-level column on the
 * row, not a field inside `data`. `cell_grant` and `visibility` are the
 * two ACL surfaces; both live as peers, not embedded in content.
 *
 * `path` is the global namespace axis (no tenant/hub scoping).
 *
 * Relations (`items`, `fields`) are NOT carried on the cell row — they
 * live in the `cell_item` / `cell_field` sibling tables. Bundled arrays
 * appear on `CellGetOutput`; other read verbs (`cell_list`) do not bundle.
 */
export const CellJson = z.strictObject({
	id: Uuid,
	path: CellPath.nullable(),
	data: CellData,
	visibility: CellVisibility.meta({
		description:
			"Access-control tag. `'public'` admits everyone (including unauthenticated visitors); `'private'` (default) admits admin / owner / `cell_grant`-admitted callers. Top-level column, not inside `data`.",
	}),
	refs: z.array(FactHashSchema).nullable(),
	created_by: Uuid.nullable(),
	updated_by: Uuid.nullable(),
	created_at: z.string(),
	updated_at: z.string().nullable(),
	deleted_at: z.string().nullable(),
	grant_count: z.number().int().nonnegative().meta({
		description:
			'Number of `cell_grant` rows naming this cell. Non-leaky scalar (no actor/role identity); surfaces "Shared with N" badges. Derived in SQL via a correlated subquery on `idx_cell_grant_cell`.',
	}),
});
export type CellJson = z.infer<typeof CellJson>;

// -- cell_create ------------------------------------------------------------

/**
 * Input for `cell_create`. `created_by` is NOT on the wire — the handler
 * stamps it from auth.actor.id. `path` is admin-only; non-admin callers
 * supplying `path` get `ERROR_CELL_PATH_ADMIN_ONLY` (forbidden).
 */
export const CellCreateInput = z.strictObject({
	data: CellData.meta({
		description:
			'Cell data. Base fields (kind / label / summary) typed; extras loose. Per-kind shape is sub-API.',
	}),
	visibility: CellVisibility.optional().meta({
		description:
			"Access-control tag. Top-level column (not in `data`). Default `'private'` when omitted.",
	}),
	path: CellPath.nullish().meta({
		description: 'Admin-only named lookup alias. Globally unique on active rows.',
	}),
	acting: ActingActor,
});
export type CellCreateInput = z.infer<typeof CellCreateInput>;

export const CellCreateOutput = z.strictObject({cell: CellJson});
export type CellCreateOutput = z.infer<typeof CellCreateOutput>;

// -- cell_get ---------------------------------------------------------------

/**
 * Input for `cell_get`. Pass `id` OR `path` (exactly one expected; both
 * accepted, `id` takes precedence). The handler responds with 404 when no
 * row matches OR when `can_view_cell` rejects the caller — same code so
 * private-cell existence doesn't leak.
 */
export const CellGetInput = z
	.strictObject({
		id: Uuid.optional(),
		path: CellPath.optional(),
		acting: ActingActor,
	})
	.refine((v) => v.id !== undefined || v.path !== undefined, {
		message: ERROR_CELL_GET_REQUIRES_ID_OR_PATH,
	});
export type CellGetInput = z.infer<typeof CellGetInput>;

/**
 * Output for `cell_get`. Bundles relation arrays (`fields` + `items`)
 * server-side via JOINs so the common "show this cell with its
 * children" flow needs one round-trip. Targets are filtered to those the
 * caller may view (strict target-visibility). Per-relation `LIMIT
 * CELL_RELATIONS_BUNDLE_LIMIT`; clients paginate via
 * `cell_item_list({parent_id, position_after})` /
 * `cell_field_list({source_id})` when truncated.
 */
export const CellGetOutput = z.strictObject({
	cell: CellJson,
	fields: z.array(FieldJson),
	fields_truncated: z.boolean(),
	items: z.array(ItemJson),
	items_truncated: z.boolean(),
	can_edit: z.boolean(),
	can_grant: z.boolean(),
});
export type CellGetOutput = z.infer<typeof CellGetOutput>;

// -- cell_update ------------------------------------------------------------

/**
 * Input for `cell_update`. Fields left undefined keep their existing value.
 * `path` writes are admin-only (handler-enforced); non-admin callers
 * supplying `path` get `ERROR_CELL_PATH_ADMIN_ONLY` even if no other field
 * is changing. `visibility` writes require the manage tier
 * (`can_manage_cell` = admin / owner) — editor-grant holders editing
 * `data` cannot flip visibility (`ERROR_CELL_VISIBILITY_MANAGE_ONLY`).
 */
export const CellUpdateInput = z.strictObject({
	cell_id: Uuid.meta({description: 'Cell to update.'}),
	data: CellData.optional(),
	visibility: CellVisibility.optional().meta({
		description: 'Access-control tag. Top-level column (not in `data`). Manage-tier write.',
	}),
	path: CellPath.nullable().optional().meta({description: 'Admin-only path write.'}),
	acting: ActingActor,
});
export type CellUpdateInput = z.infer<typeof CellUpdateInput>;

export const CellUpdateOutput = z.strictObject({cell: CellJson});
export type CellUpdateOutput = z.infer<typeof CellUpdateOutput>;

// -- cell_delete ------------------------------------------------------------

export const CellDeleteInput = z.strictObject({
	cell_id: Uuid.meta({description: 'Cell to soft-delete.'}),
	acting: ActingActor,
});
export type CellDeleteInput = z.infer<typeof CellDeleteInput>;

export const CellDeleteOutput = z.strictObject({
	ok: z.literal(true),
	deleted: z.boolean(),
});
export type CellDeleteOutput = z.infer<typeof CellDeleteOutput>;

// -- cell_list --------------------------------------------------------------

/**
 * Input for `cell_list`. Filters are optional and combine with AND. The
 * handler applies the SQL-side visibility predicate from
 * `query_cell_list` so the page-window stays correct under pagination —
 * post-filtering in JS would silently truncate pages.
 *
 * `ids` is the batch-read filter — pass a list of cell ids to fetch them
 * in one round-trip (avoids N+1 when rendering a collection's `items[]`).
 * The visibility predicate still runs, so callers passing ids they can't
 * view simply get fewer rows back. Capped at `CELL_LIST_LIMIT_MAX`.
 *
 * `shared_with: 'me'` narrows to cells that admit the caller via a
 * `cell_grant` row (actor-shaped or role-shaped principal) AND that
 * the caller does not own. Authenticated only; combine with
 * `data_kind` / `path_prefix` etc. to scope further. Combining with
 * `created_by: <my-actor-id>` produces an empty result by definition
 * (owner is implicit, never appears as a grant principal); we don't
 * reject the combination at the schema layer because SQL emptiness is
 * correct.
 */
export const CellListInput = z
	.strictObject({
		ids: z
			.array(Uuid)
			.max(CELL_LIST_LIMIT_MAX)
			.optional()
			.meta({description: 'Batch-fetch by id. Visibility predicate still applies.'}),
		data_kind: z.string().min(1).optional().meta({description: 'Match `data.kind = ?`.'}),
		visibility: CellVisibility.optional().meta({
			description:
				"Match `cell.visibility = ?`. The SQL-side auth-narrow already filters to public-or-admitted; this is an additional narrowing filter (e.g. `visibility: 'public'` on the discovery feed so authed callers don't see their own private entries mixed in).",
		}),
		ref: FactHashSchema.optional().meta({description: 'Match cells referencing this fact hash.'}),
		created_by: Uuid.optional().meta({description: 'Filter to a specific creator.'}),
		path_prefix: CellPath.optional().meta({
			description: 'Match cells whose path starts with this.',
		}),
		shared_with: z.literal('me').optional().meta({
			description:
				'Narrow to cells admitting the caller via `cell_grant`, excluding cells the caller owns. Self-only — a `Uuid` form would need cross-actor role_grant loading.',
		}),
		order_by: z.enum(['created_at', 'updated_at']).optional(),
		order_direction: z.enum(['asc', 'desc']).optional(),
		limit: z.number().int().positive().max(CELL_LIST_LIMIT_MAX).optional(),
		offset: z.number().int().nonnegative().optional(),
		acting: ActingActor,
	})
	.default({});
export type CellListInput = z.infer<typeof CellListInput>;

export const CellListOutput = z.strictObject({
	cells: z.array(CellJson),
	cell_grants: z.record(z.string(), z.array(GrantJson)).optional(),
});
export type CellListOutput = z.infer<typeof CellListOutput>;

// -- cell_clone -------------------------------------------------------------

/**
 * Input for `cell_clone`. Source must be view-admitted by `can_view_cell`
 * (404 otherwise — IDOR mask). The clone is owned by the caller; `path`
 * is always nulled (admin-only paths can't auto-clone). Provenance lives
 * only in the `cell_clone` audit row's `source_id` — no provenance
 * fields are stamped into `data`.
 */
export const CellCloneInput = z.strictObject({
	source_id: Uuid.meta({description: 'Cell to clone.'}),
	deep: z.boolean().optional().meta({
		description: 'Recurse into `items[]` (depth=1 — clones direct children only). Default false.',
	}),
	// TODO: cap `with_data_patch` size/depth once a consumer measures the
	// upper bound. `z.json()` is unbounded — a multi-MB patch is in scope
	// today, gated only by the JSON-RPC body limit. Realistic patches are
	// O(few KB); a `.refine` on serialized size would tighten the surface
	// without disturbing the patch-wins-last semantics.
	with_data_patch: CellData.optional().meta({
		description:
			"Optional shallow patch merged into the new root cell's `data` (patch-last semantics).",
	}),
	acting: ActingActor,
});
export type CellCloneInput = z.infer<typeof CellCloneInput>;

export const CellCloneOutput = z.strictObject({cell: CellJson});
export type CellCloneOutput = z.infer<typeof CellCloneOutput>;

// -- Action specs -----------------------------------------------------------

export const cell_create_action_spec = {
	method: 'cell_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellCreateInput,
	output: CellCreateOutput,
	async: true,
	rate_limit: 'account',
	description:
		'Create a cell. Handler stamps `created_by` from auth.actor.id; `path` writes are admin-only. Per-account rate-limited to bound write-spam.',
} satisfies RequestResponseActionSpec;

export const cell_get_action_spec = {
	method: 'cell_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'optional', actor: 'optional'},
	side_effects: false,
	input: CellGetInput,
	output: CellGetOutput,
	async: true,
	rate_limit: 'ip',
	description:
		'Fetch a cell by id or path. Per-row authz via `can_view_cell`; unauthed callers get only `cell.visibility === "public"` cells. 404 on miss or unauthorized — no existence leak. Bundled relations are filtered to viewable targets. Per-IP rate-limited as the defense-in-depth complement to `cell_list`: an id-walker that learns ids from a side channel can pivot from the enumeration entry point to per-row reads.',
} satisfies RequestResponseActionSpec;

export const cell_update_action_spec = {
	method: 'cell_update',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellUpdateInput,
	output: CellUpdateOutput,
	async: true,
	description:
		'Update a cell. Per-row `can_edit_cell` (admin / owner / editor-grant). `visibility` writes require the manage tier (admin / owner). `path` writes are admin-only. Stamps `updated_by`.',
} satisfies RequestResponseActionSpec;

export const cell_delete_action_spec = {
	method: 'cell_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellDeleteInput,
	output: CellDeleteOutput,
	async: true,
	description: 'Soft-delete a cell. Per-row `can_edit_cell` (admin / owner / editor-grant).',
} satisfies RequestResponseActionSpec;

export const cell_list_action_spec = {
	method: 'cell_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'optional', actor: 'optional'},
	side_effects: false,
	input: CellListInput,
	output: CellListOutput,
	async: true,
	rate_limit: 'ip',
	description:
		'List cells with optional filters. SQL-side visibility predicate: admin sees all; authed see owned + public + grant-admitted; null auth sees public-only. `created_by` filter is rejected for null auth (account-id enumeration guard). Per-IP rate-limited to bound the public-enumeration surface (paired with `actor_lookup` it would be a scrape primitive).',
} satisfies RequestResponseActionSpec;

export const cell_clone_action_spec = {
	method: 'cell_clone',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellCloneInput,
	output: CellCloneOutput,
	async: true,
	rate_limit: 'account',
	description:
		'Clone a cell (optionally deep). New owner is the caller; `path` is always nulled. Provenance recorded only in the `cell_clone` audit row. Per-account rate-limited — `deep: true` walks `cell_item` rows and fans out, so unbounded clone is a write-amplification vector.',
} satisfies RequestResponseActionSpec;

/**
 * All cell-layer action specs — composed by app registries. Bundles the
 * six generic verbs (this module), the three `cell_grant_*` specs, the
 * three `cell_field_*` specs, the four `cell_item_*` specs, and the
 * `cell_audit_list` spec so codegen + UI clients see a single cell
 * namespace.
 */
export const all_cell_action_specs = [
	cell_create_action_spec,
	cell_get_action_spec,
	cell_update_action_spec,
	cell_delete_action_spec,
	cell_list_action_spec,
	cell_clone_action_spec,
	...all_cell_grant_action_specs,
	...all_cell_field_action_specs,
	...all_cell_item_action_specs,
	...all_cell_audit_action_specs,
] as const;
