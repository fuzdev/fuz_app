/**
 * Generic cell-data base schema.
 *
 * The wire-side shape every cell consumer can read without per-kind
 * knowledge: a permissive bag with three universally-relevant typed
 * fields. Per-kind schemas extend this and narrow `kind` to a literal.
 *
 * Loose object: arbitrary additional fields pass through unvalidated,
 * preserving the "unknown kinds ship without RPC churn" property. Per-kind
 * shape enforcement is opt-in via the `validate_data` deps slot — see
 * `auth/cell_actions.ts`.
 *
 * **Discipline**: a field joins `CellData` only when at least two
 * consumers in different domains read it generically. `label` (list/index
 * rendering) and `summary` (card subtitle + share-target description) meet
 * this bar. Future candidates require evidence of generic usage — otherwise
 * they stay per-kind.
 *
 * **`kind` is not in here, and is rejected if present.** Like `visibility`,
 * a cell's `kind` is a top-level column (`cell.kind` on `CellJson` /
 * `CellRow`), not content metadata — it is the capability / identity axis a
 * creation authorizer gates on, write-once at birth. A stray `kind` key
 * inside `data` is a fail-loud `ERROR_CELL_KIND_IN_DATA` at the create /
 * update / clone-patch boundary (single source of truth). Access control
 * (`cell.visibility`) is likewise a peer column, enforced by `can_view_cell`
 * reading the column directly (no JSON dive).
 *
 * @module
 */

import {z} from 'zod';

/**
 * Base cell-data shape. All fields optional; loose mode admits arbitrary
 * additional keys so apps can attach metadata or stage new kinds without
 * touching the wire schema. `kind` lives on the top-level `cell.kind`
 * column, not here (see the module doc).
 */
export const CellData = z.looseObject({
	label: z.string().optional(),
	summary: z.string().optional(),
});
export type CellData = z.infer<typeof CellData>;
