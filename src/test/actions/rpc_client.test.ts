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

// Loose record shape for tests that exercise the runtime Proxy behavior
// without naming each method's signature in a typed surface. Production
// consumers pass a real `<TApi>` (codegen-derived) — this alias is
// test-only and `any`-typed on purpose so existing assertions
// (`result.ok`, `result.value`, etc.) flow through without per-test casts.
type TestClient = Record<string, ((...args: Array<any>) => any) | undefined>;

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

interface CapturedSend {
	message: any;
	options: any;
}

const create_mock_transport = (
	responses?: Map<string, any>,
	captured?: Array<CapturedSend>,
): Transport => ({
	transport_name: 'mock',
	send: (async (message: any, options?: any) => {
		captured?.push({message, options});
		if ('id' in message && responses?.has(message.method)) {
			return {jsonrpc: '2.0', id: message.id, result: responses.get(message.method)};
		}
		return null;
	}) as Transport['send'],
	is_ready: () => true,
});

const ping_notification_spec = {
	method: 'pong_notify',
	kind: 'remote_notification',
	initiator: 'frontend',
	auth: null,
	side_effects: true,
	input: z.null(),
	output: z.void(),
	async: true,
	description: 'Notification spec',
} satisfies ActionSpecUnion;

const async_local_spec = {
	method: 'compute',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: true,
	description: 'Async local call',
} satisfies ActionSpecUnion;

describe('create_rpc_client', () => {
	test('returns undefined for unknown methods', () => {
		const env = new TestEnvironment([]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client<TestClient>({peer, environment: env});
		assert.strictEqual(client.unknown_method, undefined);
	});

	test('has returns true for known methods', () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client<TestClient>({peer, environment: env});
		assert.ok('ping' in client);
		assert.ok(!('unknown' in client));
	});

	test('creates callable methods for known specs', () => {
		const env = new TestEnvironment([ping_spec, toggle_spec]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client<TestClient>({peer, environment: env});
		assert.strictEqual(typeof client.ping, 'function');
		assert.strictEqual(typeof client.toggle_menu, 'function');
	});

	test('sync local_call method executes synchronously', () => {
		const env = new TestEnvironment([toggle_spec]);
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});

		const client = create_rpc_client<TestClient>({peer, environment: env});
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
		const client = create_rpc_client<TestClient>({peer, environment: env});

		const result = await client.ping!(null);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, {pong: true});
	});

	test('request_response method forwards signal to transport', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const captured: Array<CapturedSend> = [];
		const responses = new Map([['ping', {pong: true}]]);
		transports.register_transport(create_mock_transport(responses, captured));

		const peer = new ActionPeer({environment: env, transports});
		const client = create_rpc_client<TestClient>({peer, environment: env});

		const controller = new AbortController();
		await client.ping!(null, {signal: controller.signal});

		assert.strictEqual(captured.length, 1);
		assert.strictEqual(captured[0]!.options?.signal, controller.signal);
	});

	test('request_response method forwards per-call transport_name override', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const captured: Array<CapturedSend> = [];
		const responses = new Map([['ping', {pong: true}]]);
		const ws = create_mock_transport(responses, captured);
		Object.assign(ws, {transport_name: 'ws'});
		const http = create_mock_transport(responses);
		Object.assign(http, {transport_name: 'http'});
		transports.register_transport(http); // becomes default
		transports.register_transport(ws);

		const peer = new ActionPeer({environment: env, transports});
		const client = create_rpc_client<TestClient>({
			peer,
			environment: env,
			transport_for_method: () => 'http', // per-method config
		});

		await client.ping!(null, {transport_name: 'ws'}); // per-call override

		assert.strictEqual(captured.length, 1, 'WS transport should have been chosen');
	});

	test('remote_notification method forwards signal to transport', async () => {
		const env = new TestEnvironment([ping_notification_spec]);
		const transports = new Transports();
		const captured: Array<CapturedSend> = [];
		transports.register_transport(create_mock_transport(undefined, captured));

		const peer = new ActionPeer({environment: env, transports});
		const client = create_rpc_client<TestClient>({peer, environment: env});

		const controller = new AbortController();
		await client.pong_notify!(null, {signal: controller.signal});

		assert.strictEqual(captured.length, 1);
		assert.strictEqual(captured[0]!.options?.signal, controller.signal);
	});

	test('request_response method forwards per-call queue to transport', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const captured: Array<CapturedSend> = [];
		const responses = new Map([['ping', {pong: true}]]);
		transports.register_transport(create_mock_transport(responses, captured));

		const peer = new ActionPeer({environment: env, transports});
		const client = create_rpc_client<TestClient>({peer, environment: env});

		await client.ping!(null, {queue: true});

		assert.strictEqual(captured.length, 1);
		assert.strictEqual(captured[0]!.options?.queue, true);
	});

	test('remote_notification method forwards per-call queue to transport', async () => {
		const env = new TestEnvironment([ping_notification_spec]);
		const transports = new Transports();
		const captured: Array<CapturedSend> = [];
		transports.register_transport(create_mock_transport(undefined, captured));

		const peer = new ActionPeer({environment: env, transports});
		const client = create_rpc_client<TestClient>({peer, environment: env});

		await client.pong_notify!(null, {queue: true});

		assert.strictEqual(captured.length, 1);
		assert.strictEqual(captured[0]!.options?.queue, true);
	});

	test('peer default_send_options.queue applies through transport_for_method selection', async () => {
		const env = new TestEnvironment([ping_spec]);
		const transports = new Transports();
		const captured_ws: Array<CapturedSend> = [];
		const captured_http: Array<CapturedSend> = [];
		const responses = new Map([['ping', {pong: true}]]);
		const ws = create_mock_transport(responses, captured_ws);
		Object.assign(ws, {transport_name: 'ws'});
		const http = create_mock_transport(responses, captured_http);
		Object.assign(http, {transport_name: 'http'});
		transports.register_transport(http); // becomes default
		transports.register_transport(ws);

		const peer = new ActionPeer({
			environment: env,
			transports,
			default_send_options: {queue: true},
		});
		const client = create_rpc_client<TestClient>({
			peer,
			environment: env,
			transport_for_method: () => 'ws',
		});

		await client.ping!(null);

		assert.strictEqual(captured_ws.length, 1, 'ws transport should be selected');
		assert.strictEqual(captured_http.length, 0, 'http transport should not receive');
		assert.strictEqual(captured_ws[0]!.options?.queue, true, 'peer default queue should apply');
	});

	test('async local_call rejects pre-aborted signal without invoking handler', async () => {
		const env = new TestEnvironment([async_local_spec]);
		let handler_called = false;
		env.add_handler('compute', 'execute', () => {
			handler_called = true;
			return null;
		});
		const transports = new Transports();
		const peer = new ActionPeer({environment: env, transports});
		const client = create_rpc_client<TestClient>({peer, environment: env});

		const controller = new AbortController();
		controller.abort();
		const result = await client.compute!(null, {signal: controller.signal});

		assert.strictEqual(handler_called, false);
		assert.ok(!result.ok, 'should return error result for pre-aborted call');
		assert.match(String(result.error.message), /aborted/);
	});
});
