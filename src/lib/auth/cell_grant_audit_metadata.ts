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

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';

/**
 * Principal columns as stored on `cell_grant`. Discriminated by which
 * keys are present: `{actor_id}` for an actor-shaped grant,
 * `{role, scope_id}` for a role-shaped grant. Actor-shaped grants
 * carry only the id; names are never persisted in the audit envelope.
 */
export const CellGrantPrincipalAuditMetadata = z.union([
	z.looseObject({actor_id: Uuid}),
	z.looseObject({role: z.string(), scope_id: Uuid.nullable()}),
]);
export type CellGrantPrincipalAuditMetadata = z.infer<typeof CellGrantPrincipalAuditMetadata>;

/**
 * Metadata envelope for `cell_grant_create`.
 *
 * Emitted on every successful create OR re-share update path
 * (UPSERT-on-unique-index). The audit reader correlates create-vs-update
 * via `grant_id` if needed; the design doesn't require distinguishing
 * the two at the metadata level.
 */
export const CellGrantCreateAuditMetadata = z.looseObject({
	cell_id: Uuid,
	grant_id: Uuid,
	level: z.enum(['viewer', 'editor']),
	principal: CellGrantPrincipalAuditMetadata,
});
export type CellGrantCreateAuditMetadata = z.infer<typeof CellGrantCreateAuditMetadata>;

/**
 * Metadata envelope for `cell_grant_revoke`.
 *
 * `self: true` distinguishes the recipient-side "leave shared cell"
 * path (actor-shaped grant where the principal actor === caller
 * actor) from a delegator-side revoke. Single event type for both
 * — the boolean is enough for forensic review and avoids surface-
 * doubling with a parallel `cell_grant_leave` event.
 */
export const CellGrantRevokeAuditMetadata = z.looseObject({
	cell_id: Uuid,
	grant_id: Uuid,
	level: z.enum(['viewer', 'editor']),
	principal: CellGrantPrincipalAuditMetadata,
	self: z.literal(true).optional(),
});
export type CellGrantRevokeAuditMetadata = z.infer<typeof CellGrantRevokeAuditMetadata>;
