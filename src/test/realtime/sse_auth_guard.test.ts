/**
 * Tests for sse_auth_guard — SSE stream disconnection and convenience factory.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_sse_auth_guard, create_audit_log_sse} from '$lib/realtime/sse_auth_guard.js';
import {SubscriberRegistry} from '$lib/realtime/subscriber_registry.js';
import type {SseStream, SseNotification} from '$lib/realtime/sse.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';

const log = new Logger('test', {level: 'off'});

/** Create a mock SseStream that tracks sent data and closed state. */
const create_mock_stream = <T>(): SseStream<T> & {sent: Array<T>; closed: boolean} => {
	const sent: Array<T> = [];
	let closed = false;
	return {
		sent,
		get closed() {
			return closed;
		},
		send(data: T) {
			sent.push(data);
		},
		comment() {},
		close() {
			closed = true;
		},
		on_close() {},
	};
};

/** Create a minimal audit log event for testing. */
const create_audit_event = (
	overrides: Partial<AuditLogEvent> & Pick<AuditLogEvent, 'event_type'>,
): AuditLogEvent => ({
	id: 'evt-1',
	seq: 1,
	outcome: 'success',
	actor_id: 'admin-actor-1',
	account_id: 'admin-account-1',
	target_account_id: null,
	ip: '127.0.0.1',
	created_at: new Date().toISOString(),
	metadata: null,
	...overrides,
});

describe('create_sse_auth_guard', () => {
	test('closes stream when permit_revoke matches required role and target account', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'target-account-1');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'target-account-1',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('does not close stream when revoked role does not match required role', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'target-account-1');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'target-account-1',
				metadata: {role: 'steward', permit_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('does not close stream when target_account_id does not match', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-b',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('ignores non-disconnect events', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'target-account-1');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_grant',
				target_account_id: 'target-account-1',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('ignores events with null target_account_id', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: null,
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
	});

	test('ignores permit_revoke with null metadata', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: null,
			}),
		);

		assert.ok(!stream.closed);
	});

	test('ignores permit_revoke with metadata missing role field', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: {permit_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
	});

	test('closes multiple streams for the same account', () => {
		const registry = new SubscriberRegistry<string>();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();
		registry.subscribe(stream1, ['audit_log'], 'account-a');
		registry.subscribe(stream2, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		assert.ok(stream1.closed);
		assert.ok(stream2.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('does not close streams belonging to other accounts', () => {
		const registry = new SubscriberRegistry<string>();
		const stream_a = create_mock_stream<string>();
		const stream_b = create_mock_stream<string>();
		registry.subscribe(stream_a, ['audit_log'], 'account-a');
		registry.subscribe(stream_b, ['audit_log'], 'account-b');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		assert.ok(stream_a.closed);
		assert.ok(!stream_b.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('handles login event without crashing', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'login',
				account_id: 'account-a',
				metadata: {username: 'alice'},
			}),
		);

		assert.ok(!stream.closed);
	});

	test('session_revoke_all closes streams via target_account_id (admin action)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		// admin revoking another user's sessions — sets target_account_id
		guard(
			create_audit_event({
				event_type: 'session_revoke_all',
				account_id: 'admin-account',
				target_account_id: 'account-a',
				metadata: {count: 3},
			}),
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('session_revoke_all closes streams via account_id (self-service)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		// user revoking own sessions — only account_id set, no target_account_id
		guard(
			create_audit_event({
				event_type: 'session_revoke_all',
				account_id: 'account-a',
				target_account_id: null,
				metadata: {count: 3},
			}),
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('session_revoke_all does not close streams for other accounts', () => {
		const registry = new SubscriberRegistry<string>();
		const stream_a = create_mock_stream<string>();
		const stream_b = create_mock_stream<string>();
		registry.subscribe(stream_a, ['audit_log'], 'account-a');
		registry.subscribe(stream_b, ['audit_log'], 'account-b');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'session_revoke_all',
				target_account_id: 'account-a',
				metadata: {count: 1},
			}),
		);

		assert.ok(stream_a.closed);
		assert.ok(!stream_b.closed);
	});

	test('password_change closes streams via account_id (self-service)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, ['audit_log'], 'account-a');

		const guard = create_sse_auth_guard(registry, 'admin', log);

		// password_change is self-service — only account_id set, no target_account_id
		guard(
			create_audit_event({
				event_type: 'password_change',
				account_id: 'account-a',
				target_account_id: null,
				metadata: {sessions_revoked: 2},
			}),
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});
});

describe('create_audit_log_sse', () => {
	test('on_audit_event broadcasts to registry', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, ['audit_log']);

		const event = create_audit_event({
			event_type: 'login',
			metadata: {username: 'alice'},
		});
		audit_sse.on_audit_event(event);

		assert.strictEqual(stream.sent.length, 1);
		assert.strictEqual(stream.sent[0]!.method, 'login');
		assert.strictEqual((stream.sent[0]!.params as AuditLogEvent).id, event.id);
	});

	test('on_audit_event closes streams on permit_revoke', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, ['audit_log'], 'account-a');

		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		// broadcast fires first (subscriber sees the event), then guard closes
		assert.ok(stream.closed);
		assert.strictEqual(audit_sse.registry.count, 0);
	});

	test('on_audit_event closes streams on session_revoke_all', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, ['audit_log'], 'account-a');

		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'session_revoke_all',
				target_account_id: 'account-a',
				metadata: {count: 2},
			}),
		);

		assert.ok(stream.closed);
	});

	test('subscribe function delegates to registry', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();

		const unsubscribe = audit_sse.subscribe(stream, ['audit_log'], 'account-a');
		assert.strictEqual(audit_sse.registry.count, 1);

		unsubscribe();
		assert.strictEqual(audit_sse.registry.count, 0);
	});

	test('respects custom role option', () => {
		const audit_sse = create_audit_log_sse({role: 'steward', log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, ['audit_log'], 'account-a');

		// revoking 'admin' should NOT close (guard watches 'steward')
		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);
		assert.ok(!stream.closed);

		// revoking 'steward' should close
		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'steward', permit_id: 'p-2'},
			}),
		);
		assert.ok(stream.closed);
	});

	test('broadcast happens before guard closes stream', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, ['audit_log'], 'account-a');

		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'permit_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', permit_id: 'p-1'},
			}),
		);

		// stream received the event before being closed
		assert.strictEqual(stream.sent.length, 1);
		assert.strictEqual(stream.sent[0]!.method, 'permit_revoke');
		assert.ok(stream.closed);
	});
});
