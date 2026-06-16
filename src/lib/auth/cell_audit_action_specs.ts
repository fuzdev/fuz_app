/**
 * `cell_audit_list` RPC — per-cell audit timeline.
 *
 * Returns audit-log rows whose metadata names this cell on any of the
 * `(cell_id, source_id, parent_id, child_id, target_id, new_id)` keys
 * used by the cell-domain event types. The handler 404-masks for
 * callers who are not in the cell's manage tier (`can_manage_cell` =
 * admin / owner) — the timeline reveals who-touched-the-cell, so it is
 * gated above `can_view_cell`.
 *
 * Read-only; no audit side effect. Returns the most-recent
 * `CELL_AUDIT_LIST_DEFAULT_LIMIT` events; pagination is intentionally
 * not on the wire yet — the only consumer renders a single page. Add
 * `{before, limit}` input + `{next_before}` output together when a
 * paginating consumer surfaces.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';

import type {RequestResponseActionSpec} from '../actions/action_spec.ts';
import {ActingActor} from '../http/auth_shape.ts';

/**
 * Wire shape for a single cell-audit row. Narrower than
 * `AuditLogEventJson` — `account_id` and `target_account_id` are
 * deliberately omitted so this verb does NOT surface the actor↔account
 * join. `target_actor_id` and `metadata` are dropped too: `target_actor_id`
 * is NULL for every cell-domain event (the grant recipient lives inside
 * `metadata.principal` on grant rows, not on the audit-log top-level
 * field); `metadata` is unread by the timeline UI.
 *
 * `ip` is also omitted: it is PII about the actors who touched the cell,
 * and even at the manage tier this per-cell timeline has no need for it
 * (admins reach the full `audit_log` surface, which carries `ip`, through
 * the admin audit verbs). Keeping it off this wire avoids leaking
 * collaborators' IPs to a cell's owner.
 *
 * All omitted fields can be re-added under a richer admin-only
 * event-detail view later — keep the wire surface honest about what
 * consumers use.
 */
export const CellAuditEventJson = z.strictObject({
	id: Uuid,
	seq: z.number(),
	event_type: z.string(),
	outcome: z.enum(['success', 'failure']),
	actor_id: Uuid.nullable(),
	created_at: z.string(),
});
export type CellAuditEventJson = z.infer<typeof CellAuditEventJson>;

/** Page size for `cell_audit_list`. Single page at MVP; no cursor wire. */
export const CELL_AUDIT_LIST_DEFAULT_LIMIT = 50;

export const CellAuditListInput = z.strictObject({
	cell_id: Uuid.meta({description: 'Cell whose audit trail to fetch.'}),
	acting: ActingActor,
});
export type CellAuditListInput = z.infer<typeof CellAuditListInput>;

export const CellAuditListOutput = z.strictObject({
	events: z.array(CellAuditEventJson),
});
export type CellAuditListOutput = z.infer<typeof CellAuditListOutput>;

export const cell_audit_list_action_spec = {
	method: 'cell_audit_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: false,
	input: CellAuditListInput,
	output: CellAuditListOutput,
	async: true,
	description:
		'List the most-recent audit events referencing the cell on any of `cell_id`, `source_id`, `parent_id`, `child_id`, `target_id`, or `new_id` metadata keys. Manage-tier only (admin / owner) — the timeline reveals who touched the cell, so viewers and editors get the IDOR-mask 404. 404 on miss or unauthorized — same shape as `cell_get` so private-cell existence does not leak.',
} satisfies RequestResponseActionSpec;

/** Registry export to compose into `all_cell_action_specs`. */
export const all_cell_audit_action_specs = [cell_audit_list_action_spec] as const;
