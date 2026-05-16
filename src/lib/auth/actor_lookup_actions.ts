/**
 * `actor_lookup` RPC handler.
 *
 * Pure read — no audit, no side effects. Auth (`account: 'required'`) +
 * rate-limit (`account`-grain) enforced at the spec layer; see
 * `auth/actor_lookup_action_specs.ts` for the info-leak audit.
 *
 * `display_name` is omitted (not `null`) when `actor.name` is blank,
 * matching the wire shape `display_name?` so the typed client sees an
 * `undefined` rather than a sentinel string.
 *
 * @module
 */

import {rpc_action, type ActionContext, type RpcAction} from '../actions/action_rpc.js';

import type {RouteFactoryDeps} from './deps.js';
import {query_actors_by_ids} from './actor_lookup_queries.js';
import {
	actor_lookup_action_spec,
	type ActorLookupInput,
	type ActorLookupOutput,
	type ActorLookupEntryJson,
} from './actor_lookup_action_specs.js';

/** Dependencies for `create_actor_lookup_actions`. */
export type ActorLookupActionDeps = Pick<RouteFactoryDeps, 'log'>;

export const create_actor_lookup_actions = (_deps: ActorLookupActionDeps): Array<RpcAction> => {
	const handler = async (
		input: ActorLookupInput,
		ctx: ActionContext,
	): Promise<ActorLookupOutput> => {
		const rows = await query_actors_by_ids(ctx, input.ids);
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
	return [rpc_action(actor_lookup_action_spec, handler)];
};
