/**
 * Cell-grant ACL RPC specs — declarative contract for the three
 * `cell_grant_*` verbs (`create`, `revoke`, `list`).
 *
 * The grant primitive is a resource-side ACL: each row admits a
 * principal (actor or role+scope) at a level (viewer / editor) on a
 * single cell. Owner is implicit on `cell.created_by` and never appears
 * in the grant list.
 *
 * Principal is `{actor_id}` or `{role, scope_id?}` — no name resolver on
 * this verb. Callers pick an actor by id via `actor_search` (debounced
 * prefix search) and submit the resolved id directly.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';

import {ActingActor} from '../http/auth_shape.ts';
import type {RequestResponseActionSpec} from '../actions/action_spec.ts';

// -- Error reasons ----------------------------------------------------------

/** Error reason — grant id did not resolve, or caller may not see it. */
export const ERROR_CELL_GRANT_NOT_FOUND = 'cell_grant_not_found' as const;

/**
 * Error reason — `cell_grant_create` principal resolves to the cell's
 * owner. Owner access is implicit (`cell.created_by`); a self-grant
 * row would shadow it without changing access and create a confusing
 * self-leave path.
 */
export const ERROR_CELL_GRANT_PRINCIPAL_IS_OWNER = 'cell_grant_principal_is_owner' as const;

/**
 * Error reason — role-shaped principal references a role string not
 * registered in the role schema. Would produce a dead grant row that
 * no role_grant could match.
 */
export const ERROR_CELL_GRANT_UNKNOWN_ROLE = 'cell_grant_unknown_role' as const;

// -- Shared schemas ---------------------------------------------------------

/** Grant level — view-only or view-plus-edit. */
export const CellGrantLevel = z.enum(['viewer', 'editor']);
export type CellGrantLevel = z.infer<typeof CellGrantLevel>;

/**
 * Wire-input principal. Discriminated by `kind`. Actor-shaped principals
 * carry a resolved `actor_id` — the picker UI runs `actor_search` to
 * convert a typed name to an id before this verb is called.
 */
export const CellGrantPrincipalInput = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('actor'),
		actor_id: Uuid,
	}),
	z.strictObject({
		kind: z.literal('role'),
		role: z.string().min(1),
		scope_id: Uuid.nullish().meta({
			description: '`null` / omitted = any-scope grant (admits any matching-role role_grant).',
		}),
	}),
]);
export type CellGrantPrincipalInput = z.infer<typeof CellGrantPrincipalInput>;

/**
 * Wire-format for a cell_grant row. Mirrors `CellJson`'s shape — ISO-string
 * `created_at`, branded UUIDs, principal columns surfaced as-is. Caller
 * inspects `actor_id` xor `role` to render the right principal label.
 */
export const GrantJson = z.strictObject({
	id: Uuid,
	cell_id: Uuid,
	level: CellGrantLevel,
	actor_id: Uuid.nullable(),
	role: z.string().nullable(),
	scope_id: Uuid.nullable(),
	granted_by: Uuid.nullable(),
	created_at: z.string(),
});
export type GrantJson = z.infer<typeof GrantJson>;

// -- cell_grant_create ------------------------------------------------------

/**
 * Input for `cell_grant_create`. Idempotent on the unique index —
 * re-granting the same `(cell_id, principal)` pair updates `level` +
 * `granted_by` rather than producing a duplicate row.
 */
export const CellGrantCreateInput = z.strictObject({
	cell_id: Uuid.meta({description: 'Cell to grant access on.'}),
	level: CellGrantLevel.meta({description: 'Grant level: `viewer` or `editor`.'}),
	principal: CellGrantPrincipalInput.meta({
		description: 'Subject of the grant. Discriminated by `kind`.',
	}),
	acting: ActingActor,
});
export type CellGrantCreateInput = z.infer<typeof CellGrantCreateInput>;

export const CellGrantCreateOutput = z.strictObject({grant: GrantJson});
export type CellGrantCreateOutput = z.infer<typeof CellGrantCreateOutput>;

// -- cell_grant_revoke ------------------------------------------------------

export const CellGrantRevokeInput = z.strictObject({
	grant_id: Uuid.meta({description: 'Grant to revoke.'}),
	acting: ActingActor,
});
export type CellGrantRevokeInput = z.infer<typeof CellGrantRevokeInput>;

/**
 * Output for `cell_grant_revoke`. `still_admitted` is `true` when the
 * caller retains some admit path on the cell after the revoke (other
 * grant, ownership, admin). Always `true` for non-self revokes (the
 * caller didn't admit via this row to begin with).
 */
export const CellGrantRevokeOutput = z.strictObject({
	ok: z.literal(true),
	still_admitted: z.boolean(),
});
export type CellGrantRevokeOutput = z.infer<typeof CellGrantRevokeOutput>;

// -- cell_grant_list --------------------------------------------------------

export const CellGrantListInput = z.strictObject({
	cell_id: Uuid.meta({description: 'Cell whose grants to list.'}),
	acting: ActingActor,
});
export type CellGrantListInput = z.infer<typeof CellGrantListInput>;

export const CellGrantListOutput = z.strictObject({
	grants: z.array(GrantJson),
});
export type CellGrantListOutput = z.infer<typeof CellGrantListOutput>;

// -- Action specs -----------------------------------------------------------

export const cell_grant_create_action_spec = {
	method: 'cell_grant_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellGrantCreateInput,
	output: CellGrantCreateOutput,
	async: true,
	description:
		'Grant view or edit access on a cell. Manage-tier only (admin / owner) — editor-grant holders cannot manage grants. Idempotent on `(cell_id, principal)`. Owner-as-principal rejected. Actor-shaped principals carry a pre-resolved `actor_id` (callers pick via `actor_search`); no name resolver on this verb.',
} satisfies RequestResponseActionSpec;

export const cell_grant_revoke_action_spec = {
	method: 'cell_grant_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: CellGrantRevokeInput,
	output: CellGrantRevokeOutput,
	async: true,
	description:
		'Revoke a grant. Manage-tier only (admin / owner), plus self for actor-shaped grants ("leave shared cell"). Returns `still_admitted` so the UI can tell the recipient whether other admit paths remain.',
} satisfies RequestResponseActionSpec;

export const cell_grant_list_action_spec = {
	method: 'cell_grant_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: false,
	input: CellGrantListInput,
	output: CellGrantListOutput,
	async: true,
	description:
		"List grants on a cell. Manage-tier only (admin / owner); viewers and editors get IDOR-mask 404 (the share list is the manager's to curate).",
} satisfies RequestResponseActionSpec;

/** All cell_grant action specs — composed into `all_cell_action_specs`. */
export const all_cell_grant_action_specs = [
	cell_grant_create_action_spec,
	cell_grant_revoke_action_spec,
	cell_grant_list_action_spec,
] as const;
