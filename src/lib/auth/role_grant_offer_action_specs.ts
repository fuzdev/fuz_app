/**
 * Role grant offer RPC action specs — declarative contract for the
 * consentful-role-grants surface (offer lifecycle + admin revoke).
 *
 * Import this module for the specs, Input/Output schemas, `ERROR_ROLE_GRANT_OFFER_*`
 * reason constants, and the `all_role_grant_offer_action_specs` registry.
 * Handlers live in `auth/role_grant_offer_actions.ts`.
 *
 * Authorization enforcement: offer-lifecycle specs declare account+actor
 * required (no roles) and rely on `query_*` IDOR guards or in-handler
 * policy checks (e.g. `role_grant_offer_list`/`_history` elevate to admin only
 * when inspecting another account — an input-dependent check that can't be
 * expressed at the spec level). `role_grant_revoke` adds `roles: ['admin']` —
 * the RPC dispatcher's per-spec post-authorization auth gate
 * (`check_action_auth_post_authorization`) rejects non-admin callers before
 * the handler runs even though the endpoint hosts non-admin methods
 * alongside.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {ERROR_ROLE_GRANT_NOT_FOUND, ERROR_ROLE_NOT_WEB_GRANTABLE} from '../http/error_schemas.js';
import {RoleName} from './role_schema.js';
import {
	ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX,
	RoleGrantOfferJson,
} from './role_grant_offer_schema.js';
import {ROLE_GRANT_REVOKED_REASON_LENGTH_MAX} from './account_schema.js';
import {ActingActor} from '../http/auth_shape.js';

/** Error reason — caller tried to offer themselves a role_grant. */
export const ERROR_ROLE_GRANT_OFFER_SELF_TARGET = 'role_grant_offer_self_target' as const;
/** Error reason — offer is declined, retracted, or superseded. */
export const ERROR_ROLE_GRANT_OFFER_TERMINAL = 'role_grant_offer_terminal' as const;
/** Error reason — offer's `expires_at` has passed. */
export const ERROR_ROLE_GRANT_OFFER_EXPIRED = 'role_grant_offer_expired' as const;
/** Error reason — offer does not exist or belongs to a different recipient (404-over-403 IDOR mask). */
export const ERROR_ROLE_GRANT_OFFER_NOT_FOUND = 'role_grant_offer_not_found' as const;
/** Error reason — the offered role does not include `'admin'` in its `RoleSpec.grant_paths` (nobody may offer it via this surface). */
export const ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE =
	'role_grant_offer_role_not_grantable' as const;
/** Error reason — caller is not authorized to offer this role (default policy: caller lacks the role; consumer `authorize` callback may add further policy). */
export const ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED = 'role_grant_offer_not_authorized' as const;
/** Error reason — actor-targeted offer was accepted by an actor other than `to_actor_id`. */
export const ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH = 'role_grant_offer_actor_mismatch' as const;
/** Error reason — `role_grant_offer_create` was called with a `to_actor_id` that does not belong to `to_account_id`. */
export const ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH =
	'role_grant_offer_actor_account_mismatch' as const;

// -- Input/output schemas ---------------------------------------------------

/**
 * Input for `role_grant_offer_create`.
 *
 * `to_actor_id` (optional) narrows the offer to a specific actor on the
 * recipient account. When supplied, `role_grant_offer_accept` will only admit
 * the named actor — wrong-actor accepts reject with
 * `role_grant_offer_actor_mismatch`. The audit envelope's `target_actor_id` is
 * stamped from this column on the create / supersede / expire / retract
 * events. Omit (or pass null) for the account-grain default — any actor
 * on `to_account_id` may accept.
 */
export const RoleGrantOfferCreateInput = z.strictObject({
	to_account_id: Uuid.meta({description: 'Account id of the recipient.'}),
	to_actor_id: Uuid.nullish().meta({
		description:
			'Optional actor-grain target on the recipient account. When set, only this actor may accept and the audit envelope carries it on offer-shape events. Must belong to `to_account_id`.',
	}),
	role: RoleName.meta({description: 'Role being offered.'}),
	scope_kind: z.string().nullish().meta({
		description:
			'Machine-readable kind tag for `scope_id` — paired-null with `scope_id` (both null for global, both non-null for scoped). Required iff `scope_id` is set.',
	}),
	scope_id: Uuid.nullish().meta({
		description: 'Scope id for resource-scoped grants (e.g. classroom id). `null` for global.',
	}),
	message: z
		.string()
		.max(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX)
		.nullish()
		.meta({description: 'Optional free-form note from the grantor.'}),
	acting: ActingActor,
});
export type RoleGrantOfferCreateInput = z.infer<typeof RoleGrantOfferCreateInput>;

/** Input for `role_grant_offer_accept`. */
export const RoleGrantOfferAcceptInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to accept.'}),
	acting: ActingActor,
});
export type RoleGrantOfferAcceptInput = z.infer<typeof RoleGrantOfferAcceptInput>;

/** Input for `role_grant_offer_decline`. */
export const RoleGrantOfferDeclineInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to decline.'}),
	reason: z
		.string()
		.max(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX)
		.nullish()
		.meta({description: 'Optional free-form reason given on decline.'}),
	acting: ActingActor,
});
export type RoleGrantOfferDeclineInput = z.infer<typeof RoleGrantOfferDeclineInput>;

/** Input for `role_grant_offer_retract`. */
export const RoleGrantOfferRetractInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to retract.'}),
	acting: ActingActor,
});
export type RoleGrantOfferRetractInput = z.infer<typeof RoleGrantOfferRetractInput>;

/** Input for `role_grant_offer_list`. `account_id` is admin-only (inspect another account's inbox). */
export const RoleGrantOfferListInput = z.strictObject({
	account_id: Uuid.nullish().meta({
		description: 'Admin-only — list offers for another account. Defaults to the caller.',
	}),
	acting: ActingActor,
});
export type RoleGrantOfferListInput = z.infer<typeof RoleGrantOfferListInput>;

/**
 * Input for `role_grant_revoke`. Admin-only mutation that revokes an active
 * role_grant on a target actor. `actor_id` is the natural key — role_grants are
 * actor-scoped, and the admin UI reads `row.actor.id` straight from the
 * listing. Deriving `actor_id` from `account_id` would collapse under
 * multi-actor accounts.
 */
export const RoleGrantRevokeInput = z.strictObject({
	actor_id: Uuid.meta({description: 'Actor whose role_grant to revoke.'}),
	role_grant_id: Uuid.meta({description: 'The role_grant to revoke.'}),
	reason: z.string().max(ROLE_GRANT_REVOKED_REASON_LENGTH_MAX).nullish().meta({
		description:
			'Optional free-form reason; stamped on `role_grant.revoked_reason` and surfaced on the revokee WS notification.',
	}),
	acting: ActingActor,
});
export type RoleGrantRevokeInput = z.infer<typeof RoleGrantRevokeInput>;

/**
 * Input for `role_grant_offer_history`. Returns every offer involving the account
 * in either direction (recipient or grantor), including terminal rows, newest
 * first. `account_id` is admin-only.
 */
export const RoleGrantOfferHistoryInput = z.strictObject({
	account_id: Uuid.nullish().meta({
		description: 'Admin-only — history for another account. Defaults to the caller.',
	}),
	limit: z.number().int().min(1).max(500).nullish().meta({
		description: 'Max rows to return (default 100).',
	}),
	offset: z.number().int().min(0).nullish().meta({
		description: 'Pagination offset (default 0).',
	}),
	acting: ActingActor,
});
export type RoleGrantOfferHistoryInput = z.infer<typeof RoleGrantOfferHistoryInput>;

/** Output for `role_grant_offer_create`. */
export const RoleGrantOfferCreateOutput = z.strictObject({
	offer: RoleGrantOfferJson,
});
export type RoleGrantOfferCreateOutput = z.infer<typeof RoleGrantOfferCreateOutput>;

/** Output for `role_grant_offer_accept`. */
export const RoleGrantOfferAcceptOutput = z.strictObject({
	role_grant_id: Uuid,
	offer: RoleGrantOfferJson,
	superseded_offer_ids: z.array(Uuid),
});
export type RoleGrantOfferAcceptOutput = z.infer<typeof RoleGrantOfferAcceptOutput>;

/** Output for `role_grant_offer_decline` / `role_grant_offer_retract`. */
export const RoleGrantOfferOkOutput = z.strictObject({ok: z.literal(true)});
export type RoleGrantOfferOkOutput = z.infer<typeof RoleGrantOfferOkOutput>;

/** Output for `role_grant_offer_list`. */
export const RoleGrantOfferListOutput = z.strictObject({offers: z.array(RoleGrantOfferJson)});
export type RoleGrantOfferListOutput = z.infer<typeof RoleGrantOfferListOutput>;

/** Output for `role_grant_offer_history`. */
export const RoleGrantOfferHistoryOutput = z.strictObject({offers: z.array(RoleGrantOfferJson)});
export type RoleGrantOfferHistoryOutput = z.infer<typeof RoleGrantOfferHistoryOutput>;

/** Output for `role_grant_revoke`. */
export const RoleGrantRevokeOutput = z.strictObject({
	ok: z.literal(true),
	revoked: z.literal(true),
});
export type RoleGrantRevokeOutput = z.infer<typeof RoleGrantRevokeOutput>;

// -- Action specs -----------------------------------------------------------

export const role_grant_offer_create_action_spec = {
	method: 'role_grant_offer_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: RoleGrantOfferCreateInput,
	output: RoleGrantOfferCreateOutput,
	async: true,
	description:
		"Offer a role_grant to another account. Grantor must hold the offered role (or pass a consumer authorize callback); role's `grant_paths` must include `'admin'`.",
	error_reasons: [
		ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
		ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
		ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
		ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
	],
} satisfies RequestResponseActionSpec;

export const role_grant_offer_accept_action_spec = {
	method: 'role_grant_offer_accept',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: RoleGrantOfferAcceptInput,
	output: RoleGrantOfferAcceptOutput,
	async: true,
	description:
		'Accept an offer. Atomically marks the offer accepted, inserts the role_grant, and supersedes sibling pending offers for the same (account, role, scope).',
	error_reasons: [
		ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
		ERROR_ROLE_GRANT_OFFER_TERMINAL,
		ERROR_ROLE_GRANT_OFFER_EXPIRED,
		ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH,
	],
} satisfies RequestResponseActionSpec;

export const role_grant_offer_decline_action_spec = {
	method: 'role_grant_offer_decline',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: RoleGrantOfferDeclineInput,
	output: RoleGrantOfferOkOutput,
	async: true,
	description: 'Decline an offer. Recipient-only.',
	error_reasons: [ERROR_ROLE_GRANT_OFFER_NOT_FOUND, ERROR_ROLE_GRANT_OFFER_TERMINAL],
} satisfies RequestResponseActionSpec;

export const role_grant_offer_retract_action_spec = {
	method: 'role_grant_offer_retract',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: true,
	input: RoleGrantOfferRetractInput,
	output: RoleGrantOfferOkOutput,
	async: true,
	description: 'Retract an offer. Grantor-only, pre-decision.',
	error_reasons: [ERROR_ROLE_GRANT_OFFER_NOT_FOUND, ERROR_ROLE_GRANT_OFFER_TERMINAL],
} satisfies RequestResponseActionSpec;

export const role_grant_offer_list_action_spec = {
	method: 'role_grant_offer_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: false,
	input: RoleGrantOfferListInput,
	output: RoleGrantOfferListOutput,
	async: true,
	description:
		'List pending, non-expired offers for the caller. Admins may pass `account_id` to inspect another account.',
} satisfies RequestResponseActionSpec;

export const role_grant_offer_history_action_spec = {
	method: 'role_grant_offer_history',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required'},
	side_effects: false,
	input: RoleGrantOfferHistoryInput,
	output: RoleGrantOfferHistoryOutput,
	async: true,
	description:
		'List every offer involving the caller (either direction), including terminal rows, newest first. Admins may pass `account_id` to inspect another account.',
} satisfies RequestResponseActionSpec;

export const role_grant_revoke_action_spec = {
	method: 'role_grant_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: ['admin']},
	side_effects: true,
	input: RoleGrantRevokeInput,
	output: RoleGrantRevokeOutput,
	async: true,
	description:
		'Revoke an active role_grant on a target actor. Admin-only. Supersedes any pending offers for the same (account, role, scope). Fires role_grant_revoke + role_grant_offer_supersede notifications.',
	error_reasons: [ERROR_ROLE_GRANT_NOT_FOUND, ERROR_ROLE_NOT_WEB_GRANTABLE],
	rate_limit: 'account',
} satisfies RequestResponseActionSpec;

/**
 * All role-grant-offer action specs — a codegen-ready registry. Consumers spread
 * this into their own action-spec array to include offer lifecycle + revoke
 * methods in a typed client surface.
 */
export const all_role_grant_offer_action_specs: Array<RequestResponseActionSpec> = [
	role_grant_offer_create_action_spec,
	role_grant_offer_accept_action_spec,
	role_grant_offer_decline_action_spec,
	role_grant_offer_retract_action_spec,
	role_grant_offer_list_action_spec,
	role_grant_offer_history_action_spec,
	role_grant_revoke_action_spec,
];
