/**
 * Cell-grant ACL RPC handlers.
 *
 * Three `request_response` actions bound to specs in
 * `auth/cell_grant_action_specs.ts`:
 *
 * Grant management is **manage-tier only** (`can_manage_cell` = admin /
 * owner). Editor-grant holders may edit a cell's content + relations but
 * cannot manage its grants — delegating the share list would let an editor
 * widen access or mint peer editors and escape the manager's authority.
 *
 * - `cell_grant_create` — admin / owner only. Refuses a cell whose
 *   `moderation` doesn't admit an audience (403 `cell_grant_unapproved`,
 *   after the manage gate). Validates role-shaped
 *   principals against the role schema; rejects owner-as-principal.
 *   Actor-shaped principals carry a pre-resolved `actor_id` (callers pick
 *   via `actor_search`). Idempotent — re-granting the same principal
 *   updates `level` via UPSERT. A mounted `authorize_grant_create` is asked
 *   after the spine's own gates, before the owner check and the write (403
 *   `cell_grant_not_authorized` on refusal).
 * - `cell_grant_revoke` — admin / owner, plus self for actor-shaped grants
 *   ("leave shared cell"), plus — when `authorize_grant_revoke` is mounted —
 *   the steward of a scoped role-shaped grant's scope. Returns
 *   `still_admitted` computed by re-running `can_view_cell` against the
 *   remaining grants.
 * - `cell_grant_list` — admin / owner only. Viewers and editors alike get
 *   the IDOR-mask 404 (the share list is the manager's to curate).
 *
 * Every miss and every authority denial is a 404 mask, as in
 * `auth/cell_actions.ts`: `cell_grant_create` and `cell_grant_list` answer
 * `cell_not_found` for a missing cell and a non-manager alike;
 * `cell_grant_revoke` answers `cell_grant_not_found` for a missing grant, a
 * grant whose cell is gone, and a caller with no authority to revoke it.
 *
 * Audit events `cell_grant_create` / `cell_grant_revoke` carry IDs only
 * (no display-name snapshots); see `auth/cell_grant_audit_metadata.ts`.
 *
 * @module
 */

import {
	rpc_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction
} from '../actions/action_types.ts';
import { jsonrpc_errors } from '../http/jsonrpc_errors.ts';
import type { RoleSchemaResult } from './role_schema.ts';
import type { ActionFactoryDeps } from './deps.ts';
import type { RequestActorContext } from './request_context.ts';
import type { Uuid } from '../primitive_schemas.ts';

import {
	cell_grant_create_action_spec,
	cell_grant_revoke_action_spec,
	cell_grant_list_action_spec,
	ERROR_CELL_GRANT_NOT_AUTHORIZED,
	ERROR_CELL_GRANT_NOT_FOUND,
	ERROR_CELL_GRANT_PRINCIPAL_IS_OWNER,
	ERROR_CELL_GRANT_UNAPPROVED,
	ERROR_CELL_GRANT_UNKNOWN_ROLE,
	type CellGrantCreateInput,
	type CellGrantCreateOutput,
	type CellGrantRevokeInput,
	type CellGrantRevokeOutput,
	type CellGrantListInput,
	type CellGrantListOutput,
	type CellGrantLevel,
	type GrantJson
} from './cell_grant_action_specs.ts';
import { emit_cell_audit, require_manageable_cell } from './cell_action_helpers.ts';
import { can_view_cell, can_manage_cell } from './cell_authorize.ts';
import { query_cell_get, type CellRow } from '../db/cell_queries.ts';
import { cell_moderation_admits_audience } from '../db/cell_moderation.ts';
import {
	query_cell_grant_create,
	query_cell_grant_get,
	query_cell_grant_delete,
	query_cell_grant_list_for_cell,
	type CellGrantRow,
	type CellGrantPrincipalQueryInput
} from '../db/cell_grant_queries.ts';
import type {
	CellGrantCreateAuditMetadata,
	CellGrantRevokeAuditMetadata,
	CellGrantPrincipalAuditMetadata
} from './cell_grant_audit_metadata.ts';

/**
 * Input to a `CellGrantCreateAuthorize` callback — the twin of the Rust
 * `CellGrantCreateAuthorizeInput`.
 */
export interface CellGrantCreateAuthorizeInput {
	/** The cell the grant names. */
	cell_id: Uuid;
	/** The cell's owner (`null` = a system cell). */
	cell_created_by: Uuid | null;
	/** The level the grant confers — on an upsert, the new level. */
	level: CellGrantCreateInput['level'];
	/** Who the grant admits: an actor, or a role at an optional scope. */
	principal: CellGrantPrincipalQueryInput;
}

/**
 * Opt-in gate on `cell_grant_create` — the TS twin of the Rust
 * `CellGrantCreateAuthorize` trait. Asked after the spine's own gates — the
 * manage tier (a non-manager gets the 404 mask and never reaches it), the
 * moderation admission, and the role registry — and before the owner check
 * and the write, for a new grant and a level change alike. `false` refuses
 * with 403 `ERROR_CELL_GRANT_NOT_AUTHORIZED`, writing neither the grant nor an
 * audit row. A consumer narrows sharing with it (say, role-shaped grants only
 * to roles of the cell's own space); it can't widen it, as every caller it
 * sees already manages the cell. Omitted = no gate past the spine's.
 *
 * `ctx` is the request's: `cell_grant_create` has side effects, so `ctx.db` is
 * the request transaction, and a callback needing the database (a
 * scope-existence check, say) reads through it. **Read-only** — the callback
 * decides, it never writes; a write would commit or roll back with the grant,
 * and nothing enforces this but the callback.
 */
export type CellGrantCreateAuthorize = (
	auth: RequestActorContext,
	input: CellGrantCreateAuthorizeInput,
	ctx: ActionContext
) => boolean | Promise<boolean>;

/**
 * Input to a `CellGrantRevokeAuthorize` callback — the twin of the Rust
 * `CellGrantRevokeAuthorizeInput`. Only a role-shaped grant with a scope
 * reaches the callback, so `role` and `scope_id` are always present.
 */
export interface CellGrantRevokeAuthorizeInput {
	/** The grant being revoked. */
	grant_id: Uuid;
	/** The cell the grant names. */
	cell_id: Uuid;
	/** The cell's owner (`null` = a system cell). */
	cell_created_by: Uuid | null;
	/** The role the grant admits. */
	role: string;
	/** The scope the grant is bound to — the scope whose steward the callback decides on. */
	scope_id: Uuid;
	/** The level the grant confers. */
	level: CellGrantLevel;
}

/**
 * Opt-in widening of `cell_grant_revoke` to a scope's steward — the TS twin of
 * the Rust `CellGrantRevokeAuthorize` trait.
 *
 * The role-shaped twin of self-revoke: an actor-shaped grant's grantee may
 * leave a cell, and for a role-shaped grant the grantee is the scope, so the
 * scope's steward speaks for it (say, a teacher removing a cell shared into
 * their classroom). The consumer decides what stewards a scope. The input
 * carries the grant's role so a consumer whose scopes are stewarded only for
 * certain roles can refuse the rest.
 *
 * Deliberately fenced. The spine asks it only when the caller neither manages
 * the cell nor holds the grant (self-revoke), and only for a role-shaped grant
 * with a non-null `scope_id` — an actor-shaped grant or a scopeless role grant
 * never reaches it, and a soft-deleted cell 404s first. `true` revokes as a
 * manager would — same delete, `still_admitted`, and `cell_grant_revoke` audit
 * row, its metadata stamped `steward: true`; `false` answers the same 404
 * `ERROR_CELL_GRANT_NOT_FOUND` mask as every other non-qualifying caller (not a
 * 403 — the caller mustn't learn the grant exists); a throw is a hard error —
 * it is not masked, so refuse with `false`, never a throw.
 * Omitted = revoke is the manager's and the self-revoker's alone.
 *
 * The grant it decides on is the grant revoked: the delete matches the grant's
 * `level` as the callback saw it, so a level change landing between the read
 * and the delete answers the 404 mask rather than revoking a grant the
 * callback never judged. `ctx.db` is the request transaction
 * (`cell_grant_revoke` has side effects), read through like
 * `CellGrantCreateAuthorize`'s, and read-only like it.
 */
export type CellGrantRevokeAuthorize = (
	auth: RequestActorContext,
	input: CellGrantRevokeAuthorizeInput,
	ctx: ActionContext
) => boolean | Promise<boolean>;

/**
 * Dependencies for `create_cell_grant_actions`.
 *
 * `roles` is the role schema — read for the role-validity gate on
 * `cell_grant_create`; `authorize_grant_create` is the optional consumer gate
 * (`CellGrantCreateAuthorize`) and `authorize_grant_revoke` the optional
 * steward widening of `cell_grant_revoke` (`CellGrantRevokeAuthorize`). The
 * other slots match `CellActionDeps` so audit-log emit goes through the same
 * fire-and-forget plumbing.
 */
export type CellGrantActionDeps = ActionFactoryDeps & {
	roles: RoleSchemaResult;
	authorize_grant_create?: CellGrantCreateAuthorize;
	authorize_grant_revoke?: CellGrantRevokeAuthorize;
};

export const to_grant_json = (row: CellGrantRow): GrantJson => ({
	id: row.id,
	cell_id: row.cell_id,
	level: row.level,
	actor_id: row.actor_id,
	role: row.role,
	scope_id: row.scope_id,
	granted_by: row.granted_by,
	created_at: row.created_at
});

/**
 * Build the audit-metadata principal envelope from a `cell_grant` row.
 * Picks the actor-shape branch when `actor_id IS NOT NULL`,
 * otherwise the role-shape branch. The CHECK constraint guarantees
 * exactly one of the two holds.
 */
const principal_from_row = (row: CellGrantRow): CellGrantPrincipalAuditMetadata =>
	row.actor_id !== null ? { actor_id: row.actor_id } : { role: row.role!, scope_id: row.scope_id };

/**
 * Map the wire-input principal to the query-input shape. Both arms pass
 * through unchanged — the wire and query shapes are aligned (pickers run
 * `actor_search` upstream and submit the resolved id).
 */
const to_query_principal = (
	principal: CellGrantCreateInput['principal']
): CellGrantPrincipalQueryInput => {
	if (principal.kind === 'actor') {
		return { kind: 'actor', actor_id: principal.actor_id };
	}
	return {
		kind: 'role',
		role: principal.role,
		scope_id: principal.scope_id ?? null
	};
};

/**
 * Reject the create when the principal actor is the cell's owner.
 * Skipped for role-shaped principals (a role isn't a single actor) and
 * for system cells (`created_by IS NULL`). With actor-grain principals
 * the comparison is direct — `cell.created_by` is already an actor id.
 */
const assert_principal_is_not_owner = (
	cell: CellRow,
	principal: CellGrantPrincipalQueryInput
): void => {
	if (principal.kind !== 'actor') return;
	if (cell.created_by === null) return;
	if (cell.created_by === principal.actor_id) {
		throw jsonrpc_errors.invalid_params('grant principal is the cell owner', {
			reason: ERROR_CELL_GRANT_PRINCIPAL_IS_OWNER
		});
	}
};

/**
 * Whether the mounted `CellGrantRevokeAuthorize` admits `auth` as the steward
 * of `grant`'s scope — `false` with no callback, for an actor-shaped grant,
 * and for a scopeless role grant, none of which reach it.
 */
const steward_admits_revoke = async (
	auth: RequestActorContext,
	grant: CellGrantRow,
	cell: CellRow,
	authorize: CellGrantRevokeAuthorize | undefined,
	ctx: ActionContext
): Promise<boolean> => {
	if (!authorize) return false;
	if (grant.actor_id !== null || grant.role === null || grant.scope_id === null) return false;
	return authorize(
		auth,
		{
			grant_id: grant.id,
			cell_id: grant.cell_id,
			cell_created_by: cell.created_by,
			role: grant.role,
			scope_id: grant.scope_id,
			level: grant.level
		},
		ctx
	);
};

/** Create the three `cell_grant_*` RPC actions. */
export const create_cell_grant_actions = (deps: CellGrantActionDeps): Array<RpcAction> => {
	const { roles, authorize_grant_create, authorize_grant_revoke } = deps;

	const create_handler = async (
		input: CellGrantCreateInput,
		ctx: ActionActorContext
	): Promise<CellGrantCreateOutput> => {
		const auth = ctx.auth;
		// Grant management is manage-tier only (admin / owner). Editor-grant
		// holders may edit the cell's content + relations but cannot mint
		// grants of any level — delegating the share list would let editors
		// widen access (or mint peer editors) and escape the manager's
		// authority. A miss and a non-manager both get the IDOR-mask 404, so
		// probing for cells via the share endpoint is no easier than via
		// cell_get.
		const cell = await require_manageable_cell(ctx, auth, input.cell_id);
		// A grant extends a cell's audience, and a contribution whose moderation
		// doesn't admit one (pending, rejected, or an unknown marker) has none past
		// its author and admins — `can_view_cell`'s grant arm wouldn't admit on it —
		// so refuse the grant rather than mint a row that would wake up on
		// approval. After the manage gate, so a non-manager keeps the 404 mask; no
		// admin exemption.
		if (!cell_moderation_admits_audience(cell.moderation)) {
			throw jsonrpc_errors.forbidden('cell_grant_create requires an unmoderated or approved cell', {
				reason: ERROR_CELL_GRANT_UNAPPROVED
			});
		}
		const principal = to_query_principal(input.principal);
		// Role validity — only relevant for role-shaped principals; reject
		// before insert so dead grant rows nothing can match are foreclosed.
		if (principal.kind === 'role' && !roles.role_specs.has(principal.role)) {
			throw jsonrpc_errors.invalid_params(`unknown role "${principal.role}"`, {
				reason: ERROR_CELL_GRANT_UNKNOWN_ROLE
			});
		}
		// The consumer's gate, asked only of a manager past the spine's gates;
		// a refusal writes nothing.
		if (authorize_grant_create) {
			const allowed = await authorize_grant_create(
				auth,
				{
					cell_id: cell.id,
					cell_created_by: cell.created_by,
					level: input.level,
					principal
				},
				ctx
			);
			if (!allowed) {
				throw jsonrpc_errors.forbidden('cell grant is not permitted here', {
					reason: ERROR_CELL_GRANT_NOT_AUTHORIZED
				});
			}
		}
		assert_principal_is_not_owner(cell, principal);
		const row = await query_cell_grant_create(ctx, {
			cell_id: cell.id,
			level: input.level,
			principal,
			granted_by: auth.actor.id
		});
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_grant_create', {
			cell_id: row.cell_id,
			grant_id: row.id,
			level: row.level,
			principal: principal_from_row(row)
		} satisfies CellGrantCreateAuditMetadata);
		return { grant: to_grant_json(row) };
	};

	const revoke_handler = async (
		input: CellGrantRevokeInput,
		ctx: ActionActorContext
	): Promise<CellGrantRevokeOutput> => {
		const auth = ctx.auth;
		const grant = await query_cell_grant_get(ctx, input.grant_id);
		if (!grant) {
			throw jsonrpc_errors.not_found('cell grant', { reason: ERROR_CELL_GRANT_NOT_FOUND });
		}
		const cell = await query_cell_get(ctx, grant.cell_id);
		if (!cell) {
			// Grant exists but its cell is gone (soft-deleted out from under
			// it). Treat as a grant miss for the IDOR mask.
			throw jsonrpc_errors.not_found('cell grant', { reason: ERROR_CELL_GRANT_NOT_FOUND });
		}
		const is_manager = can_manage_cell(auth, cell);
		// "Is the grant being revoked the caller's own actor-shaped grant?"
		// Self-revoke is the leave-shared-cell affordance — open regardless of
		// authority path. Owner-with-self-grant can't happen
		// (`assert_principal_is_not_owner` blocks it at create time).
		const is_self_actor_grant = grant.actor_id !== null && grant.actor_id === auth.actor.id;
		// The steward of a scoped role grant's scope, asked only of a caller with
		// neither of the above — so a manager or self-revoker never consults it.
		const is_steward =
			!is_manager &&
			!is_self_actor_grant &&
			(await steward_admits_revoke(auth, grant, cell, authorize_grant_revoke, ctx));
		// Grant management is manage-tier only (admin / owner); editor-grant
		// holders cannot revoke grants (mirrors the create gate). The
		// exceptions are self-revoke and a scope's steward. Non-qualifying
		// callers get the IDOR mask.
		if (!is_manager && !is_self_actor_grant && !is_steward) {
			throw jsonrpc_errors.not_found('cell grant', { reason: ERROR_CELL_GRANT_NOT_FOUND });
		}
		// A steward's admission was decided on the grant's level, so its delete
		// matches that level: a level change landing in between deletes nothing.
		const deleted = await query_cell_grant_delete(
			ctx,
			grant.id,
			is_steward ? grant.level : undefined
		);
		if (!deleted) {
			// Raced with another revoker, or (a steward's) with a level change.
			// Same shape as cell_actions.ts — 404 covers the gap.
			throw jsonrpc_errors.not_found('cell grant', { reason: ERROR_CELL_GRANT_NOT_FOUND });
		}
		// Recompute admit state against the remaining grants. Always true for
		// a manager's revoke; a self-revoker or a steward may have admitted
		// through nothing else, so the recompute is uniform shape — let
		// `can_view_cell` decide.
		const remaining = await query_cell_grant_list_for_cell(ctx, cell.id);
		const still_admitted = can_view_cell(auth, cell, remaining);
		const audit_metadata: CellGrantRevokeAuditMetadata = {
			cell_id: deleted.cell_id,
			grant_id: deleted.id,
			level: deleted.level,
			principal: principal_from_row(deleted),
			...(is_self_actor_grant ? { self: true as const } : {}),
			...(is_steward ? { steward: true as const } : {})
		};
		await emit_cell_audit(ctx, deps.audit, auth, 'cell_grant_revoke', audit_metadata);
		return { ok: true, still_admitted };
	};

	const list_handler = async (
		input: CellGrantListInput,
		ctx: ActionActorContext
	): Promise<CellGrantListOutput> => {
		const auth = ctx.auth;
		// Same authz gate as create — manage tier only (admin / owner). The
		// share list is the manager's to curate; viewers and editors alike
		// fall through to the IDOR-mask 404.
		const cell = await require_manageable_cell(ctx, auth, input.cell_id);
		const grants = await query_cell_grant_list_for_cell(ctx, cell.id);
		return { grants: grants.map(to_grant_json) };
	};

	return [
		rpc_action(cell_grant_create_action_spec, create_handler),
		rpc_action(cell_grant_revoke_action_spec, revoke_handler),
		rpc_action(cell_grant_list_action_spec, list_handler)
	];
};
