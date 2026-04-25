/**
 * Self-service role grant/revoke action specs — schemas, error reasons,
 * and the codegen-ready registry.
 *
 * Client-safe: no query-layer or audit-write imports. Handler factory
 * lives in `self_service_role_actions.ts`.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {RoleName} from './role_schema.js';

/** Error reason — caller asked to self-toggle a role outside the configured allowlist. */
export const ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE = 'role_not_self_service_eligible' as const;

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
