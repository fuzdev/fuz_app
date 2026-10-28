/**
 * Tests for `realtime/audit_log_sse.ts` — the registry's connection closer and
 * the audit stream factory. The revocation listener that closes through them
 * is tested in `actions/connection_closer.revocation_guard.test.ts`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_uuid } from '#lib/primitive_schemas.ts';

import {
	create_sse_connection_closer,
	create_audit_log_sse,
	AUDIT_LOG_SSE_MAX_PER_SCOPE
} from '#lib/realtime/audit_log_sse.ts';
import { create_realtime_closer, create_revocation_guard } from '#lib/actions/connection_closer.ts';
import { SubscriberRegistry } from '#lib/realtime/subscriber_registry.ts';
import type { SseStream, SseNotification } from '#lib/realtime/sse.ts';
import type { AuditLogEvent } from '#lib/auth/audit_log_schema.ts';
import { create_test_audit_event } from '#lib/testing/entities.ts';

const log = new Logger('test', { level: 'off' });

/** Create a mock SseStream that tracks sent data and closed state. */
const create_mock_stream = <T>(): SseStream<T> & { sent: Array<T>; closed: boolean } => {
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
		close() {
			closed = true;
		},
		on_close() {}
	};
};

const create_audit_event = create_test_audit_event;

describe('create_sse_connection_closer', () => {
	test('each close reaches the streams registered under that identity, pending included', () => {
		const registry = new SubscriberRegistry<string>();
		const closer = create_sse_connection_closer(registry, 'admin');
		const account_id = create_uuid();
		const other_account_id = create_uuid();

		const session_stream = create_mock_stream<string>();
		registry.subscribe(session_stream, { scope: 'session-hash-1', groups: [account_id] });
		const sibling_stream = create_mock_stream<string>();
		registry.subscribe(sibling_stream, { scope: 'session-hash-2', groups: [account_id] });
		const token_stream = create_mock_stream<string>();
		registry.subscribe(token_stream, { scope: 'tok_abc', groups: [other_account_id] });
		const pending = registry.subscribe_pending({ scope: 'session-hash-3', groups: [account_id] });

		assert.strictEqual(
			closer.close_connections({ kind: 'session', session_hash: 'session-hash-1' }),
			1
		);
		assert.ok(session_stream.closed);
		assert.ok(!sibling_stream.closed);

		assert.strictEqual(closer.close_connections({ kind: 'token', api_token_id: 'tok_abc' }), 1);
		assert.ok(token_stream.closed);

		// account-wide: the remaining open stream and the pending registration
		assert.strictEqual(closer.close_connections({ kind: 'account', account_id }), 2);
		assert.ok(sibling_stream.closed);
		assert.strictEqual(registry.admit(pending, create_mock_stream<string>()), false);

		// idempotent — nothing left to close
		assert.strictEqual(closer.close_connections({ kind: 'account', account_id }), 0);
		assert.strictEqual(registry.count, 0);
		assert.strictEqual(registry.pending_count, 0);
	});

	test('a role target closes the account streams when the role is the gating one', () => {
		const registry = new SubscriberRegistry<string>();
		const closer = create_sse_connection_closer(registry, 'admin');
		const account_id = create_uuid();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { scope: 'session-hash-1', groups: [account_id] });
		const other = create_mock_stream<string>();
		registry.subscribe(other, { scope: 'session-hash-2', groups: [create_uuid()] });

		assert.strictEqual(closer.close_connections({ kind: 'role', account_id, role: 'keeper' }), 0);
		assert.ok(!stream.closed, 'a role the streams are not gated on closes nothing');
		assert.strictEqual(closer.close_connections({ kind: 'role', account_id, role: 'admin' }), 1);
		assert.ok(stream.closed);
		assert.ok(!other.closed);

		// a registry whose streams are not role-gated has nothing to close by role
		const ungated_registry = new SubscriberRegistry<string>();
		const ungated = create_mock_stream<string>();
		ungated_registry.subscribe(ungated, { scope: 'session-hash-3', groups: [account_id] });
		const ungated_closer = create_sse_connection_closer(ungated_registry, null);
		assert.strictEqual(
			ungated_closer.close_connections({ kind: 'role', account_id, role: 'admin' }),
			0
		);
		assert.ok(!ungated.closed);
	});

	test('close_all_connections closes every stream of the registry', () => {
		const registry = new SubscriberRegistry<string>();
		const closer = create_sse_connection_closer(registry, 'admin');
		const scoped = create_mock_stream<string>();
		registry.subscribe(scoped, { scope: 'session-hash-1', groups: [create_uuid()] });
		const anonymous = create_mock_stream<string>();
		registry.subscribe(anonymous);
		registry.subscribe_pending({ scope: 'session-hash-2' });

		assert.strictEqual(closer.close_all_connections(), 3);
		assert.ok(scoped.closed && anonymous.closed);
		assert.strictEqual(registry.count, 0);
		assert.strictEqual(registry.pending_count, 0);
	});
});

describe('create_audit_log_sse', () => {
	test('adds its registry to the connection closer', () => {
		const connection_closer = create_realtime_closer();
		const audit_sse = create_audit_log_sse({ log, connection_closer });
		const account_id = create_uuid();
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, {
			channels: ['audit_log'],
			scope: 'session-hash-1',
			groups: [account_id]
		});

		assert.strictEqual(connection_closer.close_connections({ kind: 'account', account_id }), 1);
		assert.ok(stream.closed);
		assert.strictEqual(audit_sse.registry.count, 0);
	});

	test('on_audit_event broadcasts to registry', () => {
		const audit_sse = create_audit_log_sse({ log, connection_closer: null });
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, { channels: ['audit_log'] });

		const event = create_audit_event({
			event_type: 'login',
			metadata: { username: 'alice' }
		});
		audit_sse.on_audit_event(event);

		assert.strictEqual(stream.sent.length, 1);
		assert.strictEqual(stream.sent[0]!.method, 'login');
		assert.strictEqual((stream.sent[0]!.params as AuditLogEvent).id, event.id);
	});

	test('a pending registration receives no audit row until it is admitted', () => {
		const audit_sse = create_audit_log_sse({ log, connection_closer: null });
		const stream = create_mock_stream<SseNotification>();
		const pending = audit_sse.registry.subscribe_pending({
			channels: ['audit_log'],
			groups: ['account-a']
		});

		audit_sse.on_audit_event(create_audit_event({ event_type: 'login', account_id: 'account-b' }));
		assert.strictEqual(stream.sent.length, 0);

		assert.ok(audit_sse.registry.admit(pending, stream));
		audit_sse.on_audit_event(create_audit_event({ event_type: 'login', account_id: 'account-b' }));
		assert.strictEqual(stream.sent.length, 1);
	});

	test('on_audit_event broadcasts a revocation row and closes nothing', () => {
		const audit_sse = create_audit_log_sse({ log, connection_closer: null });
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: { role: 'admin', role_grant_id: 'p-1' }
			})
		);

		assert.strictEqual(stream.sent.length, 1);
		assert.ok(!stream.closed, 'revocations close through the connection closer');
	});

	test('the revocation guard on its closer reaches a registration still pending admission', () => {
		const connection_closer = create_realtime_closer();
		const audit_sse = create_audit_log_sse({ log, connection_closer });
		const guard = create_revocation_guard(connection_closer, log);
		const stream = create_mock_stream<SseNotification>();
		const pending = audit_sse.registry.subscribe_pending({
			channels: ['audit_log'],
			scope: 'session-a',
			groups: ['account-a']
		});

		guard(
			create_audit_event({
				event_type: 'session_revoke_all',
				target_account_id: 'account-a',
				metadata: { count: 1 }
			})
		);

		assert.strictEqual(audit_sse.registry.pending_count, 0, 'the guard reached the pending entry');
		assert.strictEqual(audit_sse.registry.admit(pending, stream), false);
		assert.strictEqual(audit_sse.registry.count, 0);
	});

	test('the role option is the role its closer closes on', () => {
		const connection_closer = create_realtime_closer();
		const audit_sse = create_audit_log_sse({ role: 'steward', log, connection_closer });
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		assert.strictEqual(
			connection_closer.close_connections({
				kind: 'role',
				account_id: 'account-a' as any,
				role: 'admin'
			}),
			0
		);
		assert.ok(!stream.closed);
		assert.strictEqual(
			connection_closer.close_connections({
				kind: 'role',
				account_id: 'account-a' as any,
				role: 'steward'
			}),
			1
		);
		assert.ok(stream.closed);
		assert.strictEqual(audit_sse.required_role, 'steward');
	});

	test('in the emitter order create_app_server registers, the row reaches the stream before the close', () => {
		const connection_closer = create_realtime_closer();
		const audit_sse = create_audit_log_sse({ log, connection_closer });
		const guard = create_revocation_guard(connection_closer, log);
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const event = create_audit_event({
			event_type: 'role_grant_revoke',
			target_account_id: 'account-a',
			metadata: { role: 'admin', role_grant_id: 'p-1' }
		});
		// the broadcast listener first, the guard after it
		audit_sse.on_audit_event(event);
		guard(event);

		assert.strictEqual(stream.sent.length, 1);
		assert.strictEqual(stream.sent[0]!.method, 'role_grant_revoke');
		assert.ok(stream.closed);
	});

	test('defaults to AUDIT_LOG_SSE_MAX_PER_SCOPE subscribers per session scope', () => {
		// Sanity-check the default so consumers relying on `create_audit_log_sse({log})`
		// get the documented per-scope cap (10 tabs per session).
		assert.strictEqual(AUDIT_LOG_SSE_MAX_PER_SCOPE, 10);

		const audit_sse = create_audit_log_sse({ log, connection_closer: null });
		const streams: Array<ReturnType<typeof create_mock_stream<SseNotification>>> = [];

		// Saturate one session scope; account id lives in groups (uncapped).
		for (let i = 0; i < AUDIT_LOG_SSE_MAX_PER_SCOPE + 1; i++) {
			const stream = create_mock_stream<SseNotification>();
			streams.push(stream);
			audit_sse.registry.subscribe(stream, {
				channels: ['audit_log'],
				scope: 'session-hash-a',
				groups: ['account-a']
			});
		}

		assert.strictEqual(audit_sse.registry.count, AUDIT_LOG_SSE_MAX_PER_SCOPE);
		assert.ok(streams[0]!.closed, 'oldest subscriber evicted on overflow');
		for (let i = 1; i < streams.length; i++) {
			assert.ok(!streams[i]!.closed, `stream ${i} should remain open`);
		}
	});

	test('account-wide (groups) subscribers are not subject to the scope cap', () => {
		// Many sessions under one account — each session has one tab. The cap
		// applies per session scope, so the shared account_id in groups does
		// not trigger eviction.
		const audit_sse = create_audit_log_sse({ log, connection_closer: null });
		const streams: Array<ReturnType<typeof create_mock_stream<SseNotification>>> = [];

		for (let i = 0; i < AUDIT_LOG_SSE_MAX_PER_SCOPE + 5; i++) {
			const stream = create_mock_stream<SseNotification>();
			streams.push(stream);
			audit_sse.registry.subscribe(stream, {
				channels: ['audit_log'],
				scope: `session-${i}`,
				groups: ['account-a']
			});
		}

		assert.strictEqual(audit_sse.registry.count, AUDIT_LOG_SSE_MAX_PER_SCOPE + 5);
		for (const s of streams) assert.ok(!s.closed);
	});

	test('max_per_scope: null disables the cap', () => {
		const audit_sse = create_audit_log_sse({ log, connection_closer: null, max_per_scope: null });

		for (let i = 0; i < AUDIT_LOG_SSE_MAX_PER_SCOPE + 3; i++) {
			audit_sse.registry.subscribe(create_mock_stream<SseNotification>(), {
				channels: ['audit_log'],
				scope: 'session-a'
			});
		}

		assert.strictEqual(audit_sse.registry.count, AUDIT_LOG_SSE_MAX_PER_SCOPE + 3);
	});

	test('max_per_scope override is respected', () => {
		const audit_sse = create_audit_log_sse({ log, connection_closer: null, max_per_scope: 2 });
		const streams: Array<ReturnType<typeof create_mock_stream<SseNotification>>> = [];

		for (let i = 0; i < 4; i++) {
			const stream = create_mock_stream<SseNotification>();
			streams.push(stream);
			audit_sse.registry.subscribe(stream, { channels: ['audit_log'], scope: 'session-a' });
		}

		assert.strictEqual(audit_sse.registry.count, 2);
		assert.ok(streams[0]!.closed);
		assert.ok(streams[1]!.closed);
		assert.ok(!streams[2]!.closed);
		assert.ok(!streams[3]!.closed);
	});
});
