/**
 * Audit-log metadata schemas for the cell layer's mutation events.
 *
 * Apps register these via `extra_events:` on `create_audit_log_config`
 * alongside any app-defined event types.
 *
 * @module
 */

import {
	boolean,
	loose_object,
	min_value,
	nullable,
	number,
	optional,
	pipe,
	record,
	safe_integer,
	string,
	unknown,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { Uuid } from '../primitive_schemas_fuz.ts';
import { CellModerationDecision } from './cell_action_specs.ts';

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
export const CellAuditMetadata = loose_object({
	cell_id: Uuid,
	kind: optional(string),
	path: optional(string)
});
export type CellAuditMetadata = Infer<typeof CellAuditMetadata>;

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
export const CellCloneAuditMetadata = loose_object({
	source_id: Uuid,
	new_id: Uuid,
	deep: boolean,
	item_count: pipe(number, safe_integer, min_value(0)),
	kind: optional(string)
});
export type CellCloneAuditMetadata = Infer<typeof CellCloneAuditMetadata>;

/**
 * Metadata envelope for `cell_moderate`. `cell_id` is the moderated
 * contribution; `root_id` is its governing root (the container whose
 * moderation authority gated the call); `moderation` is the terminal decision
 * applied (`'approved'` | `'rejected'`).
 */
export const CellModerateAuditMetadata = loose_object({
	cell_id: Uuid,
	root_id: Uuid,
	moderation: CellModerationDecision
});
export type CellModerateAuditMetadata = Infer<typeof CellModerateAuditMetadata>;

/**
 * Metadata envelope for `cell_policy_set`. `cell_id` is the root; `policy` is
 * the policy written (`null` when cleared) and `previous_policy` the one it
 * replaced, so the audit trail carries every policy a root has had.
 */
export const CellPolicySetAuditMetadata = loose_object({
	cell_id: Uuid,
	policy: nullable(record(unknown)),
	previous_policy: nullable(record(unknown))
});
export type CellPolicySetAuditMetadata = Infer<typeof CellPolicySetAuditMetadata>;
