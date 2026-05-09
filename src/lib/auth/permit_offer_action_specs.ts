/**
 * Permit offer RPC action specs — declarative contract for the
 * consentful-permits surface (offer lifecycle + admin revoke).
 *
 * Import this module for the specs, Input/Output schemas, `ERROR_OFFER_*`
 * reason constants, and the `all_permit_offer_action_specs` registry.
 * Handlers live in `auth/permit_offer_actions.ts`.
 *
 * Authorization enforcement: offer-lifecycle specs declare
 * `auth: 'authenticated'` and rely on `query_*` IDOR guards or in-handler
 * policy checks (e.g. `permit_offer_list`/`_history` elevate to admin only
 * when inspecting another account — an input-dependent check that can't be
 * expressed at the spec level). `permit_revoke` declares
 * `auth: {role: 'admin'}` — the RPC dispatcher's per-spec post-authorization
 * auth gate (`check_action_auth_post_authorization`) rejects non-admin
 * callers before the handler runs even though the endpoint hosts non-admin
 * methods alongside.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {ERROR_PERMIT_NOT_FOUND, ERROR_ROLE_NOT_WEB_GRANTABLE} from '../http/error_schemas.js';
import {RoleName} from './role_schema.js';
import {PERMIT_OFFER_MESSAGE_LENGTH_MAX, PermitOfferJson} from './permit_offer_schema.js';
import {ActingActor, PERMIT_REVOKED_REASON_LENGTH_MAX} from './account_schema.js';

/** Error reason — caller tried to offer themselves a permit. */
export const ERROR_OFFER_SELF_TARGET = 'offer_self_target' as const;
/** Error reason — offer is declined, retracted, or superseded. */
export const ERROR_OFFER_TERMINAL = 'offer_terminal' as const;
/** Error reason — offer's `expires_at` has passed. */
export const ERROR_OFFER_EXPIRED = 'offer_expired' as const;
/** Error reason — offer does not exist or belongs to a different recipient (404-over-403 IDOR mask). */
export const ERROR_OFFER_NOT_FOUND = 'offer_not_found' as const;
/** Error reason — the offered role is not `web_grantable` (nobody may offer it via this surface). */
export const ERROR_OFFER_ROLE_NOT_GRANTABLE = 'offer_role_not_grantable' as const;
/** Error reason — caller is not authorized to offer this role (default policy: caller lacks the role; consumer `authorize` callback may add further policy). */
export const ERROR_OFFER_NOT_AUTHORIZED = 'offer_not_authorized' as const;
/** Error reason — actor-targeted offer was accepted by an actor other than `to_actor_id`. */
export const ERROR_OFFER_ACTOR_MISMATCH = 'offer_actor_mismatch' as const;
/** Error reason — `permit_offer_create` was called with a `to_actor_id` that does not belong to `to_account_id`. */
export const ERROR_OFFER_ACTOR_ACCOUNT_MISMATCH = 'offer_actor_account_mismatch' as const;

// -- Input/output schemas ---------------------------------------------------

/**
 * Input for `permit_offer_create`.
 *
 * `to_actor_id` (optional) narrows the offer to a specific actor on the
 * recipient account. When supplied, `permit_offer_accept` will only admit
 * the named actor — wrong-actor accepts reject with
 * `offer_actor_mismatch`. The audit envelope's `target_actor_id` is
 * stamped from this column on the create / supersede / expire / retract
 * events. Omit (or pass null) for the account-grain default — any actor
 * on `to_account_id` may accept.
 */
export const PermitOfferCreateInput = z.strictObject({
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
		.max(PERMIT_OFFER_MESSAGE_LENGTH_MAX)
		.nullish()
		.meta({description: 'Optional free-form note from the grantor.'}),
	acting: ActingActor,
});
export type PermitOfferCreateInput = z.infer<typeof PermitOfferCreateInput>;

/** Input for `permit_offer_accept`. */
export const PermitOfferAcceptInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to accept.'}),
	acting: ActingActor,
});
export type PermitOfferAcceptInput = z.infer<typeof PermitOfferAcceptInput>;

/** Input for `permit_offer_decline`. */
export const PermitOfferDeclineInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to decline.'}),
	reason: z
		.string()
		.max(PERMIT_OFFER_MESSAGE_LENGTH_MAX)
		.nullish()
		.meta({description: 'Optional free-form reason given on decline.'}),
	acting: ActingActor,
});
export type PermitOfferDeclineInput = z.infer<typeof PermitOfferDeclineInput>;

/** Input for `permit_offer_retract`. */
export const PermitOfferRetractInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to retract.'}),
	acting: ActingActor,
});
export type PermitOfferRetractInput = z.infer<typeof PermitOfferRetractInput>;

/** Input for `permit_offer_list`. `account_id` is admin-only (inspect another account's inbox). */
export const PermitOfferListInput = z.strictObject({
	account_id: Uuid.nullish().meta({
		description: 'Admin-only — list offers for another account. Defaults to the caller.',
	}),
	acting: ActingActor,
});
export type PermitOfferListInput = z.infer<typeof PermitOfferListInput>;

/**
 * Input for `permit_revoke`. Admin-only mutation that revokes an active
 * permit on a target actor. `actor_id` is the natural key — permits are
 * actor-scoped, and the admin UI reads `row.actor.id` straight from the
 * listing. Deriving `actor_id` from `account_id` would collapse under
 * multi-actor accounts.
 */
export const PermitRevokeInput = z.strictObject({
	actor_id: Uuid.meta({description: 'Actor whose permit to revoke.'}),
	permit_id: Uuid.meta({description: 'The permit to revoke.'}),
	reason: z.string().max(PERMIT_REVOKED_REASON_LENGTH_MAX).nullish().meta({
		description:
			'Optional free-form reason; stamped on `permit.revoked_reason` and surfaced on the revokee WS notification.',
	}),
	acting: ActingActor,
});
export type PermitRevokeInput = z.infer<typeof PermitRevokeInput>;

/**
 * Input for `permit_offer_history`. Returns every offer involving the account
 * in either direction (recipient or grantor), including terminal rows, newest
 * first. `account_id` is admin-only.
 */
export const PermitOfferHistoryInput = z.strictObject({
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
export type PermitOfferHistoryInput = z.infer<typeof PermitOfferHistoryInput>;

/** Output for `permit_offer_create`. */
export const PermitOfferCreateOutput = z.strictObject({
	offer: PermitOfferJson,
});
export type PermitOfferCreateOutput = z.infer<typeof PermitOfferCreateOutput>;

/** Output for `permit_offer_accept`. */
export const PermitOfferAcceptOutput = z.strictObject({
	permit_id: Uuid,
	offer: PermitOfferJson,
	superseded_offer_ids: z.array(Uuid),
});
export type PermitOfferAcceptOutput = z.infer<typeof PermitOfferAcceptOutput>;

/** Output for `permit_offer_decline` / `permit_offer_retract`. */
export const PermitOfferOkOutput = z.strictObject({ok: z.literal(true)});
export type PermitOfferOkOutput = z.infer<typeof PermitOfferOkOutput>;

/** Output for `permit_offer_list`. */
export const PermitOfferListOutput = z.strictObject({offers: z.array(PermitOfferJson)});
export type PermitOfferListOutput = z.infer<typeof PermitOfferListOutput>;

/** Output for `permit_offer_history`. */
export const PermitOfferHistoryOutput = z.strictObject({offers: z.array(PermitOfferJson)});
export type PermitOfferHistoryOutput = z.infer<typeof PermitOfferHistoryOutput>;

/** Output for `permit_revoke`. */
export const PermitRevokeOutput = z.strictObject({
	ok: z.literal(true),
	revoked: z.literal(true),
});
export type PermitRevokeOutput = z.infer<typeof PermitRevokeOutput>;

// -- Action specs -----------------------------------------------------------

export const permit_offer_create_action_spec = {
	method: 'permit_offer_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: PermitOfferCreateInput,
	output: PermitOfferCreateOutput,
	async: true,
	description:
		'Offer a permit to another account. Grantor must hold the offered role (or pass a consumer authorize callback); role must be web_grantable.',
	error_reasons: [
		ERROR_OFFER_SELF_TARGET,
		ERROR_OFFER_ROLE_NOT_GRANTABLE,
		ERROR_OFFER_NOT_AUTHORIZED,
		ERROR_OFFER_ACTOR_ACCOUNT_MISMATCH,
	],
} satisfies RequestResponseActionSpec;

export const permit_offer_accept_action_spec = {
	method: 'permit_offer_accept',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: PermitOfferAcceptInput,
	output: PermitOfferAcceptOutput,
	async: true,
	description:
		'Accept an offer. Atomically marks the offer accepted, inserts the permit, and supersedes sibling pending offers for the same (account, role, scope).',
	error_reasons: [
		ERROR_OFFER_NOT_FOUND,
		ERROR_OFFER_TERMINAL,
		ERROR_OFFER_EXPIRED,
		ERROR_OFFER_ACTOR_MISMATCH,
	],
} satisfies RequestResponseActionSpec;

export const permit_offer_decline_action_spec = {
	method: 'permit_offer_decline',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: PermitOfferDeclineInput,
	output: PermitOfferOkOutput,
	async: true,
	description: 'Decline an offer. Recipient-only.',
	error_reasons: [ERROR_OFFER_NOT_FOUND, ERROR_OFFER_TERMINAL],
} satisfies RequestResponseActionSpec;

export const permit_offer_retract_action_spec = {
	method: 'permit_offer_retract',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: PermitOfferRetractInput,
	output: PermitOfferOkOutput,
	async: true,
	description: 'Retract an offer. Grantor-only, pre-decision.',
	error_reasons: [ERROR_OFFER_NOT_FOUND, ERROR_OFFER_TERMINAL],
} satisfies RequestResponseActionSpec;

export const permit_offer_list_action_spec = {
	method: 'permit_offer_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: PermitOfferListInput,
	output: PermitOfferListOutput,
	async: true,
	description:
		'List pending, non-expired offers for the caller. Admins may pass `account_id` to inspect another account.',
} satisfies RequestResponseActionSpec;

export const permit_offer_history_action_spec = {
	method: 'permit_offer_history',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: PermitOfferHistoryInput,
	output: PermitOfferHistoryOutput,
	async: true,
	description:
		'List every offer involving the caller (either direction), including terminal rows, newest first. Admins may pass `account_id` to inspect another account.',
} satisfies RequestResponseActionSpec;

export const permit_revoke_action_spec = {
	method: 'permit_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: 'admin'},
	side_effects: true,
	input: PermitRevokeInput,
	output: PermitRevokeOutput,
	async: true,
	description:
		'Revoke an active permit on a target actor. Admin-only. Supersedes any pending offers for the same (account, role, scope). Fires permit_revoke + permit_offer_supersede notifications.',
	error_reasons: [ERROR_PERMIT_NOT_FOUND, ERROR_ROLE_NOT_WEB_GRANTABLE],
	rate_limit: 'account',
} satisfies RequestResponseActionSpec;

/**
 * All permit-offer action specs — a codegen-ready registry. Consumers spread
 * this into their own action-spec array to include offer lifecycle + revoke
 * methods in a typed client surface.
 */
export const all_permit_offer_action_specs: Array<RequestResponseActionSpec> = [
	permit_offer_create_action_spec,
	permit_offer_accept_action_spec,
	permit_offer_decline_action_spec,
	permit_offer_retract_action_spec,
	permit_offer_list_action_spec,
	permit_offer_history_action_spec,
	permit_revoke_action_spec,
];
