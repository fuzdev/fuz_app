/**
 * Tests for sse_auth_guard — SSE stream disconnection and convenience factory.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {
	create_sse_auth_guard,
	create_audit_log_sse,
	AUDIT_LOG_SSE_MAX_PER_SCOPE,
} from '$lib/realtime/sse_auth_guard.ts';
import {SubscriberRegistry} from '$lib/realtime/subscriber_registry.ts';
import type {SseStream, SseNotification} from '$lib/realtime/sse.ts';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.ts';
import {create_test_audit_event} from '$lib/testing/entities.ts';

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

const create_audit_event = create_test_audit_event;

describe('create_sse_auth_guard', () => {
	test('closes stream when role_grant_revoke matches required role and target account', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['target-account-1']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'target-account-1',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('does not close stream when revoked role does not match required role', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['target-account-1']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'target-account-1',
				metadata: {role: 'steward', role_grant_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('does not close stream when target_account_id does not match', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-b',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('ignores non-disconnect events', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['target-account-1']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_create',
				target_account_id: 'target-account-1',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('ignores events with null target_account_id', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: null,
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
	});

	test('ignores role_grant_revoke with null metadata', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: null,
			}),
		);

		assert.ok(!stream.closed);
	});

	test('ignores role_grant_revoke with metadata missing role field', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role_grant_id: 'p-1'},
			}),
		);

		assert.ok(!stream.closed);
	});

	test('null required_role skips role_grant_revoke but still closes on session/password events', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, null, log);

		// role_grant_revoke is ignored — stream not gated by any role
		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);
		assert.ok(!stream.closed);

		// session_revoke_all still closes — session-level revocation applies regardless of role
		guard(
			create_audit_event({
				event_type: 'session_revoke_all',
				target_account_id: 'account-a',
			}),
		);
		assert.ok(stream.closed);
	});

	test('closes multiple streams for the same account', () => {
		const registry = new SubscriberRegistry<string>();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();
		registry.subscribe(stream1, {channels: ['audit_log'], groups: ['account-a']});
		registry.subscribe(stream2, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
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
		registry.subscribe(stream_a, {channels: ['audit_log'], groups: ['account-a']});
		registry.subscribe(stream_b, {channels: ['audit_log'], groups: ['account-b']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);

		assert.ok(stream_a.closed);
		assert.ok(!stream_b.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('handles login event without crashing', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

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
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

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
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

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
		registry.subscribe(stream_a, {channels: ['audit_log'], groups: ['account-a']});
		registry.subscribe(stream_b, {channels: ['audit_log'], groups: ['account-b']});

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

	test('skips session_revoke with outcome=failure (cross-account DoS prevention)', () => {
		// If user B knows (or guesses) user A's session hash, B can POST
		// /sessions/{hash_A}/revoke. The DB rejects the revoke (cross-account),
		// but the audit event fires with outcome=failure and metadata.session_id
		// set to hash_A. The guard must NOT close A's stream in this case.
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {
			channels: ['audit_log'],
			scope: 'session-hash-a',
			groups: ['account-a'],
		});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-b', // attacker B attempting to revoke A's session
				outcome: 'failure',
				metadata: {session_id: 'session-hash-a'},
			}),
		);

		assert.ok(!stream.closed, 'failed session_revoke must not close the victim stream');
		assert.strictEqual(registry.count, 1);
	});

	test('skips password_change with outcome=failure', () => {
		// Wrong current password — user is still authenticated, sessions are still
		// valid. No reason to close their SSE stream.
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'password_change',
				account_id: 'account-a',
				outcome: 'failure',
				metadata: null,
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('session_revoke closes only the matching session stream', () => {
		const registry = new SubscriberRegistry<string>();
		const session_x_stream = create_mock_stream<string>();
		const session_y_stream = create_mock_stream<string>();
		// another subscriber for the same account but a different session hash
		registry.subscribe(session_x_stream, {
			channels: ['audit_log'],
			scope: 'session-hash-x',
			groups: ['account-a'],
		});
		registry.subscribe(session_y_stream, {
			channels: ['audit_log'],
			scope: 'session-hash-y',
			groups: ['account-a'],
		});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-a',
				outcome: 'success',
				metadata: {session_id: 'session-hash-x'},
			}),
		);

		assert.ok(session_x_stream.closed, 'revoked session stream must close');
		assert.ok(!session_y_stream.closed, 'other session for same account must stay open');
		assert.strictEqual(registry.count, 1);
	});

	test('session_revoke ignores events with missing session_id metadata', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {
			channels: ['audit_log'],
			scope: 'session-hash-x',
			groups: ['account-a'],
		});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		// outcome=success but metadata is malformed — guard must not crash
		// and must not attempt any close
		guard(
			create_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-a',
				outcome: 'success',
				metadata: null,
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('session_revoke does NOT close account-keyed-only streams (coarser subscribers)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		// subscriber that only tracks account identity (no session hash) — e.g. a
		// legacy or non-session-keyed subscription. session_revoke must not affect it.
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		const guard = create_sse_auth_guard(registry, 'admin', log);

		guard(
			create_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-a',
				outcome: 'success',
				metadata: {session_id: 'session-hash-x'},
			}),
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('password_change closes streams via account_id (self-service)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

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
		audit_sse.registry.subscribe(stream, {channels: ['audit_log']});

		const event = create_audit_event({
			event_type: 'login',
			metadata: {username: 'alice'},
		});
		audit_sse.on_audit_event(event);

		assert.strictEqual(stream.sent.length, 1);
		assert.strictEqual(stream.sent[0]!.method, 'login');
		assert.strictEqual((stream.sent[0]!.params as AuditLogEvent).id, event.id);
	});

	test('on_audit_event closes streams on role_grant_revoke', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);

		// broadcast fires first (subscriber sees the event), then guard closes
		assert.ok(stream.closed);
		assert.strictEqual(audit_sse.registry.count, 0);
	});

	test('on_audit_event closes streams on session_revoke_all', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

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

		const unsubscribe = audit_sse.subscribe(stream, {
			channels: ['audit_log'],
			groups: ['account-a'],
		});
		assert.strictEqual(audit_sse.registry.count, 1);

		unsubscribe();
		assert.strictEqual(audit_sse.registry.count, 0);
	});

	test('respects custom role option', () => {
		const audit_sse = create_audit_log_sse({role: 'steward', log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		// revoking 'admin' should NOT close (guard watches 'steward')
		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);
		assert.ok(!stream.closed);

		// revoking 'steward' should close
		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'steward', role_grant_id: 'p-2'},
			}),
		);
		assert.ok(stream.closed);
	});

	test('broadcast happens before guard closes stream', () => {
		const audit_sse = create_audit_log_sse({log});
		const stream = create_mock_stream<SseNotification>();
		audit_sse.registry.subscribe(stream, {channels: ['audit_log'], groups: ['account-a']});

		audit_sse.on_audit_event(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: {role: 'admin', role_grant_id: 'p-1'},
			}),
		);

		// stream received the event before being closed
		assert.strictEqual(stream.sent.length, 1);
		assert.strictEqual(stream.sent[0]!.method, 'role_grant_revoke');
		assert.ok(stream.closed);
	});

	test('defaults to AUDIT_LOG_SSE_MAX_PER_SCOPE subscribers per session scope', () => {
		// Sanity-check the default so consumers relying on `create_audit_log_sse({log})`
		// get the documented per-scope cap (10 tabs per session).
		assert.strictEqual(AUDIT_LOG_SSE_MAX_PER_SCOPE, 10);

		const audit_sse = create_audit_log_sse({log});
		const streams: Array<ReturnType<typeof create_mock_stream<SseNotification>>> = [];

		// Saturate one session scope; account id lives in groups (uncapped).
		for (let i = 0; i < AUDIT_LOG_SSE_MAX_PER_SCOPE + 1; i++) {
			const stream = create_mock_stream<SseNotification>();
			streams.push(stream);
			audit_sse.registry.subscribe(stream, {
				channels: ['audit_log'],
				scope: 'session-hash-a',
				groups: ['account-a'],
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
		const audit_sse = create_audit_log_sse({log});
		const streams: Array<ReturnType<typeof create_mock_stream<SseNotification>>> = [];

		for (let i = 0; i < AUDIT_LOG_SSE_MAX_PER_SCOPE + 5; i++) {
			const stream = create_mock_stream<SseNotification>();
			streams.push(stream);
			audit_sse.registry.subscribe(stream, {
				channels: ['audit_log'],
				scope: `session-${i}`,
				groups: ['account-a'],
			});
		}

		assert.strictEqual(audit_sse.registry.count, AUDIT_LOG_SSE_MAX_PER_SCOPE + 5);
		for (const s of streams) assert.ok(!s.closed);
	});

	test('max_per_scope: null disables the cap', () => {
		const audit_sse = create_audit_log_sse({log, max_per_scope: null});

		for (let i = 0; i < AUDIT_LOG_SSE_MAX_PER_SCOPE + 3; i++) {
			audit_sse.registry.subscribe(create_mock_stream<SseNotification>(), {
				channels: ['audit_log'],
				scope: 'session-a',
			});
		}

		assert.strictEqual(audit_sse.registry.count, AUDIT_LOG_SSE_MAX_PER_SCOPE + 3);
	});

	test('max_per_scope override is respected', () => {
		const audit_sse = create_audit_log_sse({log, max_per_scope: 2});
		const streams: Array<ReturnType<typeof create_mock_stream<SseNotification>>> = [];

		for (let i = 0; i < 4; i++) {
			const stream = create_mock_stream<SseNotification>();
			streams.push(stream);
			audit_sse.registry.subscribe(stream, {channels: ['audit_log'], scope: 'session-a'});
		}

		assert.strictEqual(audit_sse.registry.count, 2);
		assert.ok(streams[0]!.closed);
		assert.ok(streams[1]!.closed);
		assert.ok(!streams[2]!.closed);
		assert.ok(!streams[3]!.closed);
	});
});
