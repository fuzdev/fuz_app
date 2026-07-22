/**
 * Cell-field RPC specs — declarative contract for the three named-relation
 * verbs (`set` / `delete` / `list`).
 *
 * `(source_id, name) → target_id` edges modeled after JSON object
 * key/value pairs. One target per `(source_id, name)` pair: re-setting a
 * name overwrites the prior target. `cell_field_list` is bidirectional:
 * pass `source_id` for forward fields, `target_id` for reverse upfields
 * (the latter has 2-layer authz — see handler).
 *
 * @module
 */

import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { ActingActor } from '../http/auth_shape.ts';
import type { RequestResponseActionSpec } from '../actions/action_spec.ts';

// -- Error reasons ----------------------------------------------------------

/** Error reason — `cell_field_list` got neither `source_id` nor `target_id`. */
export const ERROR_CELL_FIELD_LIST_REQUIRES_SOURCE_OR_TARGET =
	'cell_field_list_requires_source_or_target' as const;

// -- Shared schemas ---------------------------------------------------------

/**
 * Field name grammar — fuz snake_case identifier convention. Anchored
 * `^[a-z][a-z0-9_]{0,63}$`: leading letter, alphanumeric + underscore
 * trailing, 64-char cap. No reserved names yet.
 */
export const CELL_FIELD_NAME_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
export const CellFieldName = z.string().regex(CELL_FIELD_NAME_REGEX).brand('CellFieldName');
export type CellFieldName = z.infer<typeof CellFieldName>;

/** Wire-format for a `cell_field` row. ISO `created_at`, branded UUIDs. */
export const FieldJson = z.strictObject({
	source_id: Uuid,
	name: z.string(),
	target_id: Uuid,
	created_at: z.string()
});
export type FieldJson = z.infer<typeof FieldJson>;

// -- cell_field_set ---------------------------------------------------------

/**
 * Input for `cell_field_set`. UPSERT on `(source_id, name)` — re-issuing
 * the same input updates `target_id` and bumps `created_at`.
 */
export const CellFieldSetInput = z.strictObject({
	source_id: Uuid.meta({ description: 'Cell whose field to set.' }),
	name: CellFieldName.meta({
		description: 'Field name. snake_case identifier; max 64 chars.'
	}),
	target_id: Uuid.meta({ description: 'Cell the field points at.' }),
	acting: ActingActor
});
export type CellFieldSetInput = z.infer<typeof CellFieldSetInput>;

export const CellFieldSetOutput = z.strictObject({ field: FieldJson });
export type CellFieldSetOutput = z.infer<typeof CellFieldSetOutput>;

// -- cell_field_delete ------------------------------------------------------

/**
 * Input for `cell_field_delete`. Idempotent: a successful response is
 * returned even when no row matched.
 */
export const CellFieldDeleteInput = z.strictObject({
	source_id: Uuid.meta({ description: 'Cell whose field to delete.' }),
	name: CellFieldName.meta({ description: 'Field name to delete.' }),
	acting: ActingActor
});
export type CellFieldDeleteInput = z.infer<typeof CellFieldDeleteInput>;

export const CellFieldDeleteOutput = z.strictObject({
	ok: z.literal(true),
	deleted: z.boolean()
});
export type CellFieldDeleteOutput = z.infer<typeof CellFieldDeleteOutput>;

// -- cell_field_list --------------------------------------------------------

/**
 * Input for `cell_field_list`. Pass `source_id` for forward fields or
 * `target_id` for reverse upfields — exactly one (the schema rejects
 * both / neither). Reverse listing has 2-layer authz (target view-check
 * gates the call; per-source view-check filters the rows).
 *
 * Forward listing supports cursor pagination via `name_after` (return
 * rows whose `name > name_after` lex). The reverse listing doesn't
 * paginate (the result set is small in practice — number of sources
 * pointing at a given target).
 */
export const CellFieldListInput = z
	.strictObject({
		source_id: Uuid.optional().meta({
			description: 'List forward fields whose source is this cell.'
		}),
		target_id: Uuid.optional().meta({
			description: 'List reverse upfields whose target is this cell.'
		}),
		name_after: CellFieldName.optional().meta({
			description:
				'Cursor for forward pagination — return rows whose name > this lex. Forward only.'
		}),
		limit: z.number().int().positive().max(500).optional().meta({
			description:
				'Page size cap (max 500). Forward only. Omit for unbounded — explicit list calls escape the bundled `cell_get` cap.'
		}),
		acting: ActingActor
	})
	.refine((v) => Boolean(v.source_id) !== Boolean(v.target_id), {
		message: ERROR_CELL_FIELD_LIST_REQUIRES_SOURCE_OR_TARGET
	});
export type CellFieldListInput = z.infer<typeof CellFieldListInput>;

export const CellFieldListOutput = z.strictObject({
	fields: z.array(FieldJson)
});
export type CellFieldListOutput = z.infer<typeof CellFieldListOutput>;

// -- Action specs -----------------------------------------------------------

export const cell_field_set_action_spec = {
	method: 'cell_field_set',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: true,
	input: CellFieldSetInput,
	output: CellFieldSetOutput,
	async: true,
	description:
		'Set a named relation `(source.name) → target`. UPSERT on `(source_id, name)`: re-pointing replaces in place. Caller must be able to edit `source` and view `target`; both gate via `can_edit_cell` / `can_view_cell`.'
} satisfies RequestResponseActionSpec;

export const cell_field_delete_action_spec = {
	method: 'cell_field_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: true,
	input: CellFieldDeleteInput,
	output: CellFieldDeleteOutput,
	async: true,
	description:
		'Delete a named relation. Idempotent — `deleted: false` when no row matched. Caller must be able to edit `source`.'
} satisfies RequestResponseActionSpec;

export const cell_field_list_action_spec = {
	method: 'cell_field_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'optional', actor: 'optional' },
	side_effects: false,
	input: CellFieldListInput,
	output: CellFieldListOutput,
	async: true,
	rate_limit: 'ip',
	description:
		'List forward fields (pass `source_id`) or reverse upfields (pass `target_id`). Forward listing filters targets to those the caller may view (strict target-visibility). Reverse listing has 2-layer authz: gate on `can_view_cell(target)` first (404 otherwise), then filter rows by per-source `can_view_cell`. Per-IP rate-limited — symmetric with `cell_get` to bound public-surface id-walking.'
} satisfies RequestResponseActionSpec;

/** All cell_field action specs — composed into `all_cell_action_specs`. */
export const all_cell_field_action_specs = [
	cell_field_set_action_spec,
	cell_field_delete_action_spec,
	cell_field_list_action_spec
] as const;
