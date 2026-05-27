/**
 * Audit-log metadata schemas for `cell_item_insert` / `_move` / `_delete`.
 *
 * IDs only (positions are opaque text, not user-derived; safe to log).
 * Apps register these via `extra_events:` on `create_audit_log_config`.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

/** Metadata envelope for `cell_item_insert`. */
export const CellItemInsertAuditMetadata = z.looseObject({
	parent_id: Uuid,
	position: z.string(),
	child_id: Uuid,
});
export type CellItemInsertAuditMetadata = z.infer<typeof CellItemInsertAuditMetadata>;

/**
 * Metadata envelope for `cell_item_move`. Carries both old and new
 * position so the audit trail shows the reorder without a join back to
 * the live row.
 */
export const CellItemMoveAuditMetadata = z.looseObject({
	parent_id: Uuid,
	position_old: z.string(),
	position_new: z.string(),
});
export type CellItemMoveAuditMetadata = z.infer<typeof CellItemMoveAuditMetadata>;

/** Metadata envelope for `cell_item_delete`. */
export const CellItemDeleteAuditMetadata = z.looseObject({
	parent_id: Uuid,
	position: z.string(),
	child_id: Uuid,
});
export type CellItemDeleteAuditMetadata = z.infer<typeof CellItemDeleteAuditMetadata>;
