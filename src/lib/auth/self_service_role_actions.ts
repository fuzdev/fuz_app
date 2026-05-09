/**
 * Unified self-service role toggle RPC action.
 *
 * One static `request_response` action — `self_service_role_set` — that
 * takes `{role, enabled}` and toggles a global permit on the caller for an
 * allowlisted role. Idempotent in both directions: re-enabling an
 * already-held role returns `changed: false`; disabling a role the caller
 * doesn't hold returns `changed: false`.
 *
 * Eligibility is derived by default from `RoleSpec.grant_paths` —
 * every role whose `grant_paths` includes `'self_service'`
 * (`GRANT_PATH_SELF_SERVICE`) is eligible. The factory accepts an
 * optional `eligible_roles` override (validated against the supplied
 * `roles.role_specs` at factory time so typos surface at startup
 * instead of at first call) for deployments that want to lock the
 * surface down further than the role spec declares. Roles outside
 * the eligible set are rejected with `forbidden` + reason
 * `role_not_self_service_eligible`.
 *
 * Audit metadata carries `self_service: true` so admin reviewers can
 * distinguish self-toggled permits from admin grants/offers. The
 * `permit_grant` / `permit_revoke` metadata schemas declare
 * `self_service: z.boolean().optional()` explicitly, so the field is
 * part of the documented schema surface and is round-trip-validated by
 * `query_audit_log`.
 *
 * Static method name — `role` lives in the input, not the method name —
 * so the spec is codegen-compatible (`satisfies RequestResponseActionSpec`)
 * and the surface stays constant as consumers add eligible roles. Mirrors
 * the existing `permit_offer_create({role})` precedent rather than
 * generating per-role methods.
 *
 * Specs and schemas live in `auth/self_service_role_action_specs.ts` so
 * client-side codegen can import the surface without dragging in the
 * query layer.
 *
 * @module
 */

import {rpc_actor_action, type ActionActorContext, type RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {
	BUILTIN_ROLE_SPECS_BY_NAME,
	list_roles_with_grant_path,
	type RoleSchemaResult,
} from './role_schema.js';
import {GRANT_PATH_SELF_SERVICE} from './grant_path_schema.js';
import type {AuditEmitDeps} from './deps.js';
import {query_grant_permit, query_revoke_permit} from './permit_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import {is_permit_active} from './account_schema.js';
import {has_scoped_role} from './request_context.js';
import {
	ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE,
	self_service_role_set_action_spec,
	type SelfServiceRoleSetInput,
	type SelfServiceRoleSetOutput,
} from './self_service_role_action_specs.js';

/** Options for `create_self_service_role_actions`. */
export interface SelfServiceRoleActionsOptions {
	/**
	 * Optional override allowlist of role strings eligible for
	 * self-service. When omitted, eligibility is derived from
	 * `roles.role_specs` (or `BUILTIN_ROLE_SPECS_BY_NAME` when `roles`
	 * is also omitted) by selecting every role whose
	 * `RoleSpec.grant_paths` includes `'self_service'`. Pass an empty
	 * array to lock the surface down (every call comes back as
	 * `forbidden` with reason `role_not_self_service_eligible`).
	 *
	 * When supplied alongside `roles`, every entry is checked against
	 * `roles.role_specs` at factory time so typos throw at startup.
	 */
	eligible_roles?: ReadonlyArray<string>;
	/**
	 * Optional role schema. Drives default eligibility derivation from
	 * `RoleSpec.grant_paths` and validates the `eligible_roles` override
	 * (when supplied) against the registered role set.
	 */
	roles?: RoleSchemaResult;
}

/**
 * Dependencies for `create_self_service_role_actions`.
 *
 * Aliases the shared `AuditEmitDeps` so consumers thread one deps object
 * through every action factory. `audit_log_config` is consumed by
 * `audit_log_fire_and_forget`.
 */
export type SelfServiceRoleActionDeps = AuditEmitDeps;

/**
 * Build the unified self-service role toggle RPC action.
 *
 * @param deps - `SelfServiceRoleActionDeps` slice of `AppDeps` (`log`, `on_audit_event`, optional `audit_log_config`)
 * @param options - optional eligible-role override plus optional role schema for default-eligibility derivation
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 * @throws Error at factory time if any `eligible_roles` entry is missing from `options.roles.role_specs`
 */
export const create_self_service_role_actions = (
	deps: SelfServiceRoleActionDeps,
	options: SelfServiceRoleActionsOptions = {},
): Array<RpcAction> => {
	const role_specs = options.roles?.role_specs ?? BUILTIN_ROLE_SPECS_BY_NAME;

	const eligible: ReadonlySet<string> = options.eligible_roles
		? new Set(options.eligible_roles)
		: new Set(list_roles_with_grant_path(role_specs, GRANT_PATH_SELF_SERVICE));

	if (options.eligible_roles && options.roles) {
		for (const r of eligible) {
			if (!role_specs.has(r)) {
				throw new Error(
					`create_self_service_role_actions: eligible_roles entry "${r}" is not registered in roles.role_specs — typo or missing call to create_role_schema`,
				);
			}
		}
	}

	const reject_if_ineligible = (role: string): void => {
		if (!eligible.has(role)) {
			throw jsonrpc_errors.forbidden('role not eligible for self-service', {
				reason: ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE,
			});
		}
	};

	const handler = async (
		input: SelfServiceRoleSetInput,
		ctx: ActionActorContext,
	): Promise<SelfServiceRoleSetOutput> => {
		const auth = ctx.auth;
		reject_if_ineligible(input.role);

		if (input.enabled) {
			// Pre-check for idempotent re-grant. `query_grant_permit` is itself
			// idempotent (returns the existing permit instead of inserting), but
			// it doesn't signal "already existed" vs "newly inserted" — so we
			// peek first. Reads from the in-memory `auth.permits` snapshot
			// (no DB roundtrip). The TOCTOU window is benign for self-service:
			// two concurrent grants both observe "no permit", both call
			// `query_grant_permit`, and one collapses onto the other inside the
			// query's `ON CONFLICT DO NOTHING`. Worst case both responses report
			// `changed: true`; the DB still ends up with exactly one permit.
			if (has_scoped_role(auth, input.role, null)) {
				return {ok: true, enabled: true, changed: false};
			}

			const permit = await query_grant_permit(ctx, {
				actor_id: auth.actor.id,
				role: input.role,
				scope_id: null,
				expires_at: null,
				granted_by: auth.actor.id,
			});

			// `permit_grant` is the canonical actor-bound-subject event —
			// populate both target columns even on self-service so the
			// "always populated for permit_grant" rule holds uniformly
			// regardless of who initiated the grant. On self-service the
			// grantor and grantee are the same identity; admin direct-grant
			// (separate code path) populates the same columns with the
			// grantee actor.
			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'permit_grant',
					actor_id: auth.actor.id,
					account_id: auth.account.id,
					target_account_id: auth.account.id,
					target_actor_id: auth.actor.id,
					ip: ctx.client_ip,
					metadata: {
						role: permit.role,
						permit_id: permit.id,
						scope_id: permit.scope_id,
						self_service: true,
					},
				},
				deps,
			);

			return {ok: true, enabled: true, changed: true};
		}

		// Find an active global permit for this (actor, role) in the in-memory
		// `auth.permits` snapshot. No DB roundtrip — same correctness-equivalent
		// pattern as `has_scoped_role` above (race window is between predicate
		// and `query_revoke_permit`'s actual UPDATE, not between predicate and
		// middleware load).
		const now = new Date();
		const target = auth.permits.find(
			(p) => p.role === input.role && p.scope_id === null && is_permit_active(p, now),
		);
		if (!target) {
			return {ok: true, enabled: false, changed: false};
		}

		const result = await query_revoke_permit(ctx, target.id, auth.actor.id, auth.actor.id);
		if (!result) {
			// Raced with another revoker — treat as already revoked.
			return {ok: true, enabled: false, changed: false};
		}

		// Same actor-bound rule as the grant branch — `permit_revoke`
		// always populates both target columns even on self-service so
		// forensic queries that filter on `target_actor_id IS NOT NULL`
		// don't silently miss self-toggled permits.
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_revoke',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: auth.account.id,
				target_actor_id: auth.actor.id,
				ip: ctx.client_ip,
				metadata: {
					role: result.role,
					permit_id: result.id,
					scope_id: result.scope_id,
					self_service: true,
				},
			},
			deps,
		);

		return {ok: true, enabled: false, changed: true};
	};

	return [rpc_actor_action(self_service_role_set_action_spec, handler)];
};
