/**
 * Tests for rpc_client.ts — Proxy-based RPC client creation.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {create_rpc_client} from '$lib/actions/rpc_client.js';
import {ActionPeer} from '$lib/actions/action_peer.js';
import {Transports, type Transport} from '$lib/actions/transports.js';
import type {ActionEventEnvironment} from '$lib/actions/action_event_types.js';
import type {ActionSpecUnion} from '$lib/actions/action_spec.js';

const ping_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: false,
	input: z.null(),
	output: z.strictObject({pong: z.literal(true)}),
	async: true,
	description: 'Health check',
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

const create_mock_transport = (responses?: Map<string, any>): Transport => ({
	transport_name: 'mock',
	send: (async (message: any) => {
		if ('id' in message && responses?.has(message.method)) {
			return {jsonrpc: '2.0', id: message.id, result: responses.get(message.method)};
		}
		return null;
	}) as Transport['send'],
	is_ready: () => true,
});

describe('create_rpc_client', () => {
	test('returns undefined for unknown methods', () => {
		const env = new TestEnvironment([]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client({peer, environment: env});
		assert.strictEqual(client.unknown_method, undefined);
	});

	test('has returns true for known methods', () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client({peer, environment: env});
		assert.ok('ping' in client);
		assert.ok(!('unknown' in client));
	});

	test('creates callable methods for known specs', () => {
		const env = new TestEnvironment([ping_spec, toggle_spec]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client({peer, environment: env});
		assert.strictEqual(typeof client.ping, 'function');
		assert.strictEqual(typeof client.toggle_menu, 'function');
	});

	test('sync local_call method executes synchronously', () => {
		const env = new TestEnvironment([toggle_spec]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client({peer, environment: env});
		// Should not throw — sync method with no handler returns null (the output)
		const result = client.toggle_menu!(null);
		assert.isNull(result);
	});

	test('request_response method dispatches through transport', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const responses = new Map([['ping', {pong: true}]]);
		transports.register_transport(create_mock_transport(responses));

		const peer = new ActionPeer({environment: env, transports});
		const client = create_rpc_client({peer, environment: env});

		const result = await client.ping!(null);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, {pong: true});
	});
});
