/**
 * Canonical bundles of fuz_app's protocol actions — `heartbeat`, `cancel`,
 * and `peer/ping`. Spread these into consumer registrations on both sides of
 * the wire so the registries stay symmetric without per-consumer plumbing.
 *
 * Protocol actions are wire-protocol concerns (liveness, abort) shipped by
 * fuz_app, not consumer domain logic. The split is intentional: the server
 * needs `{spec, handler}` tuples to drive dispatch; the frontend
 * `ActionRegistry` only stores specs. The codegen
 * `include_protocol_actions: false` default (in `actions/action_codegen.ts`) is the
 * third leg of this contract — protocol actions are excluded from
 * generated typed surfaces because consumers spread them in at
 * registration time.
 *
 * Adding a future protocol action (e.g. clock-skew probe, reconnect-resume
 * token) means appending to these arrays in one place; no consumer
 * migration required.
 *
 * @module
 */

import type { ActionSpecUnion } from './action_spec.ts';
import type { Action } from './action_types.ts';
import { cancel_action } from './cancel.ts';
import { heartbeat_action } from './heartbeat.ts';
import { peer_ping_action } from './peer_ping.ts';

/**
 * Canonical protocol `{spec, handler}` tuples for the server's
 * `register_action_ws` `actions` array. Spread before consumer-owned actions
 * so disconnect detection and per-request cancel work uniformly:
 *
 * ```ts
 * register_action_ws({actions: [...protocol_actions, ...consumer_actions], ...})
 * ```
 */
export const protocol_actions: ReadonlyArray<Action> = [
	heartbeat_action,
	cancel_action,
	peer_ping_action
];

/**
 * Canonical protocol specs for `ActionRegistry` construction on the
 * frontend. Spread before consumer-owned specs so dispatcher-owned methods
 * are present in the lookup map even though codegen excludes them from the
 * generated `action_specs` array:
 *
 * ```ts
 * new ActionRegistry([...protocol_action_specs, ...action_specs])
 * ```
 *
 * Derived from `protocol_actions` so a future protocol action lands in one
 * place — the two arrays cannot drift.
 */
export const protocol_action_specs: ReadonlyArray<ActionSpecUnion> = protocol_actions.map(
	(a) => a.spec
);
