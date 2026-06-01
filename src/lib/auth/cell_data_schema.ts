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
 * consumers in different domains read it generically. `kind` (editor
 * dispatch + sub-API registry), `label` (list/index rendering), and
 * `summary` (card subtitle + share-target description) meet this bar.
 * Future candidates require evidence of generic usage — otherwise they
 * stay per-kind.
 *
 * **Visibility is not in here.** Access control is a peer of `cell_grant`,
 * not content metadata — `cell.visibility` lives as a top-level column on
 * `CellJson` and `CellRow` (the `CellVisibility` enum is defined in
 * `auth/cell_action_specs.ts` next to the wire fields that use it), and is
 * enforced by `can_view_cell` reading the column directly (no JSON dive).
 *
 * @module
 */

import {z} from 'zod';

/**
 * Base cell-data shape. All fields optional; loose mode admits arbitrary
 * additional keys so apps can attach metadata or stage new kinds without
 * touching the wire schema.
 *
 * `kind` is optional because cells without a registered kind are valid —
 * admin-curated content, in-development types, or unknown shapes pass
 * through. Known kinds get richer validation via the per-kind sub-API.
 */
export const CellData = z.looseObject({
	kind: z.string().optional(),
	label: z.string().optional(),
	summary: z.string().optional(),
});
export type CellData = z.infer<typeof CellData>;
