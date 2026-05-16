/**
 * `actor_search` RPC spec — authenticated case-insensitive prefix search
 * over `actor.name`, returning the same `{id, username, display_name?}`
 * wire shape as `actor_lookup`.
 *
 * Powers person-target pickers — visiones' `CellGrantsEditor.svelte`
 * teacher-picks-student flow replaces the deferred `actor_by_name` arm of
 * `cell_grant_create` with a debounced search against this method. Sibling
 * to `actor_lookup`: that resolves a known batch of ids → labels; this
 * resolves a partial name → candidate actors.
 *
 * ## Auth + rate-limit posture
 *
 * `{account: 'required', actor: 'none'}` + `rate_limit: 'account'`. Same
 * shape as `actor_lookup`: only that the caller is signed in matters, not
 * which actor is calling. The auth gate, the per-account rate limit
 * (default 1200/15min), and the `ACTOR_SEARCH_LIMIT_MAX` per-call cap
 * bound the enumeration surface this method would otherwise present.
 *
 * The handler additionally requires the caller to be admin when
 * `scope_ids` is empty (the unbounded global-search arm). Non-admin
 * callers must always pass at least one scope_id — the SQL filters
 * actors to those holding a role_grant on one of the supplied scopes, so
 * a non-admin caller is restricted to actors they share a scope with.
 * The admin check is account-grain (any actor on the caller's account
 * holds a global `admin` role_grant), matching the `actor: 'none'` posture.
 *
 * ## Caller-passes-scope_ids design
 *
 * `scope_ids` is trusted as a filter, not as an authority claim — the
 * SQL filters to actors with role_grants on those scopes regardless of
 * whether the caller has authority over them. Consumers are responsible
 * for pre-filtering `scope_ids` against their own authority before
 * calling. Visiones passes the set of classrooms the teacher teaches,
 * sourced client-side from the teacher's role_grant list; the teacher
 * predicate stays in the visiones layer rather than baked into fuz_app.
 *
 * Crucially, this does **not** widen the scope-existence oracle: an
 * attacker passing a random scope_id cannot learn "this scope has
 * members matching X" because the join filters to actors holding a
 * role_grant on the scope, and the SQL surfaces neither "did the scope
 * exist" nor "did the scope have non-matching members" — only the
 * matching subset is returned.
 *
 * ## Wire shape — info-leak audit
 *
 * Output `{actors: [{id, username, display_name?}]}` is identical to
 * `actor_lookup`'s — see `auth/actor_lookup_action_specs.ts` for the full
 * field-by-field audit. Same omissions (`account_id`, email,
 * timestamps, role / role_grants / session state), same `display_name`
 * omitted-not-null contract, same response-order-unspecified rule.
 *
 * Additional `actor_search`-specific posture:
 *
 * - Prefix match (`LOWER(name) LIKE LOWER(query) || '%'`), not full
 *   `%query%`. Full-LIKE would let a single call enumerate one
 *   alphabetical bucket spread across many starting letters, which
 *   defeats the per-call cap as an enumeration bound.
 * - Hard-deleted actors silently drop (cascade through `actor.account_id`
 *   FK) — no tombstone oracle, same posture as `actor_lookup`.
 * - Empty result set on no-match — fail-soft like `cell_list`. No
 *   "no actor matches" error message that would leak an existence
 *   boundary on the search-term axis.
 *
 * ## Why not extend `actor_lookup`?
 *
 * Splitting the methods keeps the wire contracts independent: `actor_lookup`'s
 * input is `{ids}`, `actor_search`'s is `{query}` + optional filters.
 * Both surface the same `ActorLookupEntryJson` row shape (re-used here),
 * so the labels arc on the consumer side stays uniform.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {ActorLookupEntryJson} from './actor_lookup_action_specs.js';

/**
 * Hard cap on the number of rows returned per call. Bounds the search-result
 * enumeration surface. Default limit (`ACTOR_SEARCH_LIMIT_DEFAULT`) is
 * smaller — most pickers render fewer rows than the cap.
 */
export const ACTOR_SEARCH_LIMIT_MAX = 50;

/** Default `limit` when the caller omits it. */
export const ACTOR_SEARCH_LIMIT_DEFAULT = 20;

/**
 * Hard cap on the query string length. Long inputs offer no extra search
 * value once they exceed `actor.name` realistic lengths, and a low cap
 * keeps the per-request work bounded for pathological inputs.
 */
export const ACTOR_SEARCH_QUERY_LENGTH_MAX = 50;

/**
 * Reason: `scope_ids` was empty and the caller is not admin. Distinct from
 * standard `invalid_params` issues so the visiones picker can surface a
 * specific "pick a scope first" message rather than echoing Zod issues.
 */
export const ERROR_ACTOR_SEARCH_SCOPE_REQUIRED = 'actor_search_scope_required' as const;

export const ActorSearchInput = z.strictObject({
	query: z
		.string()
		.min(1)
		.max(ACTOR_SEARCH_QUERY_LENGTH_MAX)
		.meta({
			description: `Case-insensitive prefix match against \`actor.name\`. Length 1–${ACTOR_SEARCH_QUERY_LENGTH_MAX}.`,
		}),
	scope_ids: z.array(Uuid).optional().meta({
		description:
			'Restrict results to actors holding a role_grant on any of these scopes. Required (non-empty) for non-admin callers; admin callers may omit or pass empty for unbounded search. Caller is responsible for pre-filtering against their own authority — the SQL filter does not enforce it.',
	}),
	limit: z
		.number()
		.int()
		.min(1)
		.max(ACTOR_SEARCH_LIMIT_MAX)
		.optional()
		.meta({
			description: `Maximum rows to return. Defaults to ${ACTOR_SEARCH_LIMIT_DEFAULT}, hard cap ${ACTOR_SEARCH_LIMIT_MAX}.`,
		}),
});
export type ActorSearchInput = z.infer<typeof ActorSearchInput>;

export const ActorSearchOutput = z.strictObject({
	actors: z.array(ActorLookupEntryJson),
});
export type ActorSearchOutput = z.infer<typeof ActorSearchOutput>;

export const actor_search_action_spec = {
	method: 'actor_search',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
	side_effects: false,
	input: ActorSearchInput,
	output: ActorSearchOutput,
	async: true,
	rate_limit: 'account',
	error_reasons: [ERROR_ACTOR_SEARCH_SCOPE_REQUIRED],
	description: `Case-insensitive prefix search over actor.name, returning {id, username, display_name?} rows. Authenticated + per-account rate-limited; non-admin callers must pass at least one scope_id. Default limit ${ACTOR_SEARCH_LIMIT_DEFAULT}, hard cap ${ACTOR_SEARCH_LIMIT_MAX}.`,
} satisfies RequestResponseActionSpec;

/**
 * All actor_search action specs — independent opt-in registry. Like
 * `all_actor_lookup_action_specs`, not folded into `all_standard_action_specs`
 * because consumers without a person-target picker can skip it.
 */
export const all_actor_search_action_specs = [actor_search_action_spec] as const;
