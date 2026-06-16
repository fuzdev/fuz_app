/**
 * Audit-log metadata schemas for the cell layer's mutation events.
 *
 * Apps register these via `extra_events:` on `create_audit_log_config`
 * alongside any app-defined event types.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';

/**
 * Shared metadata envelope for cell mutations. `kind` and `path` are
 * captured at emit-time so the audit-log viewer can show useful context
 * for soft-deleted rows even after the cell snapshot is gone. Relation
 * membership is tracked independently via the `cell_item_*` /
 * `cell_field_*` per-row audit events.
 *
 * Loose object: per-kind handlers may extend the metadata without spec
 * churn.
 */
export const CellAuditMetadata = z.looseObject({
	cell_id: Uuid,
	kind: z.string().optional(),
	path: z.string().nullable().optional(),
});
export type CellAuditMetadata = z.infer<typeof CellAuditMetadata>;

/**
 * Metadata envelope for `cell_clone`.
 *
 * `source_id` and `new_id` capture the parent → clone edge. `deep` flags
 * whether children were walked. `item_count` reports the number of
 * children actually cloned (post-skip). `kind` is captured at emit-time so
 * an operator can filter the audit log by source shape (e.g., "every
 * collection clone").
 *
 * No skipped-child count is recorded: surfacing how many children the
 * caller couldn't view would leak the source's hidden-child count to the
 * cloner (who owns — and can audit — the clone). Non-viewable children are
 * dropped silently (D8).
 */
export const CellCloneAuditMetadata = z.looseObject({
	source_id: Uuid,
	new_id: Uuid,
	deep: z.boolean(),
	item_count: z.number().int().nonnegative(),
	kind: z.string().optional(),
});
export type CellCloneAuditMetadata = z.infer<typeof CellCloneAuditMetadata>;
