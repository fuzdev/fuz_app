/**
 * Tests for action_event_helpers.ts — type guards, validators, and data creation.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {JSONRPC_INTERNAL_ERROR} from '$lib/http/jsonrpc.js';
import type {ActionEventData, ActionEventDataUnion} from '$lib/actions/action_event_data.js';
import {
	is_request_response,
	is_remote_notification,
	is_local_call,
	is_send_request,
	is_notification_send,
	is_initial,
	is_parsed,
	is_handled,
	is_failed,
	validate_step_transition,
	validate_phase_for_kind,
	validate_phase_transition,
	get_initial_phase,
	should_validate_output,
	is_action_complete,
	create_initial_data,
	extract_action_result,
} from '$lib/actions/action_event_helpers.js';
import {ActionEvent} from '$lib/actions/action_event.js';
import type {ActionEventEnvironment} from '$lib/actions/action_event_types.js';
import type {RequestResponseActionSpec} from '$lib/actions/action_spec.js';

describe('kind type guards', () => {
	test('is_request_response', () => {
		const data = create_initial_data('request_response', 'send_request', 'test', 'frontend', null);
		assert.ok(is_request_response(data));
		assert.ok(!is_remote_notification(data));
		assert.ok(!is_local_call(data));
	});

	test('is_remote_notification', () => {
		const data = create_initial_data('remote_notification', 'send', 'test', 'backend', null);
		assert.ok(is_remote_notification(data));
		assert.ok(!is_request_response(data));
	});

	test('is_local_call', () => {
		const data = create_initial_data('local_call', 'execute', 'test', 'frontend', null);
		assert.ok(is_local_call(data));
	});
});

describe('phase type guards', () => {
	test('is_send_request', () => {
		const data = create_initial_data('request_response', 'send_request', 'test', 'frontend', null);
		assert.ok(is_send_request(data));
	});

	test('is_notification_send', () => {
		const data = create_initial_data('remote_notification', 'send', 'test', 'backend', null);
		assert.ok(is_notification_send(data));
	});
});

describe('step type guards', () => {
	test('is_initial for initial data', () => {
		const data = create_initial_data('request_response', 'send_request', 'test', 'frontend', null);
		assert.ok(is_initial(data));
		assert.ok(!is_parsed(data));
		assert.ok(!is_handled(data));
		assert.ok(!is_failed(data));
	});
});

describe('validate_step_transition', () => {
	test('allows initial → parsed', () => {
		assert.doesNotThrow(() => validate_step_transition('initial', 'parsed'));
	});

	test('allows initial → failed', () => {
		assert.doesNotThrow(() => validate_step_transition('initial', 'failed'));
	});

	test('rejects initial → handled', () => {
		assert.throws(() => validate_step_transition('initial', 'handled'), /Invalid step transition/);
	});

	test('rejects handled → anything', () => {
		assert.throws(() => validate_step_transition('handled', 'failed'), /Invalid step transition/);
	});
});

describe('validate_phase_for_kind', () => {
	test('allows send_request for request_response', () => {
		assert.doesNotThrow(() => validate_phase_for_kind('request_response', 'send_request'));
	});

	test('rejects execute for request_response', () => {
		assert.throws(() => validate_phase_for_kind('request_response', 'execute'), /Invalid phase/);
	});
});

describe('validate_phase_transition', () => {
	test('allows send_request → receive_response', () => {
		assert.doesNotThrow(() => validate_phase_transition('send_request', 'receive_response'));
	});

	test('rejects send_request → send_response', () => {
		assert.throws(
			() => validate_phase_transition('send_request', 'send_response'),
			/Invalid phase transition/,
		);
	});
});

describe('get_initial_phase', () => {
	test('frontend executor for frontend-initiated request_response', () => {
		assert.strictEqual(
			get_initial_phase('request_response', 'frontend', 'frontend'),
			'send_request',
		);
	});

	test('backend cannot initiate frontend-only action', () => {
		assert.isNull(get_initial_phase('request_response', 'frontend', 'backend'));
	});

	test('both initiator works for either executor', () => {
		assert.strictEqual(get_initial_phase('request_response', 'both', 'frontend'), 'send_request');
		assert.strictEqual(get_initial_phase('request_response', 'both', 'backend'), 'send_request');
	});

	test('local_call returns execute', () => {
		assert.strictEqual(get_initial_phase('local_call', 'frontend', 'frontend'), 'execute');
	});

	test('remote_notification returns send', () => {
		assert.strictEqual(get_initial_phase('remote_notification', 'backend', 'backend'), 'send');
	});
});

describe('should_validate_output', () => {
	test('validates on receive_request', () => {
		assert.ok(should_validate_output('request_response', 'receive_request'));
	});

	test('validates on receive_response', () => {
		assert.ok(should_validate_output('request_response', 'receive_response'));
	});

	test('validates on local_call execute', () => {
		assert.ok(should_validate_output('local_call', 'execute'));
	});

	test('does not validate on send_request', () => {
		assert.ok(!should_validate_output('request_response', 'send_request'));
	});
});

describe('is_action_complete', () => {
	test('failed is complete', () => {
		const data = {
			...create_initial_data('request_response', 'send_request', 'test', 'frontend', null),
			step: 'failed' as const,
			error: {code: JSONRPC_INTERNAL_ERROR, message: 'test'},
		} as ActionEventData;
		assert.ok(is_action_complete(data));
	});

	test('handled in terminal phase is complete', () => {
		const data = {
			...create_initial_data('request_response', 'receive_response', 'test', 'frontend', null),
			step: 'handled' as const,
		};
		assert.ok(is_action_complete(data));
	});

	test('handled in non-terminal phase is not complete', () => {
		const data = {
			...create_initial_data('request_response', 'send_request', 'test', 'frontend', null),
			step: 'handled' as const,
		};
		assert.ok(!is_action_complete(data));
	});
});

describe('create_initial_data', () => {
	test('creates data with all expected fields', () => {
		const data = create_initial_data('request_response', 'send_request', 'my_method', 'frontend', {
			foo: 'bar',
		});
		assert.strictEqual(data.kind, 'request_response');
		assert.strictEqual(data.phase, 'send_request');
		assert.strictEqual(data.step, 'initial');
		assert.strictEqual(data.method, 'my_method');
		assert.strictEqual(data.executor, 'frontend');
		assert.deepStrictEqual(data.input, {foo: 'bar'});
		assert.isNull(data.output);
		assert.isNull(data.error);
		assert.isNull(data.progress);
		assert.isNull(data.request);
		assert.isNull(data.response);
		assert.isNull(data.notification);
	});
});

describe('extract_action_result', () => {
	const spec = {
		method: 'test',
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
		side_effects: false,
		async: true,
		input: z.strictObject({}),
		output: z.strictObject({n: z.number()}),
		description: 'test',
	} satisfies RequestResponseActionSpec;
	const environment: ActionEventEnvironment = {
		executor: 'frontend',
		lookup_action_spec: () => undefined,
		lookup_action_handler: () => undefined,
	};

	test('handled step on success returns ok=true with value', () => {
		const data = {
			...create_initial_data('request_response', 'receive_response', 'test', 'frontend', {}),
			step: 'handled' as const,
			output: {n: 1},
		} as ActionEventDataUnion;
		const event = new ActionEvent(environment, spec, data);
		const result = extract_action_result(event);
		assert.deepStrictEqual(result, {ok: true, value: {n: 1}});
	});

	test('failed step returns ok=false with error', () => {
		const data = {
			...create_initial_data('request_response', 'send_request', 'test', 'frontend', {}),
			step: 'failed' as const,
			error: {code: JSONRPC_INTERNAL_ERROR, message: 'boom'},
		} as ActionEventDataUnion;
		const event = new ActionEvent(environment, spec, data);
		const result = extract_action_result(event);
		assert.deepStrictEqual(result, {
			ok: false,
			error: {code: JSONRPC_INTERNAL_ERROR, message: 'boom'},
		});
	});

	// Regression: when a JSON-RPC error response arrives and no `receive_error`
	// handler is registered, the event reaches step=handled at phase=receive_error
	// with data.error populated and data.output null. extract_action_result
	// previously returned {ok: true, value: null}, surprising every consumer.
	test('receive_error handled with no handler returns ok=false', () => {
		const data = {
			...create_initial_data('request_response', 'receive_error', 'test', 'frontend', {}),
			step: 'handled' as const,
			error: {code: JSONRPC_INTERNAL_ERROR, message: 'server error'},
		} as ActionEventDataUnion;
		const event = new ActionEvent(environment, spec, data);
		const result = extract_action_result(event);
		assert.deepStrictEqual(result, {
			ok: false,
			error: {code: JSONRPC_INTERNAL_ERROR, message: 'server error'},
		});
	});

	test('send_error handled with no handler returns ok=false', () => {
		const data = {
			...create_initial_data('request_response', 'send_error', 'test', 'frontend', {}),
			step: 'handled' as const,
			error: {code: JSONRPC_INTERNAL_ERROR, message: 'send failed'},
		} as ActionEventDataUnion;
		const event = new ActionEvent(environment, spec, data);
		const result = extract_action_result(event);
		assert.deepStrictEqual(result, {
			ok: false,
			error: {code: JSONRPC_INTERNAL_ERROR, message: 'send failed'},
		});
	});

	test('non-terminal step throws', () => {
		const data = create_initial_data(
			'request_response',
			'send_request',
			'test',
			'frontend',
			{},
		) as ActionEventDataUnion;
		const event = new ActionEvent(environment, spec, data);
		assert.throws(() => extract_action_result(event), /non-terminal/);
	});
});
