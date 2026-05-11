/**
 * Unified self-service role toggle action spec — schemas, error reasons,
 * and the codegen-ready registry.
 *
 * Client-safe: no query-layer or audit-write imports. Handler factory
 * lives in `auth/self_service_role_actions.ts`.
 *
 * @module
 */

import {z} from 'zod';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {RoleName} from './role_schema.js';
import {ActingActor} from '../http/auth_shape.js';

/** Error reason — caller asked to self-toggle a role outside the configured allowlist. */
export const ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE = 'role_not_self_service_eligible' as const;

/** Input for `self_service_role_set`. */
export const SelfServiceRoleSetInput = z.strictObject({
	role: RoleName.meta({description: 'Role to toggle. Must be in the configured allowlist.'}),
	enabled: z.boolean().meta({
		description:
			'Desired post-call state. `true` grants if not held; `false` revokes if held. Idempotent in both directions.',
	}),
	acting: ActingActor,
});
export type SelfServiceRoleSetInput = z.infer<typeof SelfServiceRoleSetInput>;

/**
 * Output for `self_service_role_set`. `enabled` echoes the post-call state
 * (always equals the input `enabled` on success). `changed` is `true` only
 * when the call mutated — re-grants / re-revokes return `false`.
 */
export const SelfServiceRoleSetOutput = z.strictObject({
	ok: z.literal(true),
	enabled: z.boolean(),
	changed: z.boolean(),
});
export type SelfServiceRoleSetOutput = z.infer<typeof SelfServiceRoleSetOutput>;

export const self_service_role_set_action_spec = {
	method: 'self_service_role_set',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: SelfServiceRoleSetInput,
	output: SelfServiceRoleSetOutput,
	async: true,
	description:
		'Toggle a self-service role. Idempotent in both directions — `changed: false` when post-call state already matched the request.',
} satisfies RequestResponseActionSpec;

/**
 * All self-service role action specs — a codegen-ready registry. Single-element
 * post-unification, kept for symmetry with the other `all_*_action_specs`
 * exports so codegen and frontend bundles import the same shape.
 */
export const all_self_service_role_action_specs: ReadonlyArray<RequestResponseActionSpec> = [
	self_service_role_set_action_spec,
];
