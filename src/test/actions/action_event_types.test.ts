/**
 * Tests for action_event_types.ts — state machine constants and step/phase tables.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import {
	ActionExecutor,
	ActionEventStep,
	action_event_step_transitions,
	action_event_phase_by_kind,
	action_event_phase_transitions
} from '#lib/actions/action_event_types.ts';

describe('ActionExecutor', () => {
	test('accepts frontend', () => {
		assert.ok(is(ActionExecutor, 'frontend'));
	});

	test('accepts backend', () => {
		assert.ok(is(ActionExecutor, 'backend'));
	});

	test('rejects invalid values', () => {
		assert.ok(!is(ActionExecutor, 'other'));
	});
});

describe('ActionEventStep', () => {
	test('accepts all valid steps', () => {
		for (const step of ['initial', 'parsed', 'handling', 'handled', 'failed']) {
			assert.ok(is(ActionEventStep, step));
		}
	});
});

describe('action_event_step_transitions', () => {
	test('initial can transition to parsed or failed', () => {
		assert.deepStrictEqual(action_event_step_transitions.initial, ['parsed', 'failed']);
	});

	test('handled and failed are terminal', () => {
		assert.deepStrictEqual(action_event_step_transitions.handled, []);
		assert.deepStrictEqual(action_event_step_transitions.failed, []);
	});
});

describe('action_event_phase_by_kind', () => {
	test('request_response has 6 phases', () => {
		assert.strictEqual(action_event_phase_by_kind.request_response.length, 6);
	});

	test('remote_notification has send and receive', () => {
		assert.deepStrictEqual(action_event_phase_by_kind.remote_notification, ['send', 'receive']);
	});

	test('local_call has only execute', () => {
		assert.deepStrictEqual(action_event_phase_by_kind.local_call, ['execute']);
	});
});

describe('action_event_phase_transitions', () => {
	test('send_request transitions to receive_response', () => {
		assert.strictEqual(action_event_phase_transitions.send_request, 'receive_response');
	});

	test('terminal phases transition to null', () => {
		assert.isNull(action_event_phase_transitions.receive_response);
		assert.isNull(action_event_phase_transitions.send_response);
		assert.isNull(action_event_phase_transitions.execute);
	});
});
