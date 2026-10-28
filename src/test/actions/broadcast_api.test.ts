/**
 * Tests for broadcast_api.ts — generic backend broadcast plumbing.
 *
 * Covers the three surface contracts:
 * - input validation (silent skip + log on bad input)
 * - unfiltered broadcast (`transport.broadcast`)
 * - ACL path (per-connection predicate via BackendWebsocketTransport)
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import {
	create_broadcast_api,
	type BroadcastTarget,
	type ShouldDeliverFn
} from '#lib/actions/broadcast_api.ts';
import { BackendWebsocketTransport } from '#lib/actions/transports_ws_backend.ts';
import type { JsonrpcNotification } from '#lib/http/jsonrpc.ts';
import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';
import { create_fake_ws } from '#lib/testing/ws_round_trip.ts';
import { create_uuid } from '#lib/primitive_schemas.ts';
import { create_test_identity } from './connection_identity_helpers.ts';

const thing_changed_spec = {
	method: 'thing_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({ id: z.string(), owner_account_id: z.string().optional() }),
	output: z.void(),
	async: true,
	description: 'Broadcast notification for tests'
} satisfies ActionSpecUnion;

interface TestApi {
	thing_changed: (input: { id: string; owner_account_id?: string }) => Promise<void>;
}

describe('create_broadcast_api', () => {
	test('exposes a method per spec', () => {
		const transport = new BackendWebsocketTransport();
		const api = create_broadcast_api<TestApi>({
			transport,
			specs: [thing_changed_spec],
			log: null
		});
		assert.typeOf(api.thing_changed, 'function');
	});

	test('unfiltered broadcast sends to every connection', async () => {
		const transport = new BackendWebsocketTransport();
		const account_a = create_uuid();
		const account_b = create_uuid();
		const a = create_fake_ws();
		const b = create_fake_ws();
		transport.add_connection(
			a.ws,
			create_test_identity({ session_hash: 'hash_a', account_id: account_a })
		);
		transport.add_connection(
			b.ws,
			create_test_identity({ session_hash: 'hash_b', account_id: account_b })
		);

		const api = create_broadcast_api<TestApi>({
			transport,
			specs: [thing_changed_spec],
			log: null
		});
		await api.thing_changed({ id: 'x' });

		assert.strictEqual(a.sends.length, 1);
		assert.strictEqual(b.sends.length, 1);
		const parsed = JSON.parse(a.sends[0]!);
		assert.strictEqual(parsed.method, 'thing_changed');
		assert.deepStrictEqual(parsed.params, { id: 'x' });
		assert.strictEqual(parsed.id, undefined); // notification has no id
	});

	test('validates input and skips send on failure', async () => {
		const transport = new BackendWebsocketTransport();
		const { ws } = create_fake_ws();
		transport.add_connection(
			ws,
			create_test_identity({ session_hash: 'hash_a', account_id: create_uuid() })
		);

		const log_errors: Array<Array<unknown>> = [];
		const api = create_broadcast_api<TestApi>({
			transport,
			specs: [thing_changed_spec],
			log: {
				error: (...args: Array<unknown>) => log_errors.push(args),
				info: () => {},
				warn: () => {},
				debug: () => {},
				trace: () => {}
			} as never
		});

		// `id` must be a string; pass a number to trip Zod
		await api.thing_changed({ id: 42 as unknown as string });

		assert.strictEqual(log_errors.length, 1);
		const first = log_errors[0]!;
		assert.include(String(first[0]), 'input validation failed');
	});

	test('a broadcast with no connections reaches nobody and does not throw', async () => {
		const transport = new BackendWebsocketTransport(); // no connections
		const api = create_broadcast_api<TestApi>({
			transport,
			specs: [thing_changed_spec],
			log: null
		});
		// Should not throw
		await api.thing_changed({ id: 'x' });
		assert.strictEqual(transport.get_connection_count() > 0, false);
	});

	test('should_deliver filters per connection by identity', async () => {
		const transport = new BackendWebsocketTransport();
		const account_a = create_uuid();
		const account_b = create_uuid();
		const a = create_fake_ws();
		const b = create_fake_ws();
		transport.add_connection(
			a.ws,
			create_test_identity({ session_hash: 'hash_a', account_id: account_a })
		);
		transport.add_connection(
			b.ws,
			create_test_identity({ session_hash: 'hash_b', account_id: account_b })
		);

		const should_deliver: ShouldDeliverFn = (identity, _method, input) => {
			const payload = input as { owner_account_id?: string };
			return identity.account_id === payload.owner_account_id;
		};

		const api = create_broadcast_api<TestApi>({
			transport,
			specs: [thing_changed_spec],
			log: null,
			should_deliver
		});
		await api.thing_changed({ id: 'x', owner_account_id: account_a });

		assert.strictEqual(a.sends.length, 1);
		assert.strictEqual(b.sends.length, 0);
	});

	test('takes any broadcast target, filtered or not', async () => {
		const unfiltered: Array<JsonrpcNotification> = [];
		const filtered: Array<JsonrpcNotification> = [];
		const target: BroadcastTarget = {
			broadcast: (message) => {
				unfiltered.push(message);
				return 0;
			},
			broadcast_filtered: (message) => {
				filtered.push(message as JsonrpcNotification);
				return 0;
			}
		};
		await create_broadcast_api<TestApi>({
			transport: target,
			specs: [thing_changed_spec],
			log: null
		}).thing_changed({ id: 'x' });
		await create_broadcast_api<TestApi>({
			transport: target,
			specs: [thing_changed_spec],
			log: null,
			should_deliver: () => true
		}).thing_changed({ id: 'y' });

		assert.deepStrictEqual(
			unfiltered.map((m) => m.params),
			[{ id: 'x' }]
		);
		assert.deepStrictEqual(
			filtered.map((m) => m.params),
			[{ id: 'y' }]
		);
	});

	test('registers a method for each spec', () => {
		const other_spec: ActionSpecUnion = {
			...thing_changed_spec,
			method: 'other_thing_changed'
		};
		const transport = new BackendWebsocketTransport();
		const api = create_broadcast_api<Record<string, (input: unknown) => Promise<void>>>({
			transport,
			specs: [thing_changed_spec, other_spec],
			log: null
		});
		assert.typeOf(api.thing_changed, 'function');
		assert.typeOf(api.other_thing_changed, 'function');
	});

	test('should_deliver sees validated payload, not raw input', async () => {
		const transport = new BackendWebsocketTransport();
		const { ws } = create_fake_ws();
		transport.add_connection(
			ws,
			create_test_identity({ session_hash: 'hash_a', account_id: create_uuid() })
		);

		let seen_input: unknown = null;
		let seen_method: string | null = null;
		const should_deliver: ShouldDeliverFn = (_id, method, input) => {
			seen_method = method;
			seen_input = input;
			return true;
		};
		const api = create_broadcast_api<TestApi>({
			transport,
			specs: [thing_changed_spec],
			log: null,
			should_deliver
		});
		await api.thing_changed({ id: 'x' });

		assert.strictEqual(seen_method, 'thing_changed');
		assert.deepStrictEqual(seen_input, { id: 'x' });
	});
});
