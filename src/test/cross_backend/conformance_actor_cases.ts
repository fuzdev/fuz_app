/**
 * Conformance cases for the opt-in actor resolvers, `actor_lookup` and
 * `actor_search` — live-mounted on the spine RPC path and kept off the
 * declared surface, so the table resolves them through `live_rpc_endpoints`.
 *
 * The anonymous 401 on each is a generated row
 * (`generate_rpc_auth_conformance_cases` given the live mount); these rows pin
 * what a handler decides from its input:
 *
 * - **`actor_lookup` input bound** — an empty `ids` is `invalid_params` (400).
 *   The populated round trip (the keeper's own actor resolves to its id and
 *   username, with no control field) names the fixture's actor id, so it stays
 *   the imperative `describe_actor_lookup_cross_tests`.
 * - **`actor_search` scope gate** — an unbounded search is admin-only: a
 *   non-admin with no `scope_ids` is refused `actor_search_scope_required`
 *   (400), a non-admin naming a scope reaches the search (an unheld scope
 *   answers an empty list, not a refusal — the gate keys on `scope_ids`
 *   being present), and an admin reaches the unbounded search.
 *
 * @module
 */

import { ERROR_ACTOR_SEARCH_SCOPE_REQUIRED } from '#lib/auth/actor_search_action_specs.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';

/** A well-formed UUID no role grant is scoped to. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const conformance_actor_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'keeper → actor_lookup {ids: []} → 400',
		request: { method: 'actor_lookup', as: 'keeper', params: { ids: [] } },
		expect: { status: 400 },
		note: 'auth/actor_lookup_action_specs.ts — `ids` is bounded to at least one id'
	},
	{
		name: 'fresh non-admin → actor_search with no scope_ids → 400 actor_search_scope_required',
		request: { method: 'actor_search', as: 'fresh_non_admin', params: { query: 'a' } },
		expect: { status: 400, error_reason: ERROR_ACTOR_SEARCH_SCOPE_REQUIRED },
		note: 'security.md §Authorization — an unbounded actor search is admin-only'
	},
	{
		name: 'fresh non-admin → actor_search with scope_ids → 200',
		request: {
			method: 'actor_search',
			as: 'fresh_non_admin',
			params: { query: 'a', scope_ids: [NIL_UUID] }
		},
		expect: { status: 200, fields: { actors: [] } },
		note: 'security.md §Authorization — a scoped search needs no admin; an unheld scope matches no actor'
	},
	{
		name: 'admin → actor_search with no scope_ids → 200',
		request: { method: 'actor_search', as: 'keeper', params: { query: 'a' } },
		expect: { status: 200 },
		note: 'security.md §Authorization — an admin reaches the unbounded search'
	}
];
