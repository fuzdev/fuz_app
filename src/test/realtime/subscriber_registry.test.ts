/**
 * Tests for backend_subscriber_registry - channel-based pub/sub.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {SubscriberRegistry} from '$lib/realtime/subscriber_registry.ts';
import type {SseStream} from '$lib/realtime/sse.ts';

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

		registry.subscribe(runs_stream, {channels: ['runs']});
		registry.subscribe(hosts_stream, {channels: ['hosts']});
		registry.subscribe(all_stream); // no filter = all channels

		registry.broadcast('runs', 'run_created');

		assert.deepStrictEqual(runs_stream.sent, ['run_created']);
		assert.deepStrictEqual(hosts_stream.sent, []);
		assert.deepStrictEqual(all_stream.sent, ['run_created']);
	});

	test('subscriber with multiple channels receives matching broadcasts', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['runs', 'hosts']});

		registry.broadcast('runs', 'run_event');
		registry.broadcast('hosts', 'host_event');
		registry.broadcast('other', 'other_event');

		assert.deepStrictEqual(stream.sent, ['run_event', 'host_event']);
	});

	test('empty channels array means all channels', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: []});

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

	test('subscribe with scope only', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['ch'], scope: 'session_x'});
		assert.strictEqual(registry.count, 1);
	});

	test('close_by_identity matches scope', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();
		const stream3 = create_mock_stream<string>();

		registry.subscribe(stream1, {channels: ['ch'], scope: 'session_a'});
		registry.subscribe(stream2, {channels: ['ch'], scope: 'session_b'});
		registry.subscribe(stream3, {channels: ['ch'], scope: 'session_a'});

		assert.strictEqual(registry.count, 3);

		const closed = registry.close_by_identity('session_a');

		assert.strictEqual(closed, 2);
		assert.strictEqual(registry.count, 1);
		assert.ok(stream1.closed);
		assert.ok(!stream2.closed);
		assert.ok(stream3.closed);
	});

	test('close_by_identity matches groups', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();

		registry.subscribe(stream1, {channels: ['ch'], groups: ['account_a']});
		registry.subscribe(stream2, {channels: ['ch'], groups: ['account_b']});

		const closed = registry.close_by_identity('account_a');
		assert.strictEqual(closed, 1);
		assert.ok(stream1.closed);
		assert.ok(!stream2.closed);
	});

	test('close_by_identity matches both scope and groups on the same subscriber', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['ch'], scope: 'session_x', groups: ['account_a']});

		// matched by scope
		const by_scope = registry.close_by_identity('session_x');
		assert.strictEqual(by_scope, 1);
		assert.ok(stream.closed);
	});

	test('close_by_identity returns 0 when no subscribers match', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['ch'], scope: 'session_a'});

		const closed = registry.close_by_identity('nonexistent');

		assert.strictEqual(closed, 0);
		assert.strictEqual(registry.count, 1);
		assert.ok(!stream.closed);
	});

	test('close_by_identity does not close subscribers without any identity', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream_with_scope = create_mock_stream<string>();
		const stream_without_id = create_mock_stream<string>();

		registry.subscribe(stream_with_scope, {channels: ['ch'], scope: 'session_a'});
		registry.subscribe(stream_without_id, {channels: ['ch']});

		const closed = registry.close_by_identity('session_a');

		assert.strictEqual(closed, 1);
		assert.strictEqual(registry.count, 1);
		assert.ok(stream_with_scope.closed);
		assert.ok(!stream_without_id.closed);
	});

	test('closed subscriber no longer receives broadcasts', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['ch'], scope: 'session_a'});

		registry.broadcast('ch', 'before');
		registry.close_by_identity('session_a');
		registry.broadcast('ch', 'after');

		assert.deepStrictEqual(stream.sent, ['before']);
	});

	test('close_by_identity with empty registry is a no-op', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const closed = registry.close_by_identity('anything');
		assert.strictEqual(closed, 0);
	});

	test('scope + groups together: close by either key closes the subscriber', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['ch'], scope: 'session_x', groups: ['account_a']});

		// closing by group key
		const closed = registry.close_by_identity('account_a');
		assert.strictEqual(closed, 1);
		assert.ok(stream.closed);
	});

	test('subscribe with empty groups is treated as no groups', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['ch'], groups: []});

		const closed = registry.close_by_identity('anything');
		assert.strictEqual(closed, 0);
		assert.ok(!stream.closed);
	});
});

describe('SubscriberRegistry max_per_scope', () => {
	test('closes oldest subscriber when scope cap is reached', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry({max_per_scope: 5});
		const streams: Array<ReturnType<typeof create_mock_stream<string>>> = [];

		for (let i = 0; i < 6; i++) {
			const stream = create_mock_stream<string>();
			streams.push(stream);
			registry.subscribe(stream, {channels: ['ch'], scope: 'session_a'});
		}

		// only 5 subscribers — oldest (streams[0]) was closed on the 6th subscribe
		assert.strictEqual(registry.count, 5);
		assert.ok(streams[0]!.closed, 'oldest stream should be closed');
		for (let i = 1; i < 6; i++) {
			assert.ok(!streams[i]!.closed, `stream ${i} should still be open`);
		}
	});

	test('does not close subscribers for other scopes when cap is reached', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry({max_per_scope: 2});
		const a1 = create_mock_stream<string>();
		const a2 = create_mock_stream<string>();
		const b1 = create_mock_stream<string>();
		const a3 = create_mock_stream<string>();

		registry.subscribe(a1, {channels: ['ch'], scope: 'session_a'});
		registry.subscribe(a2, {channels: ['ch'], scope: 'session_a'});
		registry.subscribe(b1, {channels: ['ch'], scope: 'session_b'});
		registry.subscribe(a3, {channels: ['ch'], scope: 'session_a'});

		assert.ok(a1.closed, 'oldest session_a subscriber closed');
		assert.ok(!a2.closed);
		assert.ok(!b1.closed, 'other-scope subscriber untouched');
		assert.ok(!a3.closed);
		assert.strictEqual(registry.count, 3);
	});

	test('groups are NOT subject to the cap — many subscribers can share a group', () => {
		// This is the core of the scope/groups split: the cap only applies to
		// scope. A shared group identity (like account_id) is for coarse close
		// targeting, not for resource capping.
		const registry: SubscriberRegistry<string> = new SubscriberRegistry({max_per_scope: 2});
		const streams: Array<ReturnType<typeof create_mock_stream<string>>> = [];

		// Five unique scopes all sharing one group — each scope is at the cap
		// of 1 subscriber (well under 2), so none should be evicted.
		for (let i = 0; i < 5; i++) {
			const stream = create_mock_stream<string>();
			streams.push(stream);
			registry.subscribe(stream, {
				channels: ['ch'],
				scope: `session_${i}`,
				groups: ['account_a'],
			});
		}

		assert.strictEqual(registry.count, 5);
		for (let i = 0; i < 5; i++) assert.ok(!streams[i]!.closed);

		// One close_by_identity on the shared group closes all.
		const closed = registry.close_by_identity('account_a');
		assert.strictEqual(closed, 5);
	});

	test('null (default) disables the cap', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry();
		for (let i = 0; i < 20; i++) {
			registry.subscribe(create_mock_stream<string>(), {channels: ['ch'], scope: 'session_a'});
		}
		assert.strictEqual(registry.count, 20);
	});

	test('subscribers without a scope are not subject to the cap', () => {
		const registry: SubscriberRegistry<string> = new SubscriberRegistry({max_per_scope: 2});
		for (let i = 0; i < 10; i++) {
			registry.subscribe(create_mock_stream<string>(), {channels: ['ch']});
		}
		assert.strictEqual(registry.count, 10);
	});
});
