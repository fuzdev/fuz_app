/**
 * `actor_lookup` RPC spec — authenticated batched id → username/display_name
 * resolver, keyed by actor id.
 *
 * Powers the labels arc for surfaces that stamp an actor id (bylines,
 * owner columns, grantor labels, audit-log "by" cells). One round trip
 * resolves an array of ids to display strings.
 *
 * ## Auth + rate-limit posture
 *
 * `{account: 'required', actor: 'none'}` + `rate_limit: 'account'`.
 * Account-grain — only that the caller is signed in matters, not which
 * actor is calling, so resolution skips the actor phase. The auth gate
 * + per-account rate limit (default 1200/15min) + the
 * {@link ACTOR_LOOKUP_IDS_MAX | per-call cap} bound the batched
 * username-enumeration surface that the `cell_list` ↔ `actor_lookup`
 * pair would otherwise present.
 *
 * If a public-surface byline ever lands (e.g. an unauthenticated
 * gallery), it should resolve via a separate public-safe mechanism
 * (SSR-stamped labels or a per-cell embedded actor label), **not** by
 * loosening this gate.
 *
 * ## Wire shape — info-leak audit
 *
 * Output: `{actors: [{id, username, display_name?}]}`. Deliberately
 * omitted:
 *
 * - `account_id` — the actor↔account join is a control-plane detail
 * - `email`, password/credential fields — never queried
 * - `created_at` / `updated_at` — timing-oracle avoidance
 * - role / role_grants / session state — separation of concern
 *
 * `display_name` is omitted (not `null`) when `actor.name` is blank, so
 * clients see `undefined` rather than a sentinel string. Unknown ids are
 * silently absent from the response — by construction this is an
 * existence-oracle (the caller can diff response ids against request
 * ids), bounded by:
 *
 * 1. rate-limit (per-account, see above),
 * 2. {@link ACTOR_LOOKUP_IDS_MAX} cap per call,
 * 3. actor-uuid intractability (122-bit random),
 * 4. hard-deleted actors are indistinguishable from never-existed (no
 *    tombstone oracle — see `actor_lookup_queries.ts`).
 *
 * Response order is unspecified — callers index by `id` when needed.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';

/**
 * Hard cap on the number of ids resolvable in one call. Bounds the
 * batched username-enumeration surface.
 */
export const ACTOR_LOOKUP_IDS_MAX = 50;

/** One resolved actor row. `display_name` omitted when blank. */
export const ActorLookupEntryJson = z.strictObject({
	id: Uuid,
	username: z.string(),
	display_name: z.string().optional(),
});
export type ActorLookupEntryJson = z.infer<typeof ActorLookupEntryJson>;

export const ActorLookupInput = z.strictObject({
	ids: z
		.array(Uuid)
		.min(1)
		.max(ACTOR_LOOKUP_IDS_MAX)
		.meta({
			description: `Actor ids to resolve. Capped at ${ACTOR_LOOKUP_IDS_MAX}; unknown ids are silently absent from the response.`,
		}),
});
export type ActorLookupInput = z.infer<typeof ActorLookupInput>;

export const ActorLookupOutput = z.strictObject({
	actors: z.array(ActorLookupEntryJson),
});
export type ActorLookupOutput = z.infer<typeof ActorLookupOutput>;

export const actor_lookup_action_spec = {
	method: 'actor_lookup',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
	side_effects: false,
	input: ActorLookupInput,
	output: ActorLookupOutput,
	async: true,
	rate_limit: 'account',
	description: `Batched id → (username, display_name) resolver, keyed by actor id. Powers the labels arc for surfaces that stamp an actor id (e.g. cell owners, grant grantors). Authenticated + per-account rate-limited to bound batched username enumeration. Cap ${ACTOR_LOOKUP_IDS_MAX}; unknown ids absent from response.`,
} satisfies RequestResponseActionSpec;

/**
 * All actor_lookup action specs — independent opt-in registry. Consumers
 * spread alongside `all_standard_action_specs` if they want the labels
 * arc; not folded into the standard bundle because consumers without a
 * byline surface can skip it.
 */
export const all_actor_lookup_action_specs = [actor_lookup_action_spec] as const;
