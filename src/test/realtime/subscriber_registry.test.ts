/**
 * Tests for backend_subscriber_registry - channel-based pub/sub.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {SubscriberRegistry} from '$lib/realtime/subscriber_registry.js';
import type {SseStream} from '$lib/realtime/sse.js';

/** Create a mock SseStream that records sent data. */
const create_mock_stream = <T>(): SseStream<T> & {
	sent: Array<T>;
	comments: Array<string>;
	closed: boolean;
} => {
	const sent: Array<T> = [];
	const comments: Array<string> = [];
	let closed = false;
	return {
		sent,
		comments,
		get closed() {
			return closed;
		},
		send(data: T) {
			sent.push(data);
		},
		comment(text: string) {
			comments.push(text);
		},
		close() {
			closed = true;
		},
		on_close() {},
	};
};

describe('SubscriberRegistry', () => {
	test('starts with zero subscribers', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		assert.strictEqual(registry.count, 0);
	});

	test('subscribe increments count', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream);
		assert.strictEqual(registry.count, 1);
	});

	test('unsubscribe decrements count', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		const unsubscribe = registry.subscribe(stream);
		assert.strictEqual(registry.count, 1);
		unsubscribe();
		assert.strictEqual(registry.count, 0);
	});

	test('broadcast sends to all subscribers when no channel filter', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();
		registry.subscribe(stream1);
		registry.subscribe(stream2);

		registry.broadcast('events', 'hello');

		assert.deepStrictEqual(stream1.sent, ['hello']);
		assert.deepStrictEqual(stream2.sent, ['hello']);
	});

	test('broadcast respects channel filters', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const runs_stream = create_mock_stream<string>();
		const hosts_stream = create_mock_stream<string>();
		const all_stream = create_mock_stream<string>();

		registry.subscribe(runs_stream, ['runs']);
		registry.subscribe(hosts_stream, ['hosts']);
		registry.subscribe(all_stream); // no filter = all channels

		registry.broadcast('runs', 'run_created');

		assert.deepStrictEqual(runs_stream.sent, ['run_created']);
		assert.deepStrictEqual(hosts_stream.sent, []);
		assert.deepStrictEqual(all_stream.sent, ['run_created']);
	});

	test('subscriber with multiple channels receives matching broadcasts', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['runs', 'hosts']);

		registry.broadcast('runs', 'run_event');
		registry.broadcast('hosts', 'host_event');
		registry.broadcast('other', 'other_event');

		assert.deepStrictEqual(stream.sent, ['run_event', 'host_event']);
	});

	test('empty channels array means all channels', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, []);

		registry.broadcast('any_channel', 'data');

		assert.deepStrictEqual(stream.sent, ['data']);
	});

	test('unsubscribed stream does not receive broadcasts', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		const unsubscribe = registry.subscribe(stream);

		registry.broadcast('ch', 'before');
		unsubscribe();
		registry.broadcast('ch', 'after');

		assert.deepStrictEqual(stream.sent, ['before']);
	});

	test('multiple subscribers can subscribe and unsubscribe independently', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();
		const unsub1 = registry.subscribe(stream1);
		registry.subscribe(stream2);

		assert.strictEqual(registry.count, 2);

		unsub1();
		assert.strictEqual(registry.count, 1);

		registry.broadcast('ch', 'data');
		assert.deepStrictEqual(stream1.sent, []);
		assert.deepStrictEqual(stream2.sent, ['data']);
	});

	test('broadcast with no subscribers is a no-op', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		// should not throw
		registry.broadcast('ch', 'data');
		assert.strictEqual(registry.count, 0);
	});

	test('subscribe with identity key', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['ch'], 'account_123');
		assert.strictEqual(registry.count, 1);
	});

	test('close_by_identity closes matching subscribers and removes them', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();
		const stream3 = create_mock_stream<string>();

		registry.subscribe(stream1, ['ch'], 'account_a');
		registry.subscribe(stream2, ['ch'], 'account_b');
		registry.subscribe(stream3, ['ch'], 'account_a');

		assert.strictEqual(registry.count, 3);

		const closed = registry.close_by_identity('account_a');

		assert.strictEqual(closed, 2);
		assert.strictEqual(registry.count, 1);
		assert.ok(stream1.closed);
		assert.ok(!stream2.closed);
		assert.ok(stream3.closed);
	});

	test('close_by_identity returns 0 when no subscribers match', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['ch'], 'account_a');

		const closed = registry.close_by_identity('account_nonexistent');

		assert.strictEqual(closed, 0);
		assert.strictEqual(registry.count, 1);
		assert.ok(!stream.closed);
	});

	test('close_by_identity does not close subscribers without identity', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream_with_id = create_mock_stream<string>();
		const stream_without_id = create_mock_stream<string>();

		registry.subscribe(stream_with_id, ['ch'], 'account_a');
		registry.subscribe(stream_without_id, ['ch']); // no identity

		const closed = registry.close_by_identity('account_a');

		assert.strictEqual(closed, 1);
		assert.strictEqual(registry.count, 1);
		assert.ok(stream_with_id.closed);
		assert.ok(!stream_without_id.closed);
	});

	test('closed subscriber no longer receives broadcasts', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['ch'], 'account_a');

		registry.broadcast('ch', 'before');
		registry.close_by_identity('account_a');
		registry.broadcast('ch', 'after');

		assert.deepStrictEqual(stream.sent, ['before']);
	});

	test('close_by_identity with empty registry is a no-op', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const closed = registry.close_by_identity('anything');
		assert.strictEqual(closed, 0);
	});
});
