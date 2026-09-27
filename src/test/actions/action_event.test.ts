/**
 * Tests for action_event.ts — ActionEvent lifecycle through the state machine.
 *
 * Uses inline test specs rather than importing from zzz.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import {
	create_action_event,
	create_action_event_from_json,
	ERROR_RESPONSE_OUTPUT_INVALID,
	type ActionEvent
} from '$lib/actions/action_event.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import type { ActionEventEnvironment } from '$lib/actions/action_event_types.ts';
import type { ActionSpecUnion } from '$lib/actions/action_spec.ts';
import type { ActionEventDataUnion } from '$lib/actions/action_event_data.ts';

// Inline test specs
const ping_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'both',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: z.null(),
	output: z.strictObject({ pong: z.literal(true) }),
	async: true,
	description: 'Health check'
} satisfies ActionSpecUnion;

const notify_spec = {
	method: 'thing_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({ id: z.string() }),
	output: z.void(),
	async: true,
	description: 'Thing changed notification'
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
	description: 'Toggle menu'
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
		assert.throws(() => create_action_event(env, notify_spec, { id: 'test' }), /cannot initiate/);
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
		const event = create_action_event(env, ping_spec, { invalid: true });

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

/** Drive a `ping` request to `receive_response` with `result` as the wire result. */
const receive_ping_result = async (env: TestEnvironment, result: unknown): Promise<ActionEvent> => {
	const event = create_action_event(env, ping_spec, null);
	event.parse();
	await event.handle_async();
	const request = event.data.request;
	assert.ok(request);
	event.transition('receive_response');
	event.set_response({ jsonrpc: '2.0', id: request.id, result } as any);
	event.parse();
	return event;
};

describe('ActionEvent receive_response output validation', () => {
	test('a result matching spec.output parses and reaches the handler', async () => {
		const env = new TestEnvironment([ping_spec]);
		let seen: unknown;
		env.add_handler('ping', 'receive_response', (event) => {
			seen = event.data.output;
		});
		const event = await receive_ping_result(env, { pong: true });
		assert.strictEqual(event.data.step, 'parsed');
		await event.handle_async();
		assert.strictEqual(event.data.step, 'handled');
		assert.deepEqual(seen, { pong: true });
		assert.deepEqual(event.data.output, { pong: true });
	});

	test('the output is the parsed value, with defaults and transforms applied', async () => {
		const spec = {
			...ping_spec,
			output: z.strictObject({ pong: z.literal(true), count: z.number().default(3) })
		} satisfies ActionSpecUnion;
		const env = new TestEnvironment([spec]);
		const event = create_action_event(env, spec, null);
		event.parse();
		await event.handle_async();
		event.transition('receive_response');
		event.set_response({ jsonrpc: '2.0', id: event.data.request!.id, result: { pong: true } });
		event.parse();
		assert.deepEqual(event.data.output, { pong: true, count: 3 });
	});

	test('a result not matching spec.output moves to receive_error with a marked internal_error', async () => {
		const env = new TestEnvironment([ping_spec]);
		let received_error: unknown;
		let response_handler_called = false;
		env.add_handler('ping', 'receive_response', () => {
			response_handler_called = true;
		});
		env.add_handler('ping', 'receive_error', (event) => {
			received_error = event.data.error;
		});
		const event = await receive_ping_result(env, { pong: 'nope', extra: 1 });
		assert.strictEqual(event.data.phase, 'receive_error');
		assert.strictEqual(event.data.output, null);
		const error = event.data.error;
		assert.ok(error);
		// distinguishable from the caller's own bad input (`invalid_params` / `validation_error`)
		assert.strictEqual(error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.include(error.message, 'response failed output validation for ping');
		const data = error.data as { reason: string; validation_errors: Array<unknown> };
		assert.strictEqual(data.reason, ERROR_RESPONSE_OUTPUT_INVALID);
		assert.ok(data.validation_errors.length > 0);
		await event.handle_async();
		assert.ok(!response_handler_called);
		assert.strictEqual(received_error, error);
	});

	test('keys spec.output does not declare are dropped, not refused', async () => {
		const env = new TestEnvironment([ping_spec]);
		const result = { pong: true, added_later: 'x' };
		const event = await receive_ping_result(env, result);
		assert.strictEqual(event.data.step, 'parsed');
		assert.deepEqual(event.data.output, { pong: true });
		assert.deepEqual(result, { pong: true, added_later: 'x' }, 'the wire value is not mutated');
	});

	test('unknown keys are dropped at every depth, arrays included', async () => {
		const spec = {
			...ping_spec,
			output: z.strictObject({
				pong: z.literal(true),
				items: z.array(z.strictObject({ id: z.number() })),
				meta: z.discriminatedUnion('kind', [
					z.strictObject({ kind: z.literal('a'), a: z.number() }),
					z.strictObject({ kind: z.literal('b') })
				])
			})
		} satisfies ActionSpecUnion;
		const env = new TestEnvironment([spec]);
		const event = create_action_event(env, spec, null);
		event.parse();
		await event.handle_async();
		event.transition('receive_response');
		event.set_response({
			jsonrpc: '2.0',
			id: event.data.request!.id,
			result: {
				pong: true,
				new_top: 1,
				items: [{ id: 1, new_item: true }, { id: 2 }],
				meta: { kind: 'a', a: 3, new_meta: null }
			}
		});
		event.parse();
		assert.strictEqual(event.data.step, 'parsed');
		assert.deepEqual(event.data.output, {
			pong: true,
			items: [{ id: 1 }, { id: 2 }],
			meta: { kind: 'a', a: 3 }
		});
	});

	test('an unknown key alongside a real mismatch still fails', async () => {
		const env = new TestEnvironment([ping_spec]);
		const event = await receive_ping_result(env, { pong: false, added_later: 'x' });
		assert.strictEqual(event.data.phase, 'receive_error');
		assert.strictEqual(
			(event.data.error?.data as { reason?: string } | undefined)?.reason,
			ERROR_RESPONSE_OUTPUT_INVALID
		);
	});

	test('a response without a result fails validation', async () => {
		const env = new TestEnvironment([ping_spec]);
		const event = await receive_ping_result(env, undefined);
		assert.strictEqual(event.data.phase, 'receive_error');
		assert.strictEqual(
			(event.data.error?.data as { reason?: string } | undefined)?.reason,
			ERROR_RESPONSE_OUTPUT_INVALID
		);
	});
});

describe('ActionEvent send_response result', () => {
	const run_receive_request = async (output_schema: z.ZodType, handler_output: unknown) => {
		const spec = { ...ping_spec, output: output_schema } satisfies ActionSpecUnion;
		const env = new TestEnvironment([spec]);
		env.executor = 'backend';
		env.add_handler('ping', 'receive_request', () => handler_output);
		const event = create_action_event(env, spec, null, 'receive_request');
		event.set_request({ jsonrpc: '2.0', id: 1, method: 'ping', params: null as any });
		await event.parse().handle_async();
		event.transition('send_response');
		await event.parse().handle_async();
		return event.data.response;
	};

	test('any JSON value goes out as the result unchanged', async () => {
		assert.deepEqual(await run_receive_request(z.null(), null), {
			jsonrpc: '2.0',
			id: 1,
			result: null
		});
		assert.deepEqual((await run_receive_request(z.number(), 7))?.result, 7);
		assert.deepEqual((await run_receive_request(z.array(z.number()), [1]))?.result, [1]);
	});

	test('a handler returning nothing sends a null result', async () => {
		assert.deepEqual(await run_receive_request(z.void(), undefined), {
			jsonrpc: '2.0',
			id: 1,
			result: null
		});
	});
});

describe('ActionEvent handler errors', () => {
	test('a plain throw keeps its message as internal_error', async () => {
		const env = new TestEnvironment([ping_spec]);
		env.add_handler('ping', 'receive_response', () => {
			throw new Error('bad session payload');
		});
		const event = await receive_ping_result(env, { pong: true });
		await event.handle_async();
		assert.strictEqual(event.data.phase, 'receive_error');
		assert.strictEqual(event.data.error?.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(event.data.error?.message, 'bad session payload');
	});

	test('a non-Error throw is stringified', async () => {
		const env = new TestEnvironment([toggle_spec]);
		env.add_handler('toggle_menu', 'execute', () => {
			throw 'plain string'; // eslint-disable-line @typescript-eslint/only-throw-error
		});
		const event = create_action_event(env, toggle_spec, null);
		event.parse().handle_sync();
		assert.strictEqual(event.data.step, 'failed');
		assert.strictEqual(event.data.error?.message, 'plain string');
	});

	test('an empty message falls back to the unknown-error message', async () => {
		const env = new TestEnvironment([toggle_spec]);
		env.add_handler('toggle_menu', 'execute', () => {
			throw new Error('');
		});
		const event = create_action_event(env, toggle_spec, null);
		event.parse().handle_sync();
		assert.strictEqual(event.data.error?.message, 'unknown error');
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

		const observations: Array<{ step: string }> = [];
		event.observe((new_data) => {
			observations.push({ step: new_data.step });
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
		event.set_data({ ...event.data, progress: 'test' } as ActionEventDataUnion);
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
			notification: null
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
		const event = create_action_event(env, ping_spec, { invalid: true });
		event.parse();
		assert.ok(event.is_complete());
	});
});
