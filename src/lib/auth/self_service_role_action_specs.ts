/**
 * Unified self-service role toggle action spec — schemas, error reasons,
 * and the codegen-ready registry.
 *
 * Client-safe: no query-layer or audit-write imports. Handler factory
 * lives in `auth/self_service_role_actions.ts`.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { boolean, literal, object, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import type { RequestResponseActionSpec } from '../actions/action_spec.ts';
import { ActingActor } from '../primitive_schemas_fuz.ts';
import { RoleName } from './role_schema_fuz.ts';

/** Error reason — caller asked to self-toggle a role outside the configured allowlist. */
export const ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE = 'role_not_self_service_eligible' as const;

/** Input for `self_service_role_set`, a `@fuzdev/fuz_schema` schema. */
export const SelfServiceRoleSetInput = object({
	role: meta(RoleName, { description: 'Role to toggle. Must be in the configured allowlist.' }),
	enabled: meta(boolean, {
		description:
			'Desired post-call state. `true` grants if not held; `false` revokes if held. Idempotent in both directions.'
	}),
	acting: ActingActor
});
export type SelfServiceRoleSetInput = Infer<typeof SelfServiceRoleSetInput>;

/**
 * Output for `self_service_role_set`, a `@fuzdev/fuz_schema` schema. `enabled`
 * echoes the post-call state (always equals the input `enabled` on success).
 * `changed` is `true` only when the call mutated — re-grants / re-revokes
 * return `false`.
 */
export const SelfServiceRoleSetOutput = object({
	ok: literal(true),
	enabled: boolean,
	changed: boolean
});
export type SelfServiceRoleSetOutput = Infer<typeof SelfServiceRoleSetOutput>;

/**
 * `rate_limit: 'account'` bounds audit-row churn. The toggle is idempotent
 * (`changed: false` re-grants/re-revokes), but every call still writes a
 * `role_grant_create` or `role_grant_revoke` audit row with
 * `self_service: true`. Without the cap, a caller could flap the role in
 * a loop to inflate the audit log and obscure other activity.
 *
 * `credential_types: ['session']` — see `docs/security.md` §Credential-channel
 * gating. Self-toggling a role moves the caller's own authority, the same
 * privilege-pivot shape as `role_grant_offer_accept`. The verb exists to serve
 * a UI affordance, so the bearer channel buys nothing and a leaked
 * account-wide token self-granting an eligible role is what the gate refuses.
 */
export const self_service_role_set_action_spec = {
	method: 'self_service_role_set',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', credential_types: ['session'] },
	side_effects: true,
	input: SelfServiceRoleSetInput,
	output: SelfServiceRoleSetOutput,
	async: true,
	description:
		'Toggle a self-service role. Idempotent in both directions — `changed: false` when post-call state already matched the request.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

/**
 * All self-service role action specs — a codegen-ready registry. Single-element
 * post-unification, kept for symmetry with the other `all_*_action_specs`
 * exports so codegen and frontend bundles import the same shape.
 */
export const all_self_service_role_action_specs: ReadonlyArray<RequestResponseActionSpec> = [
	self_service_role_set_action_spec
];
