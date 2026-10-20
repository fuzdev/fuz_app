/**
 * The `cell.moderation` read rules, in pure and SQL form side by side.
 *
 * `moderation` is free `TEXT` with no CHECK, so each rule is an allowlist over
 * the literals: a marker this module doesn't name (a typo, a future state)
 * admits nothing.
 *
 * **Audience admission** — `cell_moderation_admits_audience` and
 * `cell_moderation_admits_audience_sql`: unmoderated (`null`) or `'approved'`.
 * A cell's effective audience is its visibility (or grants) **and** its
 * admission, so the public and grant read arms of `can_view_cell` require it,
 * as do the `editor` grant arm of `can_edit_cell` and the matching arms of
 * `query_cell_list` (general and `shared_with` shapes). The owner and
 * global-admin arms don't: an author keeps reading and editing their own
 * pending or rejected contribution, and an admin reads everything.
 *
 * **Stewardship** — `cell_moderation_is_stewardable` and
 * `cell_moderation_is_stewardable_sql`: exactly `'pending'` or `'rejected'`, the
 * states in which the governing root's manager reads a contribution its
 * audience can't (`can_steward_cell`). An unknown marker is neither admitted
 * nor stewardable, so only its owner and admins read it.
 *
 * The pure and SQL forms are written once each here, next to each other, over
 * the same literal constants; every predicate and query composes them rather
 * than restating the rule. Twin of the Rust `fuz_cell::cell_moderation`.
 *
 * @module
 */

/** `cell.moderation` for a gated contribution awaiting a decision. */
export const CELL_MODERATION_PENDING = 'pending';

/** `cell.moderation` for an approved contribution. */
export const CELL_MODERATION_APPROVED = 'approved';

/** `cell.moderation` for a rejected contribution. */
export const CELL_MODERATION_REJECTED = 'rejected';

/**
 * Whether a cell's `moderation` marker admits it to an audience beyond its
 * owner — unmoderated (`null`) or `'approved'`; `'pending'`, `'rejected'`, and
 * any unknown marker do not.
 *
 * @param moderation - the cell's `moderation` column
 * @returns whether the public and grant read arms may admit the cell
 */
export const cell_moderation_admits_audience = (moderation: string | null): boolean =>
	moderation === null || moderation === CELL_MODERATION_APPROVED;

/**
 * SQL form of `cell_moderation_admits_audience` over the cell alias `alias`
 * (a parenthesized boolean expression).
 *
 * @param alias - the `cell` table alias in the enclosing query
 * @returns the SQL predicate
 */
export const cell_moderation_admits_audience_sql = (alias: string): string =>
	`(${alias}.moderation IS NULL OR ${alias}.moderation = '${CELL_MODERATION_APPROVED}')`;

/**
 * Whether a cell's `moderation` marker is one its governing root's manager
 * stewards — exactly `'pending'` or `'rejected'`.
 *
 * @param moderation - the cell's `moderation` column
 * @returns whether the steward read arm may admit the cell
 */
export const cell_moderation_is_stewardable = (moderation: string | null): boolean =>
	moderation === CELL_MODERATION_PENDING || moderation === CELL_MODERATION_REJECTED;

/**
 * SQL form of `cell_moderation_is_stewardable` over the cell alias `alias`.
 *
 * @param alias - the `cell` table alias in the enclosing query
 * @returns the SQL predicate
 */
export const cell_moderation_is_stewardable_sql = (alias: string): string =>
	`${alias}.moderation IN ('${CELL_MODERATION_PENDING}', '${CELL_MODERATION_REJECTED}')`;
