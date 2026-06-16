/**
 * `actor_search` RPC handler.
 *
 * Pure read — no audit, no side effects. Auth (`account: 'required'`,
 * `actor: 'none'`) + rate-limit (`account`-grain) enforced at the spec
 * layer; see `auth/actor_search_action_specs.ts` for the info-leak audit
 * and threat model.
 *
 * The handler adds two checks the spec layer can't express:
 *
 * - **Admin gate on empty `scope_ids`** — unbounded global search is
 *   admin-only. Non-admin callers without a `scope_ids` filter are
 *   rejected with `invalid_params` carrying `actor_search_scope_required`.
 *   The admin check is account-grain (any actor on the caller's account
 *   holds a global `admin` role_grant) since the `actor: 'none'` posture
 *   doesn't load `auth.role_grants` for an in-memory check.
 * - **Limit clamp** — input is bounded by `ACTOR_SEARCH_LIMIT_MAX` at
 *   the schema; the handler picks the default when omitted.
 *
 * `display_name` is omitted (not `null`) when `actor.name` is blank,
 * matching the wire shape `ActorLookupEntryJson.display_name?` — same
 * convention as `auth/actor_lookup_actions.ts`.
 *
 * @module
 */

import {jsonrpc_errors} from '../http/jsonrpc_errors.ts';
import {rpc_action, type ActionAuthContext, type RpcAction} from '../actions/action_rpc.ts';

import type {RouteFactoryDeps} from './deps.ts';
import {query_actor_search} from './actor_search_queries.ts';
import {query_account_has_global_role} from './role_grant_queries.ts';
import {ROLE_ADMIN} from './role_schema.ts';
import type {ActorLookupEntryJson} from './actor_lookup_action_specs.ts';
import {
	ACTOR_SEARCH_LIMIT_DEFAULT,
	ERROR_ACTOR_SEARCH_SCOPE_REQUIRED,
	actor_search_action_spec,
	type ActorSearchInput,
	type ActorSearchOutput,
} from './actor_search_action_specs.ts';

/** Dependencies for `create_actor_search_actions`. */
export type ActorSearchActionDeps = Pick<RouteFactoryDeps, 'log'>;

export const create_actor_search_actions = (_deps: ActorSearchActionDeps): Array<RpcAction> => {
	const handler = async (
		input: ActorSearchInput,
		ctx: ActionAuthContext,
	): Promise<ActorSearchOutput> => {
		if (!input.scope_ids || input.scope_ids.length === 0) {
			// Unbounded global search is admin-only. Account-grain admin
			// check — any actor on the caller's account holds the role.
			const is_admin = await query_account_has_global_role(ctx, ctx.auth.account.id, ROLE_ADMIN);
			if (!is_admin) {
				throw jsonrpc_errors.invalid_params('scope_ids required for non-admin callers', {
					reason: ERROR_ACTOR_SEARCH_SCOPE_REQUIRED,
				});
			}
		}

		const rows = await query_actor_search(ctx, {
			query: input.query,
			scope_ids: input.scope_ids,
			limit: input.limit ?? ACTOR_SEARCH_LIMIT_DEFAULT,
		});
		return {
			actors: rows.map((row): ActorLookupEntryJson => {
				const display_name = row.display_name?.trim();
				return {
					id: row.id,
					username: row.username,
					...(display_name ? {display_name} : {}),
				};
			}),
		};
	};
	return [rpc_action(actor_search_action_spec, handler)];
};
