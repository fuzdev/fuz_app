/**
 * Tests for broadcast_api.ts — generic backend broadcast plumbing.
 *
 * Covers the three surface contracts:
 * - input validation (silent skip + log on bad input)
 * - unfiltered broadcast (via peer.send → transport broadcast)
 * - ACL path (per-connection predicate via BackendWebsocketTransport)
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {WSContext, type WSContextInit} from 'hono/ws';
import {z} from 'zod';

import {ActionPeer} from '$lib/actions/action_peer.js';
import {create_broadcast_api, type ShouldDeliverFn} from '$lib/actions/broadcast_api.js';
import {BackendWebsocketTransport} from '$lib/actions/transports_ws_backend.js';
import {Transports, type Transport} from '$lib/actions/transports.js';
import type {
	JsonrpcErrorResponse,
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcResponseOrError,
} from '$lib/http/jsonrpc.js';
import type {ActionEventEnvironment} from '$lib/actions/action_event_types.js';
import type {ActionSpecUnion} from '$lib/actions/action_spec.js';
import {create_uuid} from '$lib/uuid.js';

const thing_changed_spec = {
	method: 'thing_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({id: z.string(), owner_account_id: z.string().optional()}),
	output: z.void(),
	async: true,
	description: 'Broadcast notification for tests',
} satisfies ActionSpecUnion;

class MinimalEnvironment implements ActionEventEnvironment {
	executor: 'frontend' | 'backend' = 'backend';
	#specs: Map<string, ActionSpecUnion> = new Map();
	constructor(specs: Array<ActionSpecUnion>) {
		for (const spec of specs) this.#specs.set(spec.method, spec);
	}
	lookup_action_handler(): undefined {
		return undefined;
	}
	lookup_action_spec(method: string): ActionSpecUnion | undefined {
		return this.#specs.get(method);
	}
}

interface FakeWs {
	ws: WSContext;
	sends: Array<string>;
}

const create_fake_ws = (): FakeWs => {
	const sends: Array<string> = [];
	const init: WSContextInit = {
		send: (data) => {
			sends.push(typeof data === 'string' ? data : '<binary>');
		},
		close: () => {
			// no-op for these tests
		},
		readyState: 1,
	};
	return {ws: new WSContext(init), sends};
};

const create_test_peer = (transport: BackendWebsocketTransport): ActionPeer => {
	const env = new MinimalEnvironment([thing_changed_spec]);
	const transports = new Transports();
	transports.register_transport(transport);
	return new ActionPeer({
		environment: env,
		transports,
		default_send_options: {transport_name: transport.transport_name},
	});
};

interface TestApi {
	thing_changed: (input: {id: string; owner_account_id?: string}) => Promise<void>;
}

describe('create_broadcast_api', () => {
	test('exposes a method per spec', () => {
		const transport = new BackendWebsocketTransport();
		const peer = create_test_peer(transport);
		const api = create_broadcast_api<TestApi>({
			peer,
			specs: [thing_changed_spec],
			log: null,
		});
		assert.typeOf(api.thing_changed, 'function');
	});

	test('unfiltered broadcast sends to every connection', async () => {
		const transport = new BackendWebsocketTransport();
		const peer = create_test_peer(transport);
		const account_a = create_uuid();
		const account_b = create_uuid();
		const a = create_fake_ws();
		const b = create_fake_ws();
		transport.add_connection(a.ws, 'hash_a', account_a);
		transport.add_connection(b.ws, 'hash_b', account_b);

		const api = create_broadcast_api<TestApi>({
			peer,
			specs: [thing_changed_spec],
			log: null,
		});
		await api.thing_changed({id: 'x'});

		assert.strictEqual(a.sends.length, 1);
		assert.strictEqual(b.sends.length, 1);
		const parsed = JSON.parse(a.sends[0]!);
		assert.strictEqual(parsed.method, 'thing_changed');
		assert.deepStrictEqual(parsed.params, {id: 'x'});
		assert.strictEqual(parsed.id, undefined); // notification has no id
	});

	test('validates input and skips send on failure', async () => {
		const transport = new BackendWebsocketTransport();
		const peer = create_test_peer(transport);
		const {ws} = create_fake_ws();
		transport.add_connection(ws, 'hash_a', create_uuid());

		const log_errors: Array<Array<unknown>> = [];
		const api = create_broadcast_api<TestApi>({
			peer,
			specs: [thing_changed_spec],
			log: {
				error: (...args: Array<unknown>) => log_errors.push(args),
				info: () => {},
				warn: () => {},
				debug: () => {},
				trace: () => {},
			} as never,
		});

		// `id` must be a string; pass a number to trip Zod
		await api.thing_changed({id: 42 as unknown as string});

		assert.strictEqual(log_errors.length, 1);
		const first = log_errors[0]!;
		assert.include(String(first[0]), 'input validation failed');
	});

	test('silently no-ops when no transport is ready', async () => {
		const transport = new BackendWebsocketTransport(); // no connections
		const peer = create_test_peer(transport);
		const api = create_broadcast_api<TestApi>({
			peer,
			specs: [thing_changed_spec],
			log: null,
		});
		// Should not throw
		await api.thing_changed({id: 'x'});
		assert.strictEqual(transport.is_ready(), false);
	});

	test('should_deliver filters per connection by identity', async () => {
		const transport = new BackendWebsocketTransport();
		const peer = create_test_peer(transport);
		const account_a = create_uuid();
		const account_b = create_uuid();
		const a = create_fake_ws();
		const b = create_fake_ws();
		transport.add_connection(a.ws, 'hash_a', account_a);
		transport.add_connection(b.ws, 'hash_b', account_b);

		const should_deliver: ShouldDeliverFn = (identity, _method, input) => {
			const payload = input as {owner_account_id?: string};
			return identity.account_id === payload.owner_account_id;
		};

		const api = create_broadcast_api<TestApi>({
			peer,
			specs: [thing_changed_spec],
			log: null,
			should_deliver,
		});
		await api.thing_changed({id: 'x', owner_account_id: account_a});

		assert.strictEqual(a.sends.length, 1);
		assert.strictEqual(b.sends.length, 0);
	});

	test('should_deliver logs error and skips when transport is not filterable', async () => {
		// Non-filterable transport — no `broadcast_filtered` method.
		class NoopTransport implements Transport {
			readonly transport_name = 'noop' as const;
			sent: Array<JsonrpcMessageFromClientToServer> = [];
			async send(message: JsonrpcRequest): Promise<JsonrpcResponseOrError>;
			async send(message: JsonrpcNotification): Promise<JsonrpcErrorResponse | null>;
			async send(
				message: JsonrpcMessageFromClientToServer,
			): Promise<JsonrpcMessageFromServerToClient | null> {
				this.sent.push(message);
				return null;
			}
			is_ready(): boolean {
				return true;
			}
		}
		const transport = new NoopTransport();
		const transports = new Transports();
		transports.register_transport(transport);
		const env = new MinimalEnvironment([thing_changed_spec]);
		const peer = new ActionPeer({
			environment: env,
			transports,
			default_send_options: {transport_name: transport.transport_name},
		});

		const log_errors: Array<Array<unknown>> = [];
		const api = create_broadcast_api<TestApi>({
			peer,
			specs: [thing_changed_spec],
			log: {
				error: (...args: Array<unknown>) => log_errors.push(args),
				info: () => {},
				warn: () => {},
				debug: () => {},
				trace: () => {},
			} as never,
			should_deliver: () => true,
		});

		await api.thing_changed({id: 'x'});

		assert.strictEqual(transport.sent.length, 0);
		assert.strictEqual(log_errors.length, 1);
		assert.include(String(log_errors[0]![0]), 'does not support per-connection filtering');
	});

	test('registers a method for each spec', () => {
		const other_spec: ActionSpecUnion = {
			...thing_changed_spec,
			method: 'other_thing_changed',
		};
		const transport = new BackendWebsocketTransport();
		const transports = new Transports();
		transports.register_transport(transport);
		const env = new MinimalEnvironment([thing_changed_spec, other_spec]);
		const peer = new ActionPeer({
			environment: env,
			transports,
			default_send_options: {transport_name: transport.transport_name},
		});
		const api = create_broadcast_api<Record<string, (input: unknown) => Promise<void>>>({
			peer,
			specs: [thing_changed_spec, other_spec],
			log: null,
		});
		assert.typeOf(api.thing_changed, 'function');
		assert.typeOf(api.other_thing_changed, 'function');
	});

	test('should_deliver sees validated payload, not raw input', async () => {
		const transport = new BackendWebsocketTransport();
		const peer = create_test_peer(transport);
		const {ws} = create_fake_ws();
		transport.add_connection(ws, 'hash_a', create_uuid());

		let seen_input: unknown = null;
		let seen_method: string | null = null;
		const should_deliver: ShouldDeliverFn = (_id, method, input) => {
			seen_method = method;
			seen_input = input;
			return true;
		};
		const api = create_broadcast_api<TestApi>({
			peer,
			specs: [thing_changed_spec],
			log: null,
			should_deliver,
		});
		await api.thing_changed({id: 'x'});

		assert.strictEqual(seen_method, 'thing_changed');
		assert.deepStrictEqual(seen_input, {id: 'x'});
	});
});
