/**
 * Tests for `create_revocation_guard` — audit event dispatch onto a
 * `ConnectionCloser`'s `close_connections`, by the `RevocationScope` each
 * event declares (`to_connection_close_target`) — and for that declaration,
 * `audit_event_revocation_scopes`.
 *
 * Runs the guard over each kind of member `create_app_server` puts on the
 * backend's closer — a real `BackendWebsocketTransport` with fake `WSContext`
 * instances, and an SSE `SubscriberRegistry` through
 * `create_sse_connection_closer` — and over a `RealtimeCloser` holding both,
 * the one guard the server registers.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { WSContext, type WSContextInit } from 'hono/ws';

import { BackendWebsocketTransport } from '#lib/actions/transports_ws_backend.ts';
import {
	WS_CLOSE_PERMISSION_REVOKED,
	WS_CLOSE_PERMISSION_REVOKED_REASON
} from '#lib/actions/transports.ts';
import {
	create_realtime_closer,
	create_revocation_guard,
	to_connection_close_target,
	type ConnectionCloser
} from '#lib/actions/connection_closer.ts';
import { create_sse_connection_closer } from '#lib/realtime/audit_log_sse.ts';
import { SubscriberRegistry } from '#lib/realtime/subscriber_registry.ts';
import type { SseStream } from '#lib/realtime/sse.ts';
import { create_test_audit_event } from '#lib/testing/entities.ts';
import {
	AUDIT_EVENT_TYPES,
	audit_event_revocation_scopes,
	to_revocation_scope,
	type AuditLogEvent,
	type RevocationScope
} from '#lib/auth/audit_log_schema.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';

interface FakeWs {
	ws: WSContext;
	closes: Array<{ code?: number; reason?: string }>;
	sends: Array<string>;
}

const create_fake_ws = (): FakeWs => {
	const closes: Array<{ code?: number; reason?: string }> = [];
	const sends: Array<string> = [];
	const init: WSContextInit = {
		send: (data) => {
			sends.push(data as string);
		},
		close: (code, reason) => {
			closes.push({ code, reason });
		},
		readyState: 1
	};
	return { ws: new WSContext(init), closes, sends };
};

const silent_log = new Logger('ws_auth_guard_test', { level: 'off' });

const create_audit_event = (overrides: Partial<AuditLogEvent>): AuditLogEvent => ({
	id: create_uuid(),
	seq: 1,
	event_type: 'session_revoke',
	outcome: 'success',
	actor_id: null,
	account_id: null,
	target_account_id: null,
	target_actor_id: null,
	ip: null,
	created_at: new Date().toISOString(),
	metadata: null,
	...overrides
});

const ACCOUNT_A: Uuid = create_uuid();
const ACCOUNT_B: Uuid = create_uuid();
const HASH_A = 'session_hash_a';
const HASH_B = 'session_hash_b';
const TOKEN_A = 'token_id_a';
const TOKEN_B = 'token_id_b';

describe('audit_event_revocation_scopes', () => {
	// The events whose success invalidates a live connection, and what each
	// invalidates — the twin of the `revocation_scope` column of the Rust
	// spine's `AUDIT_EVENT_SPECS`. Everything else is `none`.
	const revoking: Record<string, RevocationScope> = {
		logout: 'account',
		password_change: 'account',
		session_revoke_all: 'account',
		token_revoke_all: 'account',
		account_delete: 'account',
		account_purge: 'account',
		session_revoke: 'session',
		token_revoke: 'token',
		role_grant_revoke: 'role'
	};

	test('declares a scope for every builtin event type', () => {
		assert.deepStrictEqual(
			Object.keys(audit_event_revocation_scopes).sort(),
			[...AUDIT_EVENT_TYPES].sort()
		);
	});

	test('only the revoking events have a scope other than none', () => {
		for (const event_type of AUDIT_EVENT_TYPES) {
			assert.strictEqual(
				audit_event_revocation_scopes[event_type],
				revoking[event_type] ?? 'none',
				event_type
			);
		}
	});

	test('to_revocation_scope resolves an unknown event type to none', () => {
		assert.strictEqual(to_revocation_scope('session_revoke'), 'session');
		// a consumer's own event must not close connections
		assert.strictEqual(to_revocation_scope('classroom_create'), 'none');
		// nor may an inherited object key resolve to anything
		assert.strictEqual(to_revocation_scope('constructor'), 'none');
		assert.strictEqual(to_revocation_scope('toString'), 'none');
	});
});

describe('to_connection_close_target', () => {
	// the twin of the Rust spine's `ConnectionCloseTarget::from_audit_event`
	test('maps each revoking scope to its target', () => {
		assert.deepStrictEqual(
			to_connection_close_target(
				create_audit_event({ event_type: 'session_revoke', metadata: { session_id: HASH_A } })
			),
			{ kind: 'session', session_hash: HASH_A }
		);
		assert.deepStrictEqual(
			to_connection_close_target(
				create_audit_event({ event_type: 'token_revoke', metadata: { token_id: TOKEN_A } })
			),
			{ kind: 'token', api_token_id: TOKEN_A }
		);
		assert.deepStrictEqual(
			to_connection_close_target(
				create_audit_event({ event_type: 'password_change', account_id: ACCOUNT_A })
			),
			{ kind: 'account', account_id: ACCOUNT_A }
		);
		assert.deepStrictEqual(
			to_connection_close_target(
				create_audit_event({
					event_type: 'role_grant_revoke',
					account_id: ACCOUNT_B,
					target_account_id: ACCOUNT_A,
					metadata: { role: 'admin', role_grant_id: create_uuid(), scope_id: null }
				})
			),
			{ kind: 'role', account_id: ACCOUNT_A, role: 'admin' }
		);
	});

	test('an admin action targets target_account_id, a self-service one account_id', () => {
		assert.deepStrictEqual(
			to_connection_close_target(
				create_audit_event({
					event_type: 'session_revoke_all',
					account_id: ACCOUNT_B,
					target_account_id: ACCOUNT_A
				})
			),
			{ kind: 'account', account_id: ACCOUNT_A }
		);
		assert.deepStrictEqual(
			to_connection_close_target(
				create_audit_event({ event_type: 'session_revoke_all', account_id: ACCOUNT_B })
			),
			{ kind: 'account', account_id: ACCOUNT_B }
		);
		assert.deepStrictEqual(
			to_connection_close_target(
				create_audit_event({
					event_type: 'role_grant_revoke',
					account_id: ACCOUNT_B,
					metadata: { role: 'admin', role_grant_id: create_uuid(), self_service: true }
				})
			),
			{ kind: 'role', account_id: ACCOUNT_B, role: 'admin' }
		);
	});

	test('a row whose outcome is not success maps to nothing', () => {
		for (const outcome of ['failure', 'unknown'] as const) {
			assert.strictEqual(
				to_connection_close_target(
					create_audit_event({
						event_type: 'session_revoke',
						outcome: outcome as AuditLogEvent['outcome'],
						metadata: { session_id: HASH_A }
					})
				),
				null,
				outcome
			);
		}
		assert.strictEqual(
			to_connection_close_target(
				create_audit_event({ event_type: 'logout', outcome: 'failure', account_id: ACCOUNT_A })
			),
			null
		);
	});

	test('an event that revokes nothing maps to nothing, whatever it carries', () => {
		for (const event_type of ['login', 'token_create', 'not_a_fuz_app_event']) {
			assert.strictEqual(
				to_connection_close_target(
					create_audit_event({
						event_type,
						account_id: ACCOUNT_A,
						metadata: { session_id: HASH_A, token_id: TOKEN_A, role: 'admin' }
					})
				),
				null,
				event_type
			);
		}
	});

	test('a row missing the key its scope closes by maps to nothing', () => {
		const missing: Array<AuditLogEvent> = [
			create_audit_event({ event_type: 'session_revoke', metadata: null }),
			create_audit_event({ event_type: 'session_revoke', metadata: { session_id: '' } }),
			create_audit_event({ event_type: 'session_revoke', metadata: { session_id: 7 } }),
			create_audit_event({ event_type: 'token_revoke', metadata: {} }),
			create_audit_event({ event_type: 'token_revoke', metadata: { token_id: '' } }),
			create_audit_event({ event_type: 'account_delete' }),
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: ACCOUNT_A,
				metadata: { role_grant_id: create_uuid() }
			}),
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: ACCOUNT_A,
				metadata: { role: '' }
			}),
			create_audit_event({ event_type: 'role_grant_revoke', metadata: { role: 'admin' } })
		];
		for (const event of missing) {
			assert.strictEqual(to_connection_close_target(event), null, JSON.stringify(event.metadata));
		}
	});

	test('a scoped role revoke maps to nothing — a role gate admits on global grants only', () => {
		assert.strictEqual(
			to_connection_close_target(
				create_audit_event({
					event_type: 'role_grant_revoke',
					target_account_id: ACCOUNT_A,
					metadata: { role: 'admin', role_grant_id: create_uuid(), scope_id: create_uuid() }
				})
			),
			null
		);
	});
});

describe('create_revocation_guard: session_revoke', () => {
	test('closes only the socket tied to the revoked session hash', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);

		const session_a = create_fake_ws();
		const session_b = create_fake_ws();
		const bearer = create_fake_ws();
		transport.add_connection(session_a.ws, HASH_A, ACCOUNT_A);
		transport.add_connection(session_b.ws, HASH_B, ACCOUNT_A);
		transport.add_connection(bearer.ws, null, ACCOUNT_A, TOKEN_A);

		guard(
			create_audit_event({
				event_type: 'session_revoke',
				account_id: ACCOUNT_A,
				metadata: { session_id: HASH_A }
			})
		);

		assert.strictEqual(session_a.closes.length, 1);
		assert.strictEqual(session_b.closes.length, 0);
		assert.strictEqual(bearer.closes.length, 0);
	});

	test('no-op when metadata.session_id is missing', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'session_revoke', metadata: null }));
		assert.strictEqual(closes.length, 0);
	});

	test('no-op when metadata.session_id is an empty string', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'session_revoke', metadata: { session_id: '' } }));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_revocation_guard: token_revoke', () => {
	test('closes only the bearer socket tied to the revoked api_token.id', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);

		const bearer_a = create_fake_ws();
		const bearer_b = create_fake_ws();
		const session = create_fake_ws();
		transport.add_connection(bearer_a.ws, null, ACCOUNT_A, TOKEN_A);
		transport.add_connection(bearer_b.ws, null, ACCOUNT_A, TOKEN_B);
		transport.add_connection(session.ws, HASH_A, ACCOUNT_A);

		guard(
			create_audit_event({
				event_type: 'token_revoke',
				account_id: ACCOUNT_A,
				metadata: { token_id: TOKEN_A }
			})
		);

		assert.strictEqual(bearer_a.closes.length, 1);
		assert.strictEqual(bearer_b.closes.length, 0);
		assert.strictEqual(session.closes.length, 0, 'session sockets must not be torn down');
	});

	test('no-op when metadata.token_id is missing', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, null, ACCOUNT_A, TOKEN_A);

		guard(create_audit_event({ event_type: 'token_revoke', metadata: null }));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_revocation_guard: account-scoped events', () => {
	const account_scoped_events = [
		'session_revoke_all',
		'token_revoke_all',
		'password_change',
		'logout',
		'account_delete',
		'account_purge'
	] as const;

	for (const event_type of account_scoped_events) {
		test(`${event_type} closes every socket on the target account`, () => {
			const transport = new BackendWebsocketTransport();
			const guard = create_revocation_guard(transport, silent_log);

			const session = create_fake_ws();
			const bearer = create_fake_ws();
			const daemon = create_fake_ws();
			const other_account = create_fake_ws();
			transport.add_connection(session.ws, HASH_A, ACCOUNT_A);
			transport.add_connection(bearer.ws, null, ACCOUNT_A, TOKEN_A);
			transport.add_connection(daemon.ws, null, ACCOUNT_A);
			transport.add_connection(other_account.ws, HASH_B, ACCOUNT_B);

			guard(create_audit_event({ event_type, account_id: ACCOUNT_A }));

			assert.strictEqual(session.closes.length, 1);
			assert.strictEqual(bearer.closes.length, 1);
			assert.strictEqual(daemon.closes.length, 1);
			assert.strictEqual(other_account.closes.length, 0);
		});
	}

	test('admin-initiated events use target_account_id over account_id', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);

		const target = create_fake_ws();
		const admin = create_fake_ws();
		transport.add_connection(target.ws, HASH_A, ACCOUNT_A);
		transport.add_connection(admin.ws, HASH_B, ACCOUNT_B);

		guard(
			create_audit_event({
				event_type: 'session_revoke_all',
				account_id: ACCOUNT_B, // admin's own account
				target_account_id: ACCOUNT_A // the victim
			})
		);

		assert.strictEqual(target.closes.length, 1);
		assert.strictEqual(admin.closes.length, 0, 'admin must not self-disconnect');
	});

	test('no-op when both account_id and target_account_id are null', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'password_change' }));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_revocation_guard: safety', () => {
	test('ignores outcome=failure events (attacker-controlled metadata)', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		// attacker submits a valid session hash on a failed revoke; guard must not act
		guard(
			create_audit_event({
				event_type: 'session_revoke',
				outcome: 'failure',
				metadata: { session_id: HASH_A }
			})
		);
		assert.strictEqual(closes.length, 0);
	});

	test('ignores outcome=failure for account-scoped events', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(
			create_audit_event({
				event_type: 'password_change',
				outcome: 'failure',
				account_id: ACCOUNT_A
			})
		);
		assert.strictEqual(closes.length, 0);
	});

	test('ignores an outcome outside the enum — only a success revokes', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard({
			...create_audit_event({ event_type: 'session_revoke', metadata: { session_id: HASH_A } }),
			outcome: 'unknown' as 'success'
		});
		assert.strictEqual(closes.length, 0);
	});

	test('ignores logout with outcome=failure', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'logout', outcome: 'failure', account_id: ACCOUNT_A }));
		assert.strictEqual(closes.length, 0);
	});

	test('ignores events that revoke nothing (login, token_create, account_undelete, …)', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		for (const event_type of AUDIT_EVENT_TYPES) {
			if (audit_event_revocation_scopes[event_type] !== 'none') continue;
			guard(
				create_audit_event({
					event_type,
					account_id: ACCOUNT_A,
					target_account_id: ACCOUNT_A,
					metadata: { session_id: HASH_A }
				})
			);
		}
		assert.strictEqual(closes.length, 0);
	});

	test('ignores an event type fuz_app does not define, whatever its metadata', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(
			create_audit_event({
				event_type: 'consumer_session_revoke',
				account_id: ACCOUNT_A,
				target_account_id: ACCOUNT_A,
				metadata: { session_id: HASH_A }
			})
		);
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_revocation_guard: role_grant_revoke', () => {
	const PERMISSION_REVOKED_CLOSE = {
		code: WS_CLOSE_PERMISSION_REVOKED,
		reason: WS_CLOSE_PERMISSION_REVOKED_REASON
	};

	/** The admin revoking `ACCOUNT_A`'s grant of `role`, global unless `scope_id` is given. */
	const revoke_event = (role: string, scope_id: string | null = null): AuditLogEvent =>
		create_audit_event({
			event_type: 'role_grant_revoke',
			account_id: ACCOUNT_B,
			target_account_id: ACCOUNT_A,
			metadata: { role, role_grant_id: create_uuid(), scope_id }
		});

	test('closes only the target account sockets gated on the revoked role, with 4006', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);

		const gated = create_fake_ws();
		const ungated = create_fake_ws();
		const other_role = create_fake_ws();
		const other_account = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin']);
		transport.add_connection(ungated.ws, HASH_A, ACCOUNT_A);
		transport.add_connection(other_role.ws, HASH_A, ACCOUNT_A, null, null, ['keeper']);
		transport.add_connection(other_account.ws, HASH_B, ACCOUNT_B, null, null, ['admin']);
		// a registration still pending admission is reached too
		const pending = create_fake_ws();
		const pending_id = transport.register_pending(pending.ws, HASH_A, ACCOUNT_A, null, null, [
			'admin'
		]);

		guard(revoke_event('admin'));

		assert.deepStrictEqual(gated.closes, [PERMISSION_REVOKED_CLOSE]);
		assert.deepStrictEqual(pending.closes, [PERMISSION_REVOKED_CLOSE]);
		assert.strictEqual(transport.admit(pending_id), false, 'the pending one is refused');
		assert.deepStrictEqual(ungated.closes, [], "the account's ungated socket stays open");
		assert.deepStrictEqual(other_role.closes, [], 'a socket gated on another role stays open');
		assert.deepStrictEqual(other_account.closes, [], "another account's socket stays open");
		assert.strictEqual(transport.get_connection_count(), 3);
	});

	test('nothing is sent on a socket after its permission-revoked close', async () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const gated = create_fake_ws();
		const ungated = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin']);
		transport.add_connection(ungated.ws, HASH_A, ACCOUNT_A);

		guard(revoke_event('admin'));
		const frame = { jsonrpc: '2.0' as const, method: 'thing_changed', params: {} };
		assert.strictEqual(transport.send_to_account(ACCOUNT_A, frame), 1, 'the ungated one only');
		assert.strictEqual(
			transport.broadcast_filtered(frame, () => true),
			1
		);

		// the second frame of a synchronous run is written on a later tick
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepStrictEqual(gated.sends, []);
		assert.strictEqual(ungated.sends.length, 2);
	});

	test('a scoped revoke closes nothing — a role gate admits on global grants only', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const gated = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin']);

		guard(revoke_event('admin', create_uuid()));
		assert.deepStrictEqual(gated.closes, []);
		assert.strictEqual(transport.get_connection_count(), 1);
	});

	test('over-closes an any-of gate on the loss of any listed role', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const gated = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin', 'keeper']);

		guard(revoke_event('keeper'));
		assert.deepStrictEqual(gated.closes, [PERMISSION_REVOKED_CLOSE]);
	});

	test('a self-service revoke, with no target account, closes the actor account', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const gated = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin']);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				account_id: ACCOUNT_A,
				metadata: { role: 'admin', role_grant_id: create_uuid(), self_service: true }
			})
		);
		assert.deepStrictEqual(gated.closes, [PERMISSION_REVOKED_CLOSE]);
	});

	test('no-op without metadata.role, and on a failure row', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_revocation_guard(transport, silent_log);
		const gated = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin']);

		guard(
			create_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: ACCOUNT_A,
				metadata: { role_grant_id: create_uuid() }
			})
		);
		guard({ ...revoke_event('admin'), outcome: 'failure' });
		assert.deepStrictEqual(gated.closes, []);
	});
});

describe('create_revocation_guard: over a RealtimeCloser', () => {
	test('one guard closes on every member transport', () => {
		const first = new BackendWebsocketTransport();
		const second = new BackendWebsocketTransport();
		const closer = create_realtime_closer();
		closer.add(first);
		closer.add(second);
		const guard = create_revocation_guard(closer, silent_log);

		const on_first = create_fake_ws();
		const on_second = create_fake_ws();
		const other = create_fake_ws();
		first.add_connection(on_first.ws, HASH_A, ACCOUNT_A);
		second.add_connection(on_second.ws, 'session_hash_a2', ACCOUNT_A);
		second.add_connection(other.ws, HASH_B, ACCOUNT_B);

		guard(create_audit_event({ event_type: 'logout', account_id: ACCOUNT_A }));

		assert.strictEqual(on_first.closes.length, 1);
		assert.strictEqual(on_second.closes.length, 1);
		assert.strictEqual(other.closes.length, 0);
	});
});

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

/** The guard over one SSE registry, as `create_app_server` reaches it through the closer. */
const create_sse_guard = <T>(
	registry: SubscriberRegistry<T>,
	required_role: string | null,
	log: Logger
): ((event: AuditLogEvent) => void) =>
	create_revocation_guard(create_sse_connection_closer(registry, required_role), log);

describe('create_revocation_guard: over an SSE registry', () => {
	test('closes stream when role_grant_revoke matches required role and target account', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['target-account-1'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'target-account-1',
				metadata: { role: 'admin', role_grant_id: 'p-1' }
			})
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('does not close stream on a scoped revoke of the required role', () => {
		// the stream's role gate admits on global grants only
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['target-account-1'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'target-account-1',
				metadata: { role: 'admin', role_grant_id: 'p-1', scope_id: 'scope-1' }
			})
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);

		// the same role's global revoke closes it
		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'target-account-1',
				metadata: { role: 'admin', role_grant_id: 'p-2', scope_id: null }
			})
		);
		assert.ok(stream.closed);
	});

	test('does not close stream when revoked role does not match required role', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['target-account-1'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'target-account-1',
				metadata: { role: 'steward', role_grant_id: 'p-1' }
			})
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('does not close stream when target_account_id does not match', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-b',
				metadata: { role: 'admin', role_grant_id: 'p-1' }
			})
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('ignores every event that revokes nothing', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {
			channels: ['audit_log'],
			scope: 'session-hash-1',
			groups: ['target-account-1']
		});

		const guard = create_sse_guard(registry, 'admin', silent_log);

		for (const event_type of AUDIT_EVENT_TYPES) {
			if (audit_event_revocation_scopes[event_type] !== 'none') continue;
			guard(
				create_test_audit_event({
					event_type,
					account_id: 'target-account-1',
					target_account_id: 'target-account-1',
					metadata: { role: 'admin', session_id: 'session-hash-1' }
				})
			);
		}

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('ignores an event type fuz_app does not define', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { scope: 'session-hash-1', groups: ['target-account-1'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);
		guard(
			create_test_audit_event({
				event_type: 'consumer_session_revoke',
				account_id: 'target-account-1',
				target_account_id: 'target-account-1',
				metadata: { session_id: 'session-hash-1' }
			})
		);

		assert.ok(!stream.closed);
	});

	for (const event_type of [
		'account_delete',
		'account_purge',
		'logout',
		'token_revoke_all'
	] as const) {
		test(`${event_type} closes the target account's streams and no other's`, () => {
			const registry = new SubscriberRegistry<string>();
			const target = create_mock_stream<string>();
			registry.subscribe(target, { scope: 'session-hash-1', groups: ['target-account-1'] });
			const actor = create_mock_stream<string>();
			registry.subscribe(actor, { scope: 'session-hash-2', groups: ['admin-account-1'] });

			const guard = create_sse_guard(registry, 'admin', silent_log);
			guard(
				create_test_audit_event({
					event_type,
					account_id: 'admin-account-1',
					target_account_id: 'target-account-1'
				})
			);

			assert.ok(target.closed);
			assert.ok(!actor.closed, 'the acting account keeps its stream');
		});
	}

	test('token_revoke closes the stream registered under the revoked token id', () => {
		const registry = new SubscriberRegistry<string>();
		const bearer = create_mock_stream<string>();
		registry.subscribe(bearer, { scope: 'tok_revoked', groups: ['account-1'] });
		const session = create_mock_stream<string>();
		registry.subscribe(session, { scope: 'session-hash-1', groups: ['account-1'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);
		guard(
			create_test_audit_event({
				event_type: 'token_revoke',
				account_id: 'account-1',
				metadata: { token_id: 'tok_revoked' }
			})
		);

		assert.ok(bearer.closed);
		assert.ok(!session.closed, "the account's session streams are left alone");
	});

	test('skips token_revoke with outcome=failure', () => {
		const registry = new SubscriberRegistry<string>();
		const bearer = create_mock_stream<string>();
		registry.subscribe(bearer, { scope: 'tok_guessed', groups: ['account-1'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);
		guard(
			create_test_audit_event({
				event_type: 'token_revoke',
				outcome: 'failure',
				account_id: 'attacker-account',
				metadata: { token_id: 'tok_guessed' }
			})
		);

		assert.ok(!bearer.closed);
	});

	test('skips an outcome outside the enum — only a success revokes', () => {
		const registry = new SubscriberRegistry<string>();
		const bearer = create_mock_stream<string>();
		registry.subscribe(bearer, { scope: 'tok_revoked', groups: ['account-1'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);
		guard({
			...create_test_audit_event({
				event_type: 'token_revoke',
				account_id: 'account-1',
				metadata: { token_id: 'tok_revoked' }
			}),
			outcome: 'unknown' as 'success'
		});

		assert.ok(!bearer.closed);
	});

	test('ignores events with null target_account_id', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: null,
				metadata: { role: 'admin', role_grant_id: 'p-1' }
			})
		);

		assert.ok(!stream.closed);
	});

	test('ignores role_grant_revoke with null metadata', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: null
			})
		);

		assert.ok(!stream.closed);
	});

	test('ignores role_grant_revoke with metadata missing role field', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: { role_grant_id: 'p-1' }
			})
		);

		assert.ok(!stream.closed);
	});

	test('null required_role skips role_grant_revoke but still closes on session/password events', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, null, silent_log);

		// role_grant_revoke is ignored — stream not gated by any role
		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: { role: 'admin', role_grant_id: 'p-1' }
			})
		);
		assert.ok(!stream.closed);

		// session_revoke_all still closes — session-level revocation applies regardless of role
		guard(
			create_test_audit_event({
				event_type: 'session_revoke_all',
				target_account_id: 'account-a'
			})
		);
		assert.ok(stream.closed);
	});

	test('closes multiple streams for the same account', () => {
		const registry = new SubscriberRegistry<string>();
		const stream1 = create_mock_stream<string>();
		const stream2 = create_mock_stream<string>();
		registry.subscribe(stream1, { channels: ['audit_log'], groups: ['account-a'] });
		registry.subscribe(stream2, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: { role: 'admin', role_grant_id: 'p-1' }
			})
		);

		assert.ok(stream1.closed);
		assert.ok(stream2.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('does not close streams belonging to other accounts', () => {
		const registry = new SubscriberRegistry<string>();
		const stream_a = create_mock_stream<string>();
		const stream_b = create_mock_stream<string>();
		registry.subscribe(stream_a, { channels: ['audit_log'], groups: ['account-a'] });
		registry.subscribe(stream_b, { channels: ['audit_log'], groups: ['account-b'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				target_account_id: 'account-a',
				metadata: { role: 'admin', role_grant_id: 'p-1' }
			})
		);

		assert.ok(stream_a.closed);
		assert.ok(!stream_b.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('handles login event without crashing', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'login',
				account_id: 'account-a',
				metadata: { username: 'alice' }
			})
		);

		assert.ok(!stream.closed);
	});

	test('session_revoke_all closes streams via target_account_id (admin action)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		// admin revoking another user's sessions — sets target_account_id
		guard(
			create_test_audit_event({
				event_type: 'session_revoke_all',
				account_id: 'admin-account',
				target_account_id: 'account-a',
				metadata: { count: 3 }
			})
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('session_revoke_all closes streams via account_id (self-service)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		// user revoking own sessions — only account_id set, no target_account_id
		guard(
			create_test_audit_event({
				event_type: 'session_revoke_all',
				account_id: 'account-a',
				target_account_id: null,
				metadata: { count: 3 }
			})
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});

	test('session_revoke_all does not close streams for other accounts', () => {
		const registry = new SubscriberRegistry<string>();
		const stream_a = create_mock_stream<string>();
		const stream_b = create_mock_stream<string>();
		registry.subscribe(stream_a, { channels: ['audit_log'], groups: ['account-a'] });
		registry.subscribe(stream_b, { channels: ['audit_log'], groups: ['account-b'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'session_revoke_all',
				target_account_id: 'account-a',
				metadata: { count: 1 }
			})
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
			groups: ['account-a']
		});

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-b', // attacker B attempting to revoke A's session
				outcome: 'failure',
				metadata: { session_id: 'session-hash-a' }
			})
		);

		assert.ok(!stream.closed, 'failed session_revoke must not close the victim stream');
		assert.strictEqual(registry.count, 1);
	});

	test('skips password_change with outcome=failure', () => {
		// Wrong current password — user is still authenticated, sessions are still
		// valid. No reason to close their SSE stream.
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'password_change',
				account_id: 'account-a',
				outcome: 'failure',
				metadata: null
			})
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
			groups: ['account-a']
		});
		registry.subscribe(session_y_stream, {
			channels: ['audit_log'],
			scope: 'session-hash-y',
			groups: ['account-a']
		});

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-a',
				outcome: 'success',
				metadata: { session_id: 'session-hash-x' }
			})
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
			groups: ['account-a']
		});

		const guard = create_sse_guard(registry, 'admin', silent_log);

		// outcome=success but metadata is malformed — guard must not crash
		// and must not attempt any close
		guard(
			create_test_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-a',
				outcome: 'success',
				metadata: null
			})
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('session_revoke does NOT close account-keyed-only streams (coarser subscribers)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		// subscriber that only tracks account identity (no session hash) — e.g. a
		// legacy or non-session-keyed subscription. session_revoke must not affect it.
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		guard(
			create_test_audit_event({
				event_type: 'session_revoke',
				account_id: 'account-a',
				outcome: 'success',
				metadata: { session_id: 'session-hash-x' }
			})
		);

		assert.ok(!stream.closed);
		assert.strictEqual(registry.count, 1);
	});

	test('password_change closes streams via account_id (self-service)', () => {
		const registry = new SubscriberRegistry<string>();
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, { channels: ['audit_log'], groups: ['account-a'] });

		const guard = create_sse_guard(registry, 'admin', silent_log);

		// password_change is self-service — only account_id set, no target_account_id
		guard(
			create_test_audit_event({
				event_type: 'password_change',
				account_id: 'account-a',
				target_account_id: null,
				metadata: { sessions_revoked: 2 }
			})
		);

		assert.ok(stream.closed);
		assert.strictEqual(registry.count, 0);
	});
});

/**
 * The shape `create_app_server` builds: one guard on the backend's closer, its
 * members a WebSocket transport and the audit stream registry. Every revoking
 * scope closes on both, and a failure row closes on neither — one listener
 * where each transport used to register its own.
 */
describe('create_revocation_guard: one guard over a WS transport and an SSE registry', () => {
	const ROLE = 'admin';
	const build = (): {
		closer: ConnectionCloser;
		transport: BackendWebsocketTransport;
		registry: SubscriberRegistry<string>;
		guard: (event: AuditLogEvent) => void;
	} => {
		const transport = new BackendWebsocketTransport();
		const registry = new SubscriberRegistry<string>();
		const closer = create_realtime_closer();
		closer.add(transport);
		closer.add(create_sse_connection_closer(registry, ROLE));
		return { closer, transport, registry, guard: create_revocation_guard(closer, silent_log) };
	};
	/** A socket and a stream of `ACCOUNT_A`, both opened on session `HASH_A` and token `TOKEN_A`. */
	const open_both = (
		transport: BackendWebsocketTransport,
		registry: SubscriberRegistry<string>
	): { socket: FakeWs; stream: ReturnType<typeof create_mock_stream<string>> } => {
		const socket = create_fake_ws();
		transport.add_connection(socket.ws, HASH_A, ACCOUNT_A, TOKEN_A, null, [ROLE]);
		const stream = create_mock_stream<string>();
		registry.subscribe(stream, {
			channels: ['audit_log'],
			scope: HASH_A,
			groups: [ACCOUNT_A, TOKEN_A]
		});
		return { socket, stream };
	};

	const revocations: Array<[string, Partial<AuditLogEvent>]> = [
		[
			'session',
			{ event_type: 'session_revoke', account_id: ACCOUNT_A, metadata: { session_id: HASH_A } }
		],
		[
			'token',
			{ event_type: 'token_revoke', account_id: ACCOUNT_A, metadata: { token_id: TOKEN_A } }
		],
		['account', { event_type: 'password_change', account_id: ACCOUNT_A }],
		[
			'role',
			{
				event_type: 'role_grant_revoke',
				target_account_id: ACCOUNT_A,
				metadata: { role: ROLE, role_grant_id: 'g-1' }
			}
		]
	];

	for (const [scope, event] of revocations) {
		test(`a ${scope} revocation closes the socket and the stream`, () => {
			const { transport, registry, guard } = build();
			const { socket, stream } = open_both(transport, registry);
			guard(create_test_audit_event(event));
			assert.strictEqual(socket.closes.length, 1, 'the socket closed');
			assert.ok(stream.closed, 'the stream closed');
		});

		test(`a ${scope} failure row closes neither`, () => {
			const { transport, registry, guard } = build();
			const { socket, stream } = open_both(transport, registry);
			guard(create_test_audit_event({ ...event, outcome: 'failure' }));
			assert.deepStrictEqual(socket.closes, []);
			assert.ok(!stream.closed);
		});
	}
});
