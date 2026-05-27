/**
 * Audit-log metadata schemas for `cell_field_set` / `cell_field_delete`.
 *
 * IDs only — same discipline as the cell + cell_grant envelopes (audit
 * logs store references, not denormalized strings). Apps register these
 * via `extra_events:` on `create_audit_log_config`.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

/**
 * Metadata envelope for `cell_field_set`. Emitted on every successful
 * create OR update path (UPSERT on `(source_id, name)`); the audit
 * reader correlates create-vs-update via repeated `(source_id, name)`
 * if needed.
 */
export const CellFieldSetAuditMetadata = z.looseObject({
	source_id: Uuid,
	name: z.string(),
	target_id: Uuid,
});
export type CellFieldSetAuditMetadata = z.infer<typeof CellFieldSetAuditMetadata>;

/** Metadata envelope for `cell_field_delete`. */
export const CellFieldDeleteAuditMetadata = z.looseObject({
	source_id: Uuid,
	name: z.string(),
	target_id: Uuid,
});
export type CellFieldDeleteAuditMetadata = z.infer<typeof CellFieldDeleteAuditMetadata>;
