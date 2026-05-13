/**
 * Action event type definitions — state machine constants and environment interface.
 *
 * @module
 */

import {z} from 'zod';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {ActionEventPhase, ActionKind, ActionSpecUnion} from './action_spec.js';

export const ActionExecutor = z.enum(['frontend', 'backend']);
export type ActionExecutor = z.infer<typeof ActionExecutor>;

export const ActionEventStep = z.enum(['initial', 'parsed', 'handling', 'handled', 'failed']);
export type ActionEventStep = z.infer<typeof ActionEventStep>;

// The constants below use `Record<K, V> = {...}` rather than
// `as const satisfies Record<K, V>`. The typed annotation gives full
// completeness checking (TS rejects missing keys, excess keys, and wrong
// value types on the object literal) without narrowing lookups to literal
// tuple types — a `satisfies` shape forces every `X[k]` reader to widen
// back to `ReadonlyArray<V>` themselves to call `.includes(...)`.

export const action_event_step_transitions: Record<
	ActionEventStep,
	ReadonlyArray<ActionEventStep>
> = {
	initial: ['parsed', 'failed'],
	parsed: ['handling', 'failed'],
	handling: ['handled', 'failed'],
	handled: [],
	failed: [],
};

export const action_event_phase_by_kind: Record<ActionKind, ReadonlyArray<ActionEventPhase>> = {
	request_response: [
		'send_request',
		'receive_request',
		'send_response',
		'receive_response',
		'send_error',
		'receive_error',
	],
	remote_notification: ['send', 'receive'],
	local_call: ['execute'],
};

export const action_event_phase_transitions: Record<ActionEventPhase, ActionEventPhase | null> = {
	send_request: 'receive_response',
	receive_request: 'send_response',
	send_response: null,
	receive_response: null,
	send_error: null,
	receive_error: null,
	send: null,
	receive: null,
	execute: null,
};

export interface ActionEventEnvironment {
	readonly executor: ActionExecutor;
	lookup_action_handler: (
		method: string,
		phase: ActionEventPhase,
	) => ((event: any) => any) | undefined;
	lookup_action_spec: (method: string) => ActionSpecUnion | undefined;
	readonly log?: Logger | null;
}
