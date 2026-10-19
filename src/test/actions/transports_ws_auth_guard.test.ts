/**
 * Tests for `create_ws_auth_guard` — audit event dispatch onto the
 * backend WebSocket transport's `close_sockets_for_*` methods, by the
 * `RevocationScope` each event declares — and for that declaration,
 * `audit_event_revocation_scopes`.
 *
 * Uses a real `BackendWebsocketTransport` with fake `WSContext` instances
 * so we verify the end-to-end close path rather than stubbing the transport.
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
import { create_ws_auth_guard } from '#lib/actions/transports_ws_auth_guard.ts';
import { create_realtime_closer } from '#lib/actions/connection_closer.ts';
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

describe('create_ws_auth_guard: session_revoke', () => {
	test('closes only the socket tied to the revoked session hash', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);

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
		const guard = create_ws_auth_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'session_revoke', metadata: null }));
		assert.strictEqual(closes.length, 0);
	});

	test('no-op when metadata.session_id is an empty string', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'session_revoke', metadata: { session_id: '' } }));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_ws_auth_guard: token_revoke', () => {
	test('closes only the bearer socket tied to the revoked api_token.id', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);

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
		const guard = create_ws_auth_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, null, ACCOUNT_A, TOKEN_A);

		guard(create_audit_event({ event_type: 'token_revoke', metadata: null }));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_ws_auth_guard: account-scoped events', () => {
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
			const guard = create_ws_auth_guard(transport, silent_log);

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
		const guard = create_ws_auth_guard(transport, silent_log);

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
		const guard = create_ws_auth_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'password_change' }));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_ws_auth_guard: safety', () => {
	test('ignores outcome=failure events (attacker-controlled metadata)', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
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
		const guard = create_ws_auth_guard(transport, silent_log);
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

	test('ignores logout with outcome=failure', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const { ws, closes } = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({ event_type: 'logout', outcome: 'failure', account_id: ACCOUNT_A }));
		assert.strictEqual(closes.length, 0);
	});

	test('ignores events that revoke nothing (login, token_create, account_undelete, …)', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
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
		const guard = create_ws_auth_guard(transport, silent_log);
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

describe('create_ws_auth_guard: role_grant_revoke', () => {
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
		const guard = create_ws_auth_guard(transport, silent_log);

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
		const guard = create_ws_auth_guard(transport, silent_log);
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
		const guard = create_ws_auth_guard(transport, silent_log);
		const gated = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin']);

		guard(revoke_event('admin', create_uuid()));
		assert.deepStrictEqual(gated.closes, []);
		assert.strictEqual(transport.get_connection_count(), 1);
	});

	test('over-closes an any-of gate on the loss of any listed role', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const gated = create_fake_ws();
		transport.add_connection(gated.ws, HASH_A, ACCOUNT_A, null, null, ['admin', 'keeper']);

		guard(revoke_event('keeper'));
		assert.deepStrictEqual(gated.closes, [PERMISSION_REVOKED_CLOSE]);
	});

	test('a self-service revoke, with no target account, closes the actor account', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
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
		const guard = create_ws_auth_guard(transport, silent_log);
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

describe('create_ws_auth_guard: over a RealtimeCloser', () => {
	test('one guard closes on every member transport', () => {
		const first = new BackendWebsocketTransport();
		const second = new BackendWebsocketTransport();
		const closer = create_realtime_closer();
		closer.add(first);
		closer.add(second);
		const guard = create_ws_auth_guard(closer, silent_log);

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
