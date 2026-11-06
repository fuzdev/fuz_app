/**
 * Cell-item RPC specs — declarative contract for the four ordered-child
 * verbs (`insert` / `move` / `delete` / `list`).
 *
 * `(parent_id, position) → child_id` rows. `position` is opaque text
 * (fractional-indexing key); the wire validates the alphabet
 * (`^[0-9A-Za-z]+$`) and length, the lex-ordering invariant is the
 * client's contract.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	array,
	boolean,
	brand,
	literal,
	object,
	optional,
	pipe,
	regex,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import {
	FRACTIONAL_INDEX_LENGTH_MAX,
	FRACTIONAL_INDEX_REGEX
} from '@fuzdev/fuz_util/fractional_index.ts';

import { ActingActor, bounded_string, Uuid } from '../primitive_schemas_fuz.ts';
import { CellRelationListLimit } from './cell_relation_list_limit.ts';
import type { RequestResponseActionSpec } from '../actions/action_spec.ts';

// -- Error reasons ----------------------------------------------------------

/** Error reason — `cell_item_list` got neither or both of `parent_id` and `child_id`. */
export const ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD =
	'cell_item_list_requires_parent_or_child' as const;

/**
 * Error reason — `(parent_id, position)` collision on `cell_item_insert`
 * or `cell_item_move`. Surfaces when two clients computed the same
 * fractional-indexing key (rare given helper-side jitter, which is on by
 * default; the safety net for the residual race). A client that opts out
 * with `{jitter: false}` gets bare deterministic mids, so two of them
 * racing the same bracket collide every time and this stops being rare —
 * that mode is for reproducible callers (seeders, fixtures), not concurrent
 * ones. Client refreshes its bracket and retries.
 */
export const ERROR_CELL_ITEM_POSITION_TAKEN = 'cell_item_position_taken' as const;

// -- Shared schemas ---------------------------------------------------------

/**
 * Position grammar — base62 fractional-indexing key. Wire enforces
 * non-empty, alphabet only, and the helper's `FRACTIONAL_INDEX_LENGTH_MAX`
 * cap (well above realistic lengths even for hundreds of consecutive
 * front-inserts; set high to avoid arbitrary cliffs). Lex ordering is the
 * contract; the no-trailing-`'0'` invariant lives in the helper, not the
 * wire.
 */
export const CellItemPosition = brand(
	pipe(bounded_string({ min: 1, max: FRACTIONAL_INDEX_LENGTH_MAX }), regex(FRACTIONAL_INDEX_REGEX)),
	'CellItemPosition'
);
export type CellItemPosition = Infer<typeof CellItemPosition>;

/**
 * Wire-format for a `cell_item` row.
 *
 * `position` is branded `CellItemPosition` so consumers that round-trip
 * the value back into a `position_after` / `position` input field don't
 * need a cast at every call site. Wire ingress is validated by the
 * `CellItemPosition` schema (alphabet + length); wire egress trusts
 * the DB CHECK constraint that backs `cell_item.position`, so the
 * server-side `to_item_json` casts a raw string from `CellItemRow`.
 */
export const ItemJson = object({
	parent_id: Uuid,
	position: CellItemPosition,
	child_id: Uuid,
	created_at: string
});
export type ItemJson = Infer<typeof ItemJson>;

// -- cell_item_insert -------------------------------------------------------

/**
 * Input for `cell_item_insert`. Caller computes `position` via
 * `fractional_index_between(prev, next)` (`@fuzdev/fuz_util/fractional_index.ts`)
 * client-side. Returns `cell_item_position_taken` on `(parent_id,
 * position)` unique violation; client refreshes bracket and retries.
 */
export const CellItemInsertInput = object({
	parent_id: meta(Uuid, { description: 'Cell to insert into.' }),
	child_id: meta(Uuid, { description: 'Cell to insert as a child.' }),
	position: meta(CellItemPosition, {
		description: 'Fractional-indexing key. Client-computed via `fractional_index_between`.'
	}),
	acting: ActingActor
});
export type CellItemInsertInput = Infer<typeof CellItemInsertInput>;

export const CellItemInsertOutput = object({ item: ItemJson });
export type CellItemInsertOutput = Infer<typeof CellItemInsertOutput>;

// -- cell_item_move ---------------------------------------------------------

/**
 * Input for `cell_item_move`. Move within the same parent (cross-parent
 * moves are a future extension).
 */
export const CellItemMoveInput = object({
	parent_id: meta(Uuid, { description: 'Parent cell.' }),
	position: meta(CellItemPosition, { description: 'Current position of the row to move.' }),
	new_position: meta(CellItemPosition, { description: 'New fractional-indexing key.' }),
	acting: ActingActor
});
export type CellItemMoveInput = Infer<typeof CellItemMoveInput>;

export const CellItemMoveOutput = object({ item: ItemJson });
export type CellItemMoveOutput = Infer<typeof CellItemMoveOutput>;

// -- cell_item_delete -------------------------------------------------------

/** Input for `cell_item_delete`. Idempotent on the slot key. */
export const CellItemDeleteInput = object({
	parent_id: meta(Uuid, { description: 'Parent cell.' }),
	position: meta(CellItemPosition, { description: 'Slot to delete.' }),
	acting: ActingActor
});
export type CellItemDeleteInput = Infer<typeof CellItemDeleteInput>;

export const CellItemDeleteOutput = object({
	ok: literal(true),
	deleted: boolean
});
export type CellItemDeleteOutput = Infer<typeof CellItemDeleteOutput>;

// -- cell_item_list ---------------------------------------------------------

/**
 * Input for `cell_item_list`. Pass `parent_id` for forward items or
 * `child_id` for reverse lists — exactly one; both or neither is
 * `invalid_params` with `ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD`, from
 * the handler (the schema leaves both optional). Reverse listing has 2-layer
 * authz (child view-check gates the call; per-parent view-check filters
 * the rows).
 *
 * Either direction returns a page of up to `limit` items (default
 * `CELL_RELATION_LIST_LIMIT_DEFAULT`) whose other end the caller can view —
 * the view check runs before the limit. Forward listing pages on via
 * `position_after` (return rows with `position > position_after`); the
 * reverse listing has no cursor, oldest item first.
 */
export const CellItemListInput = meta(
	object({
		parent_id: meta(optional(Uuid), {
			description: 'List forward items whose parent is this cell.'
		}),
		child_id: meta(optional(Uuid), {
			description: 'List reverse parents whose child is this cell.'
		}),
		position_after: meta(optional(CellItemPosition), {
			description: 'Cursor for forward pagination — return rows whose position > this.'
		}),
		limit: CellRelationListLimit,
		acting: ActingActor
	}),
	{ empty_input_handler_guarded: true }
);
export type CellItemListInput = Infer<typeof CellItemListInput>;

export const CellItemListOutput = object({
	items: array(ItemJson)
});
export type CellItemListOutput = Infer<typeof CellItemListOutput>;

// -- Action specs -----------------------------------------------------------

export const cell_item_insert_action_spec = {
	method: 'cell_item_insert',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: true,
	input: CellItemInsertInput,
	output: CellItemInsertOutput,
	async: true,
	description:
		'Insert a cell as an ordered child at `position` under `parent`. Caller must be able to edit `parent` and view `child`. Returns `cell_item_position_taken` on `(parent_id, position)` unique violation; client refreshes bracket and retries.'
} satisfies RequestResponseActionSpec;

export const cell_item_move_action_spec = {
	method: 'cell_item_move',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: true,
	input: CellItemMoveInput,
	output: CellItemMoveOutput,
	async: true,
	description:
		'Move an item within its parent to a new position. Caller must be able to edit `parent`. Returns `cell_item_position_taken` on the new-position unique violation.'
} satisfies RequestResponseActionSpec;

export const cell_item_delete_action_spec = {
	method: 'cell_item_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: true,
	input: CellItemDeleteInput,
	output: CellItemDeleteOutput,
	async: true,
	description:
		'Delete the item at `(parent, position)`. Idempotent — `deleted: false` when no row matched. Caller must be able to edit `parent`.'
} satisfies RequestResponseActionSpec;

export const cell_item_list_action_spec = {
	method: 'cell_item_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'optional', actor: 'optional' },
	side_effects: false,
	input: CellItemListInput,
	output: CellItemListOutput,
	async: true,
	rate_limit: 'ip',
	description:
		'List forward items (pass `parent_id`) or reverse parents (pass `child_id`). Forward listing filters children to those the caller may view (strict target-visibility). Reverse listing has 2-layer authz: gate on `can_view_cell(child)` first (404 otherwise), then filter rows by per-parent `can_view_cell`. Per-IP rate-limited — symmetric with `cell_get` to bound public-surface id-walking.'
} satisfies RequestResponseActionSpec;

/** All cell_item action specs — composed into `all_cell_action_specs`. */
export const all_cell_item_action_specs = [
	cell_item_insert_action_spec,
	cell_item_move_action_spec,
	cell_item_delete_action_spec,
	cell_item_list_action_spec
] as const;
