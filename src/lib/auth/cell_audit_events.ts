/**
 * Canonical cell-layer audit event registry.
 *
 * Maps every cell-domain `event_type` a cell handler emits to its
 * metadata schema. Consumers register the whole bundle in one shot via
 * `create_audit_log_config({extra_events: {...cell_audit_events, ...}})`
 * so the cell handlers' `deps.audit.emit(...)` calls validate against the
 * extended registry. Spreading lets an app fold its own event types in
 * alongside.
 *
 * Aggregator module by design — not a compat shim. The per-event metadata
 * schemas live in their own files (`auth/cell_audit_metadata.ts`,
 * `auth/cell_grant_audit_metadata.ts`, `auth/cell_field_audit_metadata.ts`,
 * `auth/cell_item_audit_metadata.ts`); this module is the single registration
 * surface that keeps the keys in lockstep with the handlers.
 *
 * @module
 */

import type {z} from 'zod';

import {CellAuditMetadata, CellCloneAuditMetadata} from './cell_audit_metadata.ts';
import {
	CellGrantCreateAuditMetadata,
	CellGrantRevokeAuditMetadata,
} from './cell_grant_audit_metadata.ts';
import {
	CellFieldSetAuditMetadata,
	CellFieldDeleteAuditMetadata,
} from './cell_field_audit_metadata.ts';
import {
	CellItemInsertAuditMetadata,
	CellItemMoveAuditMetadata,
	CellItemDeleteAuditMetadata,
} from './cell_item_audit_metadata.ts';

/**
 * Cell-layer `event_type → metadata schema` map for `extra_events`.
 *
 * Covers the six generic cell verbs' mutation events plus the grant /
 * field / item relation events. Read-only verbs (`cell_get`, `cell_list`,
 * `cell_*_list`, `cell_audit_list`) emit nothing and are absent here.
 */
export const cell_audit_events: Readonly<Record<string, z.ZodType>> = {
	cell_create: CellAuditMetadata,
	cell_update: CellAuditMetadata,
	cell_delete: CellAuditMetadata,
	cell_clone: CellCloneAuditMetadata,
	cell_grant_create: CellGrantCreateAuditMetadata,
	cell_grant_revoke: CellGrantRevokeAuditMetadata,
	cell_field_set: CellFieldSetAuditMetadata,
	cell_field_delete: CellFieldDeleteAuditMetadata,
	cell_item_insert: CellItemInsertAuditMetadata,
	cell_item_move: CellItemMoveAuditMetadata,
	cell_item_delete: CellItemDeleteAuditMetadata,
};
