/**
 * Action event helper functions — type guards, validators, and data creation.
 *
 * @module
 */

import type {Result} from '@fuzdev/fuz_util/result.js';

import {
	type ActionEventStep,
	type ActionExecutor,
	action_event_step_transitions,
	action_event_phase_by_kind,
	action_event_phase_transitions,
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

/**
 * Validate that a step transition is legal per `action_event_step_transitions`.
 *
 * @throws Error if `from → to` is not a permitted transition
 */
export const validate_step_transition = (from: ActionEventStep, to: ActionEventStep): void => {
	if (!action_event_step_transitions[from].includes(to)) {
		throw new Error(`Invalid step transition from '${from}' to '${to}'`);
	}
};

/**
 * Validate that `phase` is one of the phases allowed for `kind` per
 * `action_event_phase_by_kind`.
 *
 * @throws Error if `phase` is not valid for `kind`
 */
export const validate_phase_for_kind = (kind: ActionKind, phase: ActionEventPhase): void => {
	if (!action_event_phase_by_kind[kind].includes(phase)) {
		throw new Error(`Invalid phase '${phase}' for ${kind} action`);
	}
};

/**
 * Validate that a phase chain is legal per `action_event_phase_transitions`.
 *
 * @throws Error if `from → to` is not the permitted next phase (or `from` is terminal)
 */
export const validate_phase_transition = (from: ActionEventPhase, to: ActionEventPhase): void => {
	const expected = action_event_phase_transitions[from];
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
	const next_phase = action_event_phase_transitions[data.phase];
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

/**
 * Pull the terminal `Result` from an action event.
 *
 * `data.error` populated → error path (covers both explicit `failed` and
 * the unhandled `receive_error` / `send_error` case where no handler was
 * registered for the error phase). `step === 'handled'` → success path.
 *
 * @throws Error if the event is in a non-terminal state (programming error —
 *   callers should check `is_action_complete` first)
 */
export const extract_action_result = (
	event: ActionEvent,
): Result<{value: ActionEventData['output']}, {error: JsonrpcErrorObject}> => {
	const {data} = event;

	// `data.error` populated → error path. This covers two cases:
	// 1. `step === 'failed'` — explicit terminal failure.
	// 2. `phase === 'receive_error' | 'send_error'` reached `step === 'handled'`
	//    because no handler was registered for the error phase. The dispatcher
	//    silently transitions to `handled` in that case but leaves `data.error`
	//    populated. Reading `step === 'handled'` first would return
	//    `{ok: true, value: null}` and surprise every caller that doesn't
	//    register an error-phase handler. Preferring `data.error` lets
	//    consumers skip the boilerplate `receive_error` rethrow stub.
	if (data.error) {
		return {ok: false, error: data.error};
	}

	if (data.step === 'handled') {
		return {ok: true, value: data.output};
	}

	// `step === 'failed'` with `data.error === null` is a malformed event;
	// type narrowing accepts it, runtime never produces it.
	throw new Error(`cannot extract result: event in non-terminal state (step: ${data.step})`);
};
