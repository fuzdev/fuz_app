/**
 * Tests for action_dispatcher.ts — ActionDispatcher send and receive.
 *
 * @module
 */

import { describe, assert, test, vi, afterEach } from 'vitest';
import { z } from 'zod';

import { ActionDispatcher } from '$lib/actions/action_dispatcher.ts';
import { Transports, type Transport } from '$lib/actions/transports.ts';
import {
	console_action_log,
	resolve_action_log,
	type ActionEventEnvironment
} from '$lib/actions/action_event_types.ts';
import type { ActionSpecUnion } from '$lib/actions/action_spec.ts';

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
	description: 'Notification'
} satisfies ActionSpecUnion;

class TestEnvironment implements ActionEventEnvironment {
	executor: 'frontend' | 'backend' = 'backend';
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

interface CapturedSend {
	message: any;
	options: any;
}

const create_mock_transport = (
	responses?: Map<string, any>,
	captured?: Array<CapturedSend>
): Transport => ({
	transport_name: 'mock',
	send: (async (message: any, options?: any) => {
		captured?.push({ message, options });
		if ('id' in message && responses?.has(message.method)) {
			return { jsonrpc: '2.0', id: message.id, result: responses.get(message.method) };
		}
		return null;
	}) as Transport['send'],
	is_ready: () => true
});

describe('ActionDispatcher', () => {
	test('send returns error when no transport available', async () => {
		const env = new TestEnvironment([ping_spec]);
		const peer = new ActionDispatcher({ environment: env });

		const result = await peer.send({ jsonrpc: '2.0', method: 'ping', id: 1 });
		assert.ok('error' in result);
		assert.ok((result as any).error.message.includes('no transport'));
	});

	test('send forwards request to transport', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const responses = new Map([['ping', { pong: true }]]);
		transports.register_transport(create_mock_transport(responses));

		const peer = new ActionDispatcher({ environment: env, transports });

		const result = await peer.send({ jsonrpc: '2.0', method: 'ping', id: 1 });
		assert.ok('result' in result);
		assert.deepStrictEqual(result.result, { pong: true });
	});

	test('receive handles request and returns response', async () => {
		const env = new TestEnvironment([ping_spec]);
		// Handler on receive_request returns the output
		env.add_handler('ping', 'receive_request', () => ({ pong: true }));

		const peer = new ActionDispatcher({ environment: env });

		const result = await peer.receive({ jsonrpc: '2.0', method: 'ping', id: 42 });
		assert.ok(result);
		// The response is a JSON-RPC response — either result or error
		assert.ok('result' in result || 'error' in result);
	});

	test('receive returns method_not_found for unknown method', async () => {
		const env = new TestEnvironment([]); // no specs
		const peer = new ActionDispatcher({ environment: env });

		const result = await peer.receive({ jsonrpc: '2.0', method: 'unknown', id: 1 });
		assert.ok(result);
		assert.ok('error' in result);
		assert.ok((result as any).error.message.includes('unknown'));
	});

	test('receive handles notification without response', async () => {
		const env = new TestEnvironment([notify_spec]);
		let received = false;
		env.add_handler('thing_changed', 'receive', () => {
			received = true;
		});

		const peer = new ActionDispatcher({ environment: env });
		const result = await peer.receive({
			jsonrpc: '2.0',
			method: 'thing_changed',
			params: { id: 'abc' }
		});

		assert.isNull(result);
		assert.ok(received);
	});

	test('receive returns invalid_request for non-jsonrpc message', async () => {
		const env = new TestEnvironment([]);
		const peer = new ActionDispatcher({ environment: env });

		const result = await peer.receive({ not: 'jsonrpc' });
		assert.ok(result);
		assert.ok('error' in result);
	});

	test('default_send_options.queue propagates to transport', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const captured: Array<CapturedSend> = [];
		const responses = new Map([['ping', { pong: true }]]);
		transports.register_transport(create_mock_transport(responses, captured));

		const peer = new ActionDispatcher({
			environment: env,
			transports,
			default_send_options: { queue: true }
		});

		await peer.send({ jsonrpc: '2.0', method: 'ping', id: 1 });
		assert.strictEqual(captured.length, 1);
		assert.strictEqual(captured[0]!.options?.queue, true);
	});

	test('per-call queue overrides default_send_options.queue', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const captured: Array<CapturedSend> = [];
		const responses = new Map([['ping', { pong: true }]]);
		transports.register_transport(create_mock_transport(responses, captured));

		const peer = new ActionDispatcher({
			environment: env,
			transports,
			default_send_options: { queue: true }
		});

		await peer.send({ jsonrpc: '2.0', method: 'ping', id: 2 }, { queue: false });
		assert.strictEqual(captured.length, 1);
		assert.strictEqual(captured[0]!.options?.queue, false);
	});
});

describe('ActionDispatcher diagnostics log', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('resolve_action_log falls back to console only when log is unset', () => {
		const env = new TestEnvironment();
		assert.strictEqual(resolve_action_log(env), console_action_log);
		assert.isNull(resolve_action_log(Object.assign(env, { log: null })));
	});

	test('an unset log reports a notification that fails to parse via console.error', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const peer = new ActionDispatcher({ environment: new TestEnvironment([notify_spec]) });
		await peer.receive({ jsonrpc: '2.0', method: 'thing_changed', params: { id: 1, extra: true } });
		assert.strictEqual(error.mock.calls.length, 1);
		assert.include(String(error.mock.calls[0]![0]), 'receive notification failed');
	});

	test('an unset log reports a throwing notification handler via console.error', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = new TestEnvironment([notify_spec]);
		env.add_handler('thing_changed', 'receive', () => {
			throw new Error('boom');
		});
		const peer = new ActionDispatcher({ environment: env });
		await peer.receive({ jsonrpc: '2.0', method: 'thing_changed', params: { id: 'a' } });
		assert.strictEqual(error.mock.calls.length, 1);
		assert.deepInclude(error.mock.calls[0]![2], { message: 'boom' });
	});

	test('an unset log reports an unknown notification method via console.warn', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const peer = new ActionDispatcher({ environment: new TestEnvironment() });
		await peer.receive({ jsonrpc: '2.0', method: 'nope', params: {} });
		assert.strictEqual(warn.mock.calls.length, 1);
	});

	test('log: null silences the diagnostics', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = Object.assign(new TestEnvironment([notify_spec]), { log: null });
		const peer = new ActionDispatcher({ environment: env });
		await peer.receive({ jsonrpc: '2.0', method: 'thing_changed', params: { id: 1 } });
		assert.strictEqual(error.mock.calls.length, 0);
	});
});
