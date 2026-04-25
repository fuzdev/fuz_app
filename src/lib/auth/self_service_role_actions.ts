/**
 * Self-service role grant/revoke RPC actions.
 *
 * Two static `request_response` actions — `self_service_role_grant` and
 * `self_service_role_revoke` — that take `{role}` as input and toggle a
 * permit on the caller for an allowlisted role. Idempotent in both
 * directions: re-granting an already-held role returns `granted: false`;
 * revoking a role the caller doesn't hold returns `revoked: false`.
 *
 * The factory takes an `eligible_roles` allowlist (validated against the
 * supplied `roles.role_options` at factory time so typos surface at startup
 * instead of at first call). Roles outside the allowlist are rejected
 * with `forbidden` + reason `role_not_self_service_eligible`.
 *
 * Audit metadata carries `self_service: true` so admin reviewers can
 * distinguish self-toggled permits from admin grants/offers. The
 * `permit_grant` / `permit_revoke` metadata schemas declare
 * `self_service: z.boolean().optional()` explicitly, so the field is
 * part of the documented schema surface and is round-trip-validated by
 * `query_audit_log`.
 *
 * Static method names — `role` lives in the input, not the method name —
 * so specs are codegen-compatible (`satisfies RequestResponseActionSpec`)
 * and the surface stays constant as consumers add eligible roles. Mirrors
 * the existing `permit_offer_create({role})` precedent rather than
 * generating per-role methods.
 *
 * @module
 */

import {z} from 'zod';

import {rpc_action, type ActionContext, type RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {Uuid} from '../uuid.js';
import {RoleName, type RoleSchemaResult} from './role_schema.js';
import type {RouteFactoryDeps} from './deps.js';
import {
	query_grant_permit,
	query_permit_find_active_for_actor,
	query_permit_has_role,
	query_revoke_permit,
} from './permit_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {RequestContext} from './request_context.js';

/** Error reason — caller asked to self-toggle a role outside the configured allowlist. */
export const ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE = 'role_not_self_service_eligible' as const;

// -- Input/output schemas ---------------------------------------------------

/** Input for `self_service_role_grant`. */
export const SelfServiceRoleGrantInput = z.strictObject({
	role: RoleName.meta({description: 'Role to self-grant. Must be in the configured allowlist.'}),
});
export type SelfServiceRoleGrantInput = z.infer<typeof SelfServiceRoleGrantInput>;

/**
 * Output for `self_service_role_grant`. `granted` is `false` on idempotent
 * re-grant (caller already held the role globally); `permit_id` is set on
 * new grants only.
 */
export const SelfServiceRoleGrantOutput = z.strictObject({
	ok: z.literal(true),
	granted: z.boolean(),
	permit_id: Uuid.optional(),
});
export type SelfServiceRoleGrantOutput = z.infer<typeof SelfServiceRoleGrantOutput>;

/** Input for `self_service_role_revoke`. */
export const SelfServiceRoleRevokeInput = z.strictObject({
	role: RoleName.meta({description: 'Role to self-revoke. Must be in the configured allowlist.'}),
});
export type SelfServiceRoleRevokeInput = z.infer<typeof SelfServiceRoleRevokeInput>;

/**
 * Output for `self_service_role_revoke`. `revoked` is `false` when the
 * caller held no active global permit for the role (idempotent).
 */
export const SelfServiceRoleRevokeOutput = z.strictObject({
	ok: z.literal(true),
	revoked: z.boolean(),
});
export type SelfServiceRoleRevokeOutput = z.infer<typeof SelfServiceRoleRevokeOutput>;

// -- Action specs -----------------------------------------------------------

export const self_service_role_grant_action_spec = {
	method: 'self_service_role_grant',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: SelfServiceRoleGrantInput,
	output: SelfServiceRoleGrantOutput,
	async: true,
	description:
		'Self-grant an active permit for an allowlisted role. Idempotent — already-granted callers receive `granted: false`.',
} satisfies RequestResponseActionSpec;

export const self_service_role_revoke_action_spec = {
	method: 'self_service_role_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: SelfServiceRoleRevokeInput,
	output: SelfServiceRoleRevokeOutput,
	async: true,
	description:
		'Self-revoke an active global permit for an allowlisted role. Idempotent — callers without an active permit receive `revoked: false`.',
} satisfies RequestResponseActionSpec;

/**
 * All self-service role action specs — a codegen-ready registry. Method
 * names are static, so consumer typed-client codegen picks them up the
 * same way it picks up `account_*_action_specs`.
 */
export const all_self_service_role_action_specs: Array<RequestResponseActionSpec> = [
	self_service_role_grant_action_spec,
	self_service_role_revoke_action_spec,
];

// -- Factory ----------------------------------------------------------------

/** Options for `create_self_service_role_actions`. */
export interface SelfServiceRoleActionsOptions {
	/**
	 * Allowlist of role strings eligible for self-service. Empty array
	 * effectively disables the surface — every call comes back as
	 * `forbidden` with reason `role_not_self_service_eligible`.
	 */
	eligible_roles: ReadonlyArray<string>;
	/**
	 * Optional role schema. When supplied, `eligible_roles` entries are
	 * checked against `roles.role_options` at factory time so typos throw
	 * at startup instead of at first call.
	 */
	roles?: RoleSchemaResult;
}

/**
 * Dependencies for `create_self_service_role_actions`. Same shape as the
 * peer factories so consumers thread one deps object through all three.
 * `audit_log_config` flows from `AppDeps` and is consumed by
 * `audit_log_fire_and_forget`.
 */
export type SelfServiceRoleActionDeps = Pick<
	RouteFactoryDeps,
	'log' | 'on_audit_event' | 'audit_log_config'
>;

const require_request_auth = (auth: RequestContext | null): RequestContext => {
	if (!auth) throw new Error('unreachable: action auth guard did not enforce authentication');
	return auth;
};

/**
 * Build the self-service role grant/revoke RPC actions.
 *
 * @param deps - `SelfServiceRoleActionDeps` slice of `AppDeps` (`log`, `on_audit_event`, optional `audit_log_config`)
 * @param options - eligible-role allowlist plus optional role schema for typo-checking
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_self_service_role_actions = (
	deps: SelfServiceRoleActionDeps,
	options: SelfServiceRoleActionsOptions,
): Array<RpcAction> => {
	const eligible: ReadonlySet<string> = new Set(options.eligible_roles);

	if (options.roles) {
		const role_options = options.roles.role_options;
		for (const r of eligible) {
			if (!role_options.has(r)) {
				throw new Error(
					`create_self_service_role_actions: eligible_roles entry "${r}" is not registered in roles.role_options — typo or missing call to create_role_schema`,
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

	const grant_handler = async (
		input: SelfServiceRoleGrantInput,
		ctx: ActionContext,
	): Promise<SelfServiceRoleGrantOutput> => {
		const auth = require_request_auth(ctx.auth);
		reject_if_ineligible(input.role);

		// Pre-check for idempotent re-grant. `query_grant_permit` is itself
		// idempotent (returns the existing permit instead of inserting), but
		// it doesn't signal "already existed" vs "newly inserted" — so we
		// peek first. The TOCTOU window is benign for self-service: two
		// concurrent grants both observe "no permit", both call
		// `query_grant_permit`, and one collapses onto the other inside the
		// query's `ON CONFLICT DO NOTHING`. Worst case both responses report
		// `granted: true`; the DB still ends up with exactly one permit.
		const already = await query_permit_has_role(ctx, auth.actor.id, input.role);
		if (already) {
			return {ok: true, granted: false};
		}

		const permit = await query_grant_permit(ctx, {
			actor_id: auth.actor.id,
			role: input.role,
			scope_id: null,
			expires_at: null,
			granted_by: auth.actor.id,
		});

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_grant',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
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

		return {ok: true, granted: true, permit_id: permit.id};
	};

	const revoke_handler = async (
		input: SelfServiceRoleRevokeInput,
		ctx: ActionContext,
	): Promise<SelfServiceRoleRevokeOutput> => {
		const auth = require_request_auth(ctx.auth);
		reject_if_ineligible(input.role);

		// Find an active global permit for this (actor, role). No dedicated
		// query exists, but `query_permit_find_active_for_actor` returns the
		// short list of every active permit and we filter in JS — fewer
		// round-trips than a new helper for a one-call-per-revoke path.
		const active = await query_permit_find_active_for_actor(ctx, auth.actor.id);
		const target = active.find((p) => p.role === input.role && p.scope_id === null);
		if (!target) {
			return {ok: true, revoked: false};
		}

		const result = await query_revoke_permit(ctx, target.id, auth.actor.id, auth.actor.id);
		if (!result) {
			// Raced with another revoker — treat as already revoked.
			return {ok: true, revoked: false};
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_revoke',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
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

		return {ok: true, revoked: true};
	};

	return [
		rpc_action(self_service_role_grant_action_spec, grant_handler),
		rpc_action(self_service_role_revoke_action_spec, revoke_handler),
	];
};
