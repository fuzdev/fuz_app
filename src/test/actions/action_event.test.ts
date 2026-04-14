/**
 * Tests for action_event.ts — ActionEvent lifecycle through the state machine.
 *
 * Uses inline test specs rather than importing from zzz.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {create_action_event, create_action_event_from_json} from '$lib/actions/action_event.js';
import type {ActionEventEnvironment} from '$lib/actions/action_event_types.js';
import type {ActionSpecUnion} from '$lib/actions/action_spec.js';
import type {ActionEventDataUnion} from '$lib/actions/action_event_data.js';

// Inline test specs
const ping_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'both',
	auth: 'public',
	side_effects: false,
	input: z.null(),
	output: z.strictObject({pong: z.literal(true)}),
	async: true,
	description: 'Health check',
} satisfies ActionSpecUnion;

const notify_spec = {
	method: 'thing_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({id: z.string()}),
	output: z.void(),
	async: true,
	description: 'Thing changed notification',
} satisfies ActionSpecUnion;

const toggle_spec = {
	method: 'toggle_menu',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: false,
	description: 'Toggle menu',
} satisfies ActionSpecUnion;

// Test environment
class TestEnvironment implements ActionEventEnvironment {
	executor: 'frontend' | 'backend' = 'frontend';
	handlers: Map<string, Map<string, (event: any) => any>> = new Map();
	specs: Map<string, ActionSpecUnion> = new Map();

	constructor(specs: Array<ActionSpecUnion> = []) {
		for (const spec of specs) {
			this.specs.set(spec.method, spec);
		}
	}

	lookup_action_handler(method: string, phase: string): ((event: any) => any) | undefined {
		return this.handlers.get(method)?.get(phase);
	}

	lookup_action_spec(method: string): ActionSpecUnion | undefined {
		return this.specs.get(method);
	}

	add_handler(method: string, phase: string, handler: (event: any) => any): void {
		if (!this.handlers.has(method)) {
			this.handlers.set(method, new Map());
		}
		this.handlers.get(method)!.set(phase, handler);
	}
}

describe('ActionEvent creation', () => {
	test('creates event with initial state', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);

		assert.strictEqual(event.data.kind, 'request_response');
		assert.strictEqual(event.data.phase, 'send_request');
		assert.strictEqual(event.data.step, 'initial');
		assert.strictEqual(event.data.method, 'ping');
		assert.strictEqual(event.data.executor, 'frontend');
		assert.isNull(event.data.output);
		assert.isNull(event.data.error);
		assert.isNull(event.data.request);
	});

	test('throws for wrong executor', () => {
		const env = new TestEnvironment([notify_spec]);
		// backend initiator, but executor is frontend
		assert.throws(() => create_action_event(env, notify_spec, {id: 'test'}), /cannot initiate/);
	});

	test('creates local_call event', () => {
		const env = new TestEnvironment([toggle_spec]);
		const event = create_action_event(env, toggle_spec, null);

		assert.strictEqual(event.data.kind, 'local_call');
		assert.strictEqual(event.data.phase, 'execute');
		assert.strictEqual(event.data.step, 'initial');
	});
});

describe('ActionEvent parse', () => {
	test('parse transitions to parsed step', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);

		event.parse();
		assert.strictEqual(event.data.step, 'parsed');
	});

	test('parse fails with invalid input', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, {invalid: true});

		event.parse();
		assert.strictEqual(event.data.step, 'failed');
		assert.ok(event.data.error);
	});

	test('parse throws if not at initial step', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);
		event.parse();

		assert.throws(() => event.parse(), /must be 'initial'/);
	});
});

describe('ActionEvent handle_async', () => {
	test('transitions to handled with no handler', async () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);

		event.parse();
		await event.handle_async();

		assert.strictEqual(event.data.step, 'handled');
	});

	test('calls handler and transitions to handled', async () => {
		const env = new TestEnvironment([ping_spec]);
		let called = false;
		env.add_handler('ping', 'send_request', () => {
			called = true;
			return undefined;
		});

		const event = create_action_event(env, ping_spec, null);
		event.parse();
		await event.handle_async();

		assert.ok(called);
		assert.strictEqual(event.data.step, 'handled');
	});

	test('creates JSON-RPC request during handling', async () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);

		event.parse();
		await event.handle_async();

		const request = event.data.request;
		assert.ok(request);
		assert.strictEqual(request.method, 'ping');
		assert.strictEqual(request.jsonrpc, '2.0');
	});
});

describe('ActionEvent handle_sync', () => {
	test('works for sync local_call', () => {
		const env = new TestEnvironment([toggle_spec]);
		const event = create_action_event(env, toggle_spec, null);

		event.parse();
		event.handle_sync();

		assert.strictEqual(event.data.step, 'handled');
	});

	test('throws for non-local_call actions', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);
		event.parse();

		assert.throws(() => event.handle_sync(), /synchronous local_call/);
	});
});

describe('ActionEvent observe', () => {
	test('notifies observers on data change', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);

		const observations: Array<{step: string}> = [];
		event.observe((new_data) => {
			observations.push({step: new_data.step});
		});

		event.parse();
		assert.strictEqual(observations.length, 1);
		assert.strictEqual(observations[0]!.step, 'parsed');
	});

	test('unsubscribe stops notifications', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);

		let count = 0;
		const unsub = event.observe(() => count++);

		event.parse();
		assert.strictEqual(count, 1);

		unsub();
		// Trigger another change by manipulating data directly
		event.set_data({...event.data, progress: 'test'} as ActionEventDataUnion);
		assert.strictEqual(count, 1); // not incremented
	});
});

describe('ActionEvent toJSON', () => {
	test('returns a deep clone of data', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);

		const json = event.toJSON();
		assert.deepStrictEqual(json, event.data);
		assert.notStrictEqual(json, event.data); // different reference
	});
});

describe('create_action_event_from_json', () => {
	test('reconstructs event from serialized data', () => {
		const env = new TestEnvironment([ping_spec]);
		const original = create_action_event(env, ping_spec, null);
		const json = original.toJSON();

		const restored = create_action_event_from_json(json, env);
		assert.deepStrictEqual(restored.data, original.data);
	});

	test('throws for unknown method', () => {
		const env = new TestEnvironment([]);
		const data = {
			kind: 'request_response' as const,
			phase: 'send_request' as const,
			step: 'initial' as const,
			method: 'unknown_method',
			executor: 'frontend' as const,
			input: null,
			output: null,
			error: null,
			progress: null,
			request: null,
			response: null,
			notification: null,
		};

		assert.throws(() => create_action_event_from_json(data, env), /no spec found/);
	});
});

describe('ActionEvent is_complete', () => {
	test('not complete at initial', () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);
		assert.ok(!event.is_complete());
	});

	test('complete after full request_response lifecycle at handled in terminal phase', async () => {
		const env = new TestEnvironment([ping_spec]);
		const event = create_action_event(env, ping_spec, null);
		event.parse();
		await event.handle_async();

		// send_request handled — not complete (not terminal phase)
		assert.ok(!event.is_complete());
	});

	test('complete after failure', () => {
		const env = new TestEnvironment([ping_spec]);
		// Give invalid input to trigger failure
		const event = create_action_event(env, ping_spec, {invalid: true});
		event.parse();
		assert.ok(event.is_complete());
	});
});
