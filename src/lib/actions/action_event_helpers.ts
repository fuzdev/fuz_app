/**
 * Action event helper functions — type guards, validators, and data creation.
 *
 * @module
 */

import type {Result} from '@fuzdev/fuz_util/result.js';

import {
	type ActionEventStep,
	type ActionExecutor,
	ACTION_EVENT_STEP_TRANSITIONS,
	ACTION_EVENT_PHASE_BY_KIND,
	ACTION_EVENT_PHASE_TRANSITIONS,
} from './action_event_types.js';
import type {
	ActionEventData,
	ActionEventRequestResponseData,
	ActionEventRemoteNotificationData,
	ActionEventLocalCallData,
} from './action_event_data.js';
import type {ActionEventPhase, ActionInitiator, ActionKind} from './action_spec.js';
import type {JsonrpcErrorObject} from '../http/jsonrpc.js';
import type {ActionEvent} from './action_event.js';

// Type guards for action kinds
export const is_request_response = (
	data: ActionEventData,
): data is ActionEventRequestResponseData => data.kind === 'request_response';

export const is_remote_notification = (
	data: ActionEventData,
): data is ActionEventRemoteNotificationData => data.kind === 'remote_notification';

export const is_local_call = (data: ActionEventData): data is ActionEventLocalCallData =>
	data.kind === 'local_call';

// Type guards for specific states
export const is_send_request = (
	data: ActionEventData,
): data is ActionEventRequestResponseData & {phase: 'send_request'} =>
	data.kind === 'request_response' && data.phase === 'send_request';

export const is_receive_request = (
	data: ActionEventData,
): data is ActionEventRequestResponseData & {phase: 'receive_request'} =>
	data.kind === 'request_response' && data.phase === 'receive_request';

export const is_send_response = (
	data: ActionEventData,
): data is ActionEventRequestResponseData & {phase: 'send_response'} =>
	data.kind === 'request_response' && data.phase === 'send_response';

export const is_receive_response = (
	data: ActionEventData,
): data is ActionEventRequestResponseData & {phase: 'receive_response'} =>
	data.kind === 'request_response' && data.phase === 'receive_response';

export const is_notification_send = (
	data: ActionEventData,
): data is ActionEventRemoteNotificationData & {phase: 'send'} =>
	data.kind === 'remote_notification' && data.phase === 'send';

export const is_notification_receive = (
	data: ActionEventData,
): data is ActionEventRemoteNotificationData & {phase: 'receive'} =>
	data.kind === 'remote_notification' && data.phase === 'receive';

export const is_execute = (
	data: ActionEventData,
): data is ActionEventLocalCallData & {phase: 'execute'} =>
	data.kind === 'local_call' && data.phase === 'execute';

// Step state guards
export const is_initial = (data: ActionEventData): data is ActionEventData & {step: 'initial'} =>
	data.step === 'initial';

export const is_parsed = (data: ActionEventData): data is ActionEventData & {step: 'parsed'} =>
	data.step === 'parsed';

export const is_handling = (data: ActionEventData): data is ActionEventData & {step: 'handling'} =>
	data.step === 'handling';

export const is_handled = (data: ActionEventData): data is ActionEventData & {step: 'handled'} =>
	data.step === 'handled';

export const is_failed = (data: ActionEventData): data is ActionEventData & {step: 'failed'} =>
	data.step === 'failed';

// Combined type guards for specific states with parsed input
// These check for 'parsed' or 'handling' steps since protocol messages
// are created when transitioning from 'parsed' to 'handling'
export const is_send_request_with_parsed_input = <TMethod extends string = string>(
	data: ActionEventData,
): data is ActionEventRequestResponseData<TMethod> & {
	phase: 'send_request';
	step: 'parsed' | 'handling';
	input: unknown;
} => is_send_request(data) && (data.step === 'parsed' || data.step === 'handling');

export const is_notification_send_with_parsed_input = <TMethod extends string = string>(
	data: ActionEventData,
): data is ActionEventRemoteNotificationData<TMethod> & {
	phase: 'send';
	step: 'parsed' | 'handling';
	input: unknown;
} => is_notification_send(data) && (data.step === 'parsed' || data.step === 'handling');

// Validation helpers
export const validate_step_transition = (from: ActionEventStep, to: ActionEventStep): void => {
	const valid_transitions = ACTION_EVENT_STEP_TRANSITIONS[from];
	if (!valid_transitions.includes(to)) {
		throw new Error(`Invalid step transition from '${from}' to '${to}'`);
	}
};

export const validate_phase_for_kind = (kind: ActionKind, phase: ActionEventPhase): void => {
	const valid_phases = ACTION_EVENT_PHASE_BY_KIND[kind];
	if (!valid_phases.includes(phase)) {
		throw new Error(`Invalid phase '${phase}' for ${kind} action`);
	}
};

export const validate_phase_transition = (from: ActionEventPhase, to: ActionEventPhase): void => {
	const expected = ACTION_EVENT_PHASE_TRANSITIONS[from];
	if (expected !== to) {
		throw new Error(`Invalid phase transition from '${from}' to '${to}'`);
	}
};

export const get_initial_phase = (
	kind: ActionKind,
	initiator: ActionInitiator,
	executor: ActionExecutor,
): ActionEventPhase | null => {
	if (initiator !== 'both' && initiator !== executor) return null;

	switch (kind) {
		case 'request_response':
			return 'send_request';
		case 'remote_notification':
			return 'send';
		case 'local_call':
			return 'execute';
	}
};

export const should_validate_output = (kind: ActionKind, phase: ActionEventPhase): boolean =>
	(kind === 'request_response' && (phase === 'receive_request' || phase === 'receive_response')) ||
	(kind === 'local_call' && phase === 'execute');

export const is_action_complete = (data: ActionEventData): boolean => {
	if (data.step === 'failed') return true;
	if (data.step !== 'handled') return false;

	// Check if in terminal phase
	const next_phase = ACTION_EVENT_PHASE_TRANSITIONS[data.phase];
	return next_phase === null;
};

export const create_initial_data = (
	kind: ActionKind,
	phase: ActionEventPhase,
	method: string,
	executor: ActionExecutor,
	input: unknown,
): ActionEventData => ({
	kind,
	phase,
	step: 'initial',
	method,
	executor,
	input,
	output: null,
	error: null,
	progress: null,
	request: null,
	response: null,
	notification: null,
});

export const extract_action_result = (
	event: ActionEvent,
): Result<{value: ActionEventData['output']}, {error: JsonrpcErrorObject}> => {
	const {data} = event;

	if (data.step === 'handled') {
		return {ok: true, value: data.output};
	}

	if (data.step === 'failed') {
		return {ok: false, error: data.error};
	}

	// Programming error - event not in terminal state
	throw new Error(`cannot extract result: event in non-terminal state (step: ${data.step})`);
};
