/**
 * Audit-log metadata schemas for the `cell_grant` ACL events.
 *
 * IDs only — no display-name snapshots. By convention audit logs store
 * references, not denormalized strings; viewer tooling resolves
 * `actor_id` → `actor.name`, `scope_id` → scope name, etc. at read time.
 *
 * Apps register these via `extra_events:` on `create_audit_log_config`
 * alongside the other cell metadata schemas.
 *
 * @module
 */

import {
	literal,
	loose_object,
	nullable,
	optional,
	string,
	union,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { Uuid } from '../primitive_schemas.ts';
import { CellGrantLevel } from './cell_grant_action_specs.ts';

/**
 * Principal columns as stored on `cell_grant`. Discriminated by which
 * keys are present: `{actor_id}` for an actor-shaped grant,
 * `{role, scope_id}` for a role-shaped grant. Actor-shaped grants
 * carry only the id; names are never persisted in the audit envelope.
 */
export const CellGrantPrincipalAuditMetadata = union([
	loose_object({ actor_id: Uuid }),
	loose_object({ role: string, scope_id: nullable(Uuid) })
]);
export type CellGrantPrincipalAuditMetadata = Infer<typeof CellGrantPrincipalAuditMetadata>;

/**
 * Metadata envelope for `cell_grant_create`.
 *
 * Emitted on every successful create OR re-share update path
 * (UPSERT-on-unique-index). The audit reader correlates create-vs-update
 * via `grant_id` if needed; the design doesn't require distinguishing
 * the two at the metadata level.
 */
export const CellGrantCreateAuditMetadata = loose_object({
	cell_id: Uuid,
	grant_id: Uuid,
	level: CellGrantLevel,
	principal: CellGrantPrincipalAuditMetadata
});
export type CellGrantCreateAuditMetadata = Infer<typeof CellGrantCreateAuditMetadata>;

/**
 * Metadata envelope for `cell_grant_revoke`.
 *
 * `self: true` distinguishes the recipient-side "leave shared cell"
 * path (actor-shaped grant where the principal actor === caller
 * actor) from a delegator-side revoke, and `steward: true` a scope
 * steward's revoke of a scoped role-shaped grant, admitted by the
 * consumer's `CellGrantRevokeAuthorize`. Single event type for all
 * three — the boolean is enough for forensic review and avoids
 * surface-doubling with parallel events.
 */
export const CellGrantRevokeAuditMetadata = loose_object({
	cell_id: Uuid,
	grant_id: Uuid,
	level: CellGrantLevel,
	principal: CellGrantPrincipalAuditMetadata,
	self: optional(literal(true)),
	steward: optional(literal(true))
});
export type CellGrantRevokeAuditMetadata = Infer<typeof CellGrantRevokeAuditMetadata>;
