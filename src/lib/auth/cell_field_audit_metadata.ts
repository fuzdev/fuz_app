/**
 * Audit-log metadata schemas for `cell_field_set` / `cell_field_delete`.
 *
 * IDs only — same discipline as the cell + cell_grant envelopes (audit
 * logs store references, not denormalized strings). Apps register these
 * via `extra_events:` on `create_audit_log_config`.
 *
 * @module
 */

import { loose_object, string, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { Uuid } from '../primitive_schemas_fuz.ts';

/**
 * Metadata envelope for `cell_field_set`. Emitted on every successful
 * create OR update path (UPSERT on `(source_id, name)`); the audit
 * reader correlates create-vs-update via repeated `(source_id, name)`
 * if needed.
 */
export const CellFieldSetAuditMetadata = loose_object({
	source_id: Uuid,
	name: string,
	target_id: Uuid
});
export type CellFieldSetAuditMetadata = Infer<typeof CellFieldSetAuditMetadata>;

/** Metadata envelope for `cell_field_delete`. */
export const CellFieldDeleteAuditMetadata = loose_object({
	source_id: Uuid,
	name: string,
	target_id: Uuid
});
export type CellFieldDeleteAuditMetadata = Infer<typeof CellFieldDeleteAuditMetadata>;
