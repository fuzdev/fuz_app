/**
 * Tests for action_event_types.ts — state machine constants and step/phase tables.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	ActionExecutor,
	ActionEventStep,
	ACTION_EVENT_STEP_TRANSITIONS,
	ACTION_EVENT_PHASE_BY_KIND,
	ACTION_EVENT_PHASE_TRANSITIONS,
} from '$lib/actions/action_event_types.js';

describe('ActionExecutor', () => {
	test('accepts frontend', () => {
		assert.ok(ActionExecutor.safeParse('frontend').success);
	});

	test('accepts backend', () => {
		assert.ok(ActionExecutor.safeParse('backend').success);
	});

	test('rejects invalid values', () => {
		assert.ok(!ActionExecutor.safeParse('other').success);
	});
});

describe('ActionEventStep', () => {
	test('accepts all valid steps', () => {
		for (const step of ['initial', 'parsed', 'handling', 'handled', 'failed']) {
			assert.ok(ActionEventStep.safeParse(step).success);
		}
	});
});

describe('ACTION_EVENT_STEP_TRANSITIONS', () => {
	test('initial can transition to parsed or failed', () => {
		assert.deepStrictEqual(ACTION_EVENT_STEP_TRANSITIONS.initial, ['parsed', 'failed']);
	});

	test('handled and failed are terminal', () => {
		assert.deepStrictEqual(ACTION_EVENT_STEP_TRANSITIONS.handled, []);
		assert.deepStrictEqual(ACTION_EVENT_STEP_TRANSITIONS.failed, []);
	});
});

describe('ACTION_EVENT_PHASE_BY_KIND', () => {
	test('request_response has 6 phases', () => {
		assert.strictEqual(ACTION_EVENT_PHASE_BY_KIND.request_response.length, 6);
	});

	test('remote_notification has send and receive', () => {
		assert.deepStrictEqual(ACTION_EVENT_PHASE_BY_KIND.remote_notification, ['send', 'receive']);
	});

	test('local_call has only execute', () => {
		assert.deepStrictEqual(ACTION_EVENT_PHASE_BY_KIND.local_call, ['execute']);
	});
});

describe('ACTION_EVENT_PHASE_TRANSITIONS', () => {
	test('send_request transitions to receive_response', () => {
		assert.strictEqual(ACTION_EVENT_PHASE_TRANSITIONS.send_request, 'receive_response');
	});

	test('terminal phases transition to null', () => {
		assert.isNull(ACTION_EVENT_PHASE_TRANSITIONS.receive_response);
		assert.isNull(ACTION_EVENT_PHASE_TRANSITIONS.send_response);
		assert.isNull(ACTION_EVENT_PHASE_TRANSITIONS.execute);
	});
});
