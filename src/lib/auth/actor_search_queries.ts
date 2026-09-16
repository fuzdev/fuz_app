/**
 * Prefix-based actor search.
 *
 * Sibling to `auth/actor_lookup_queries.ts` — that resolves a batch of ids to
 * labels; this resolves a partial name to candidate actors. Same row
 * shape (`ActorLookupRow`) so the labels arc on the consumer side stays
 * uniform.
 *
 * Case-insensitive LIKE-prefix on `actor.name` backed by the
 * `idx_actor_name_lower` functional index. LIKE wildcards (`%`, `_`,
 * `\`) in the query string are escaped at the JS layer so the
 * prefix-only contract is enforceable — an unescaped `%xyz` would
 * widen the surface to full-LIKE and defeat the per-call cap as a
 * binding bound.
 *
 * ## Auth filtering — `scope_ids`
 *
 * When `scope_ids` is non-empty, the result is filtered to actors
 * holding an **active** role_grant on one of the supplied scopes. Active
 * means `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`.
 * Stale (revoked / expired) role_grants do **not** confer membership for
 * search-visibility purposes — otherwise a removed student would
 * remain visible to teachers indefinitely.
 *
 * The `DISTINCT` on `actor.id` collapses the case where an actor holds
 * multiple matching role_grants in the supplied scope set into one row.
 *
 * When `scope_ids` is omitted (admin-only global path; the handler
 * gates), no role_grant join — every actor with a matching prefix is
 * returned.
 *
 * ## Info-leak posture (see `auth/actor_search_action_specs.ts` §audit)
 *
 * - Row shape **omits** `account_id` — the join is control-plane, not
 *   wire-visible. Identical to `auth/actor_lookup_queries.ts`.
 * - Hard-deleted actors (cascade-orphaned via `actor.account_id` FK)
 *   drop out silently.
 * - No `created_at` / `updated_at` projected (timing-oracle avoidance).
 * - Scope-membership uses ANY on the supplied `scope_ids` array but
 *   never surfaces "which scope matched" — the result row carries only
 *   the actor's wire shape. An attacker passing a random scope_id
 *   learns at most "this scope has at least one member matching X"
 *   if a match exists, indistinguishable from a no-match search; the
 *   caller-passes-scope_ids design (handler trusts the array as a
 *   filter, not as authority) means the attacker had to obtain the
 *   scope_id from somewhere else first.
 *
 * Caller bounds `limit` (the action-spec layer enforces
 * `ACTOR_SEARCH_LIMIT_MAX`); SQL clamps to that cap on the call site
 * before reaching this query.
 *
 * @module
 */

import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { QueryDeps } from '../db/query_deps.ts';
import type { ActorLookupRow } from './actor_lookup_queries.ts';

/** Inputs for `query_actor_search`. */
export interface ActorSearchQueryInput {
	/** Case-insensitive prefix string. Must be non-empty (action layer enforces `min(1)`). */
	query: string;
	/**
	 * When non-empty, restrict to actors holding an active role_grant on one
	 * of these scope ids. When empty / omitted, no scope filter is applied —
	 * the handler is responsible for the admin gate.
	 */
	scope_ids?: ReadonlyArray<Uuid>;
	/** Maximum rows to return. The handler clamps to `ACTOR_SEARCH_LIMIT_MAX`. */
	limit: number;
}

/**
 * Escape LIKE wildcards in a user-supplied query string so the SQL
 * prefix-match cannot be widened by user input. The `\` escape char is
 * declared on the LIKE expression via `ESCAPE '\'`.
 */
const escape_like_pattern = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/**
 * Search actors by case-insensitive prefix on `actor.name`, optionally
 * filtered to those holding an active role_grant on one of `scope_ids`.
 */
export const query_actor_search = async (
	deps: QueryDeps,
	input: ActorSearchQueryInput
): Promise<Array<ActorLookupRow>> => {
	const escaped_prefix = escape_like_pattern(input.query.toLowerCase());
	const scope_ids = input.scope_ids ?? [];

	if (scope_ids.length === 0) {
		// Admin-global path — no role_grant join. Handler enforces admin.
		return deps.db.query<ActorLookupRow>(
			`SELECT act.id, a.username, act.name AS display_name
			 FROM actor act
			 JOIN account a ON a.id = act.account_id
			 WHERE LOWER(act.name) LIKE $1 || '%' ESCAPE '\\'
			 ORDER BY display_name, id
			 LIMIT $2`,
			[escaped_prefix, input.limit]
		);
	}

	// Scoped path — filter to actors with an active role_grant on any of
	// `scope_ids`. DISTINCT collapses actors holding multiple matching
	// role_grants in the supplied scope set into one row. ORDER BY must
	// reference SELECT-listed columns under DISTINCT, so we sort by the
	// `display_name` alias rather than `LOWER(act.name)`.
	return deps.db.query<ActorLookupRow>(
		`SELECT DISTINCT act.id, a.username, act.name AS display_name
		 FROM actor act
		 JOIN account a ON a.id = act.account_id
		 JOIN role_grant rg ON rg.actor_id = act.id
		   AND rg.scope_id = ANY($2)
		   AND rg.revoked_at IS NULL
		   AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
		 WHERE LOWER(act.name) LIKE $1 || '%' ESCAPE '\\'
		 ORDER BY display_name, id
		 LIMIT $3`,
		[escaped_prefix, scope_ids as Array<Uuid>, input.limit]
	);
};
