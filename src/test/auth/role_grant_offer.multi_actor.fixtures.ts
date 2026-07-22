/**
 * Shared scaffolding for the `role_grant_offer.multi_actor.*.db.test.ts`
 * sibling suites.
 *
 * Returns a `{build_app_with_audit, add_second_actor}` pair bound to the
 * caller's `describe_db` `get_db` callback. The original monolithic
 * `role_grant_offer.multi_actor.db.test.ts` declared both as outer-scope
 * closures over `get_db`; lifting them here lets each per-aspect sibling
 * file pull the same scaffolding without re-declaring the closures.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick
 * it up. Mirrors ./role_grant_offer_test_helpers.ts for the rest of the
 * role-grant-offer integration scaffolding.
 *
 * @module
 */

import { create_test_app } from '$lib/testing/app_server.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { query_create_actor } from '$lib/auth/account_queries.ts';
import { create_audit_emitter } from '$lib/auth/audit_emitter.ts';
import type { AuditLogEvent } from '$lib/auth/audit_log_schema.ts';
import type { Db } from '$lib/db/db.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { create_route_specs, session_options } from './role_grant_offer_test_helpers.ts';

/**
 * Build the multi-actor scaffolding bound to a `describe_db` callback's
 * `get_db`. Returns the two closures every per-aspect sibling needs:
 *
 * - `build_app_with_audit(events)` — `create_test_app` with an
 *   `on_audit_event` that pushes into the supplied array.
 * - `add_second_actor(account_id, name)` — `query_create_actor` that
 *   returns just the new actor's id (the only field the call sites use).
 *
 * @param get_db - the `describe_db` callback's `() => Db` accessor
 */
export const create_multi_actor_helpers = (
	get_db: () => Db
): {
	build_app_with_audit: (events: Array<AuditLogEvent>) => ReturnType<typeof create_test_app>;
	add_second_actor: (account_id: Uuid, name: string) => Promise<Uuid>;
} => ({
	build_app_with_audit: (events) =>
		create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
			roles: [ROLE_ADMIN],
			audit_factory: (params) =>
				create_audit_emitter({
					...params,
					on_audit_event: (event) => {
						events.push(event);
					}
				})
		}),
	add_second_actor: async (account_id, name) => {
		const actor = await query_create_actor({ db: get_db() }, account_id, name);
		return actor.id;
	}
});
