/**
 * Batched actor-by-id resolver.
 *
 * Joins `actor` ⨝ `account` so callers see `(username, display_name)` for
 * each actor row. The byline / owner-column / grantor surfaces stamp an
 * actor id, so resolving "who is this actor?" lands the human label in
 * one round trip.
 *
 * Accounts may host multiple actors (multi-actor shipped in v0.55.0).
 * The inner join still resolves one row per actor — `actor.account_id`
 * is `NOT NULL` so every actor has exactly one account.
 *
 * Info-leak posture (see `auth/actor_lookup_action_specs.ts` §audit):
 *
 * - Row shape **omits** `account_id` — the join is control-plane,
 *   not wire-visible.
 * - Hard-deleted actors (or account-cascade-orphaned rows) drop out
 *   silently — indistinguishable from never-existed (no tombstone
 *   oracle).
 * - No `created_at` / `updated_at` projected (timing-oracle avoidance).
 * - Response order is unspecified — `WHERE id = ANY(...)` returns
 *   index-scan order in practice but callers must not depend on it.
 *
 * Caller is responsible for capping `ids.length` — the SQL itself does
 * not enforce a bound; the action-spec layer surfaces `invalid_params`
 * via `ACTOR_LOOKUP_IDS_MAX`.
 *
 * @module
 */

import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import type {QueryDeps} from '../db/query_deps.ts';

/** Row shape returned to handlers — wire mapping happens at the action layer. */
export interface ActorLookupRow {
	id: Uuid;
	username: string;
	display_name: string | null;
}

/**
 * Resolve a batch of actor ids to `(id, username, display_name)`. Empty
 * input fast-paths to `[]`. Hard-deleted actors (or account-cascade-
 * orphaned rows) drop out of the result silently.
 */
export const query_actors_by_ids = async (
	deps: QueryDeps,
	ids: ReadonlyArray<Uuid>,
): Promise<Array<ActorLookupRow>> => {
	if (ids.length === 0) return [];
	return deps.db.query<ActorLookupRow>(
		`SELECT act.id, a.username, act.name AS display_name
		 FROM actor act
		 JOIN account a ON a.id = act.account_id
		 WHERE act.id = ANY($1)`,
		[ids as Array<Uuid>],
	);
};
