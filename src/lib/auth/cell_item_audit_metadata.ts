/**
 * Audit-log metadata schemas for `cell_item_insert` / `_move` / `_delete`.
 *
 * IDs only (positions are opaque text, not user-derived; safe to log).
 * Apps register these via `extra_events:` on `create_audit_log_config`.
 *
 * @module
 */

import { loose_object, string, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { Uuid } from '../primitive_schemas.ts';

/** Metadata envelope for `cell_item_insert`. */
export const CellItemInsertAuditMetadata = loose_object({
	parent_id: Uuid,
	position: string,
	child_id: Uuid
});
export type CellItemInsertAuditMetadata = Infer<typeof CellItemInsertAuditMetadata>;

/**
 * Metadata envelope for `cell_item_move`. Carries both old and new
 * position so the audit trail shows the reorder without a join back to
 * the live row.
 */
export const CellItemMoveAuditMetadata = loose_object({
	parent_id: Uuid,
	position_old: string,
	position_new: string
});
export type CellItemMoveAuditMetadata = Infer<typeof CellItemMoveAuditMetadata>;

/** Metadata envelope for `cell_item_delete`. */
export const CellItemDeleteAuditMetadata = loose_object({
	parent_id: Uuid,
	position: string,
	child_id: Uuid
});
export type CellItemDeleteAuditMetadata = Infer<typeof CellItemDeleteAuditMetadata>;
