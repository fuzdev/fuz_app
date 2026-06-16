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

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';
import {
	FRACTIONAL_INDEX_LENGTH_MAX,
	FRACTIONAL_INDEX_REGEX,
} from '@fuzdev/fuz_util/fractional_index.ts';

import {ActingActor} from '../http/auth_shape.ts';
import type {RequestResponseActionSpec} from '../actions/action_spec.ts';

// -- Error reasons ----------------------------------------------------------

/** Error reason — `cell_item_list` got neither `parent_id` nor `child_id`. */
export const ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD =
	'cell_item_list_requires_parent_or_child' as const;

/**
 * Error reason — `(parent_id, position)` collision on `cell_item_insert`
 * or `cell_item_move`. Surfaces when two clients computed the same
 * fractional-indexing key (rare given helper-side jitter; the safety
 * net for the residual race). Client refreshes its bracket and retries.
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
export const CellItemPosition = z
	.string()
	.min(1)
	.max(FRACTIONAL_INDEX_LENGTH_MAX)
	.regex(FRACTIONAL_INDEX_REGEX)
	.brand('CellItemPosition');
export type CellItemPosition = z.infer<typeof CellItemPosition>;

/**
 * Wire-format for a `cell_item` row.
 *
 * `position` is branded `CellItemPosition` so consumers that round-trip
 * the value back into a `position_after` / `position` input field don't
 * need a cast at every call site. Wire ingress is validated by the
 * `CellItemPosition` Zod schema (alphabet + length); wire egress trusts
 * the DB CHECK constraint that backs `cell_item.position`, so the
 * server-side `to_item_json` casts a raw string from `CellItemRow`.
 */
export const ItemJson = z.strictObject({
	parent_id: Uuid,
	position: CellItemPosition,
	child_id: Uuid,
	created_at: z.string(),
});
export type ItemJson = z.infer<typeof ItemJson>;

// -- cell_item_insert -------------------------------------------------------

/**
 * Input for `cell_item_insert`. Caller computes `position` via
 * `fractional_index_between(prev, next)` (`@fuzdev/fuz_util/fractional_index.ts`)
 * client-side. Returns `cell_item_position_taken` on `(parent_id,
 * position)` unique violation; client refreshes bracket and retries.
 */
export const CellItemInsertInput = z.strictObject({
	parent_id: Uuid.meta({description: 'Cell to insert into.'}),
	child_id: Uuid.meta({description: 'Cell to insert as a child.'}),
	position: CellItemPosition.meta({
		description: 'Fractional-indexing key. Client-computed via `fractional_index_between`.',
	}),
	acting: ActingActor,
});
export type CellItemInsertInput = z.infer<typeof CellItemInsertInput>;

export const CellItemInsertOutput = z.strictObject({item: ItemJson});
export type CellItemInsertOutput = z.infer<typeof CellItemInsertOutput>;

// -- cell_item_move ---------------------------------------------------------

/**
 * Input for `cell_item_move`. Move within the same parent (cross-parent
 * moves are a future extension).
 */
export const CellItemMoveInput = z.strictObject({
	parent_id: Uuid.meta({description: 'Parent cell.'}),
	position: CellItemPosition.meta({description: 'Current position of the row to move.'}),
	new_position: CellItemPosition.meta({description: 'New fractional-indexing key.'}),
	acting: ActingActor,
});
export type CellItemMoveInput = z.infer<typeof CellItemMoveInput>;

export const CellItemMoveOutput = z.strictObject({item: ItemJson});
export type CellItemMoveOutput = z.infer<typeof CellItemMoveOutput>;

// -- cell_item_delete -------------------------------------------------------

/** Input for `cell_item_delete`. Idempotent on the slot key. */
export const CellItemDeleteInput = z.strictObject({
	parent_id: Uuid.meta({description: 'Parent cell.'}),
	position: CellItemPosition.meta({description: 'Slot to delete.'}),
	acting: ActingActor,
});
export type CellItemDeleteInput = z.infer<typeof CellItemDeleteInput>;

export const CellItemDeleteOutput = z.strictObject({
	ok: z.literal(true),
	deleted: z.boolean(),
});
export type CellItemDeleteOutput = z.infer<typeof CellItemDeleteOutput>;

// -- cell_item_list ---------------------------------------------------------

/**
 * Input for `cell_item_list`. Pass `parent_id` for forward items or
 * `child_id` for reverse lists — exactly one. Reverse listing has 2-layer
 * authz (child view-check gates the call; per-parent view-check filters
 * the rows).
 *
 * Forward listing supports cursor pagination via `position_after`
 * (return rows with `position > position_after`). The reverse listing
 * doesn't paginate (the result set is small in practice — number of
 * parents containing a given child).
 */
export const CellItemListInput = z
	.strictObject({
		parent_id: Uuid.optional().meta({
			description: 'List forward items whose parent is this cell.',
		}),
		child_id: Uuid.optional().meta({
			description: 'List reverse parents whose child is this cell.',
		}),
		position_after: CellItemPosition.optional().meta({
			description: 'Cursor for forward pagination — return rows whose position > this.',
		}),
		limit: z.number().int().positive().max(500).optional().meta({
			description:
				'Page size cap (max 500). Omit for unbounded — explicit list calls escape the bundled `cell_get` cap.',
		}),
		acting: ActingActor,
	})
	.refine((v) => Boolean(v.parent_id) !== Boolean(v.child_id), {
		message: ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD,
	});
export type CellItemListInput = z.infer<typeof CellItemListInput>;

export const CellItemListOutput = z.strictObject({
	items: z.array(ItemJson),
});
export type CellItemListOutput = z.infer<typeof CellItemListOutput>;

// -- Action specs -----------------------------------------------------------

export const cell_item_insert_action_spec = {
	method: 'cell_item_insert',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellItemInsertInput,
	output: CellItemInsertOutput,
	async: true,
	description:
		'Insert a cell as an ordered child at `position` under `parent`. Caller must be able to edit `parent` and view `child`. Returns `cell_item_position_taken` on `(parent_id, position)` unique violation; client refreshes bracket and retries.',
} satisfies RequestResponseActionSpec;

export const cell_item_move_action_spec = {
	method: 'cell_item_move',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellItemMoveInput,
	output: CellItemMoveOutput,
	async: true,
	description:
		'Move an item within its parent to a new position. Caller must be able to edit `parent`. Returns `cell_item_position_taken` on the new-position unique violation.',
} satisfies RequestResponseActionSpec;

export const cell_item_delete_action_spec = {
	method: 'cell_item_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellItemDeleteInput,
	output: CellItemDeleteOutput,
	async: true,
	description:
		'Delete the item at `(parent, position)`. Idempotent — `deleted: false` when no row matched. Caller must be able to edit `parent`.',
} satisfies RequestResponseActionSpec;

export const cell_item_list_action_spec = {
	method: 'cell_item_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'optional', actor: 'optional'},
	side_effects: false,
	input: CellItemListInput,
	output: CellItemListOutput,
	async: true,
	rate_limit: 'ip',
	description:
		'List forward items (pass `parent_id`) or reverse parents (pass `child_id`). Forward listing filters children to those the caller may view (strict target-visibility). Reverse listing has 2-layer authz: gate on `can_view_cell(child)` first (404 otherwise), then filter rows by per-parent `can_view_cell`. Per-IP rate-limited — symmetric with `cell_get` to bound public-surface id-walking.',
} satisfies RequestResponseActionSpec;

/** All cell_item action specs — composed into `all_cell_action_specs`. */
export const all_cell_item_action_specs = [
	cell_item_insert_action_spec,
	cell_item_move_action_spec,
	cell_item_delete_action_spec,
	cell_item_list_action_spec,
] as const;
