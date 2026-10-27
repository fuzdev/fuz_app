/**
 * Bridge from a notification `ActionSpec` to the SSE `EventSpec` it pushes as.
 *
 * Request/response actions are served by the RPC and WS dispatchers
 * (`actions/action_rpc.ts`, `actions/register_action_ws.ts`), never as REST
 * routes.
 *
 * @module
 */

import type { ActionSpec } from './action_spec.ts';
import type { EventSpec } from '../realtime/sse.ts';

/** Options for deriving an `EventSpec` from an `ActionSpec`. */
export interface ActionEventOptions {
	channel?: string;
}

/**
 * Derive an `EventSpec` from an `ActionSpec`.
 *
 * Only `remote_notification` actions can become push events.
 *
 * @param spec - the action spec (must have `kind: 'remote_notification'`)
 * @param options - optional event-specific options (channel)
 * @returns an `EventSpec` ready for `create_validated_broadcaster`
 * @throws Error if `spec.kind` is not `'remote_notification'`
 */
export const create_action_event_spec = (
	spec: ActionSpec,
	options?: ActionEventOptions
): EventSpec => {
	if (spec.kind !== 'remote_notification') {
		throw new Error(
			`Cannot derive event spec from action '${spec.method}': kind is '${
				spec.kind
			}' (must be 'remote_notification')`
		);
	}
	return {
		method: spec.method,
		params: spec.input,
		description: spec.description,
		channel: options?.channel
	};
};
