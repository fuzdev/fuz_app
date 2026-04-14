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

export const ACTION_EVENT_STEP_TRANSITIONS = {
	initial: ['parsed', 'failed'],
	parsed: ['handling', 'failed'],
	handling: ['handled', 'failed'],
	handled: [],
	failed: [],
} as Record<ActionEventStep, ReadonlyArray<ActionEventStep>>;

export const ACTION_EVENT_PHASE_BY_KIND = {
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
} as Record<ActionKind, ReadonlyArray<ActionEventPhase>>;

export const ACTION_EVENT_PHASE_TRANSITIONS = {
	send_request: 'receive_response',
	receive_request: 'send_response',
	send_response: null,
	receive_response: null,
	send_error: null,
	receive_error: null,
	send: null,
	receive: null,
	execute: null,
} as Record<ActionEventPhase, ActionEventPhase | null>;

export interface ActionEventEnvironment {
	readonly executor: ActionExecutor;
	lookup_action_handler: (
		method: string,
		phase: ActionEventPhase,
	) => ((event: any) => any) | undefined;
	lookup_action_spec: (method: string) => ActionSpecUnion | undefined;
	readonly log?: Logger | null;
}
