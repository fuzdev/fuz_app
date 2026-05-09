/**
 * Tests for `create_ws_auth_guard` — audit event dispatch onto the
 * backend WebSocket transport's `close_sockets_for_*` methods.
 *
 * Uses a real `BackendWebsocketTransport` with fake `WSContext` instances
 * so we verify the end-to-end close path rather than stubbing the transport.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {WSContext, type WSContextInit} from 'hono/ws';

import {BackendWebsocketTransport} from '$lib/actions/transports_ws_backend.js';
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
	WS_DISCONNECT_EVENT_TYPES,
} from '$lib/actions/transports_ws_auth_guard.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.js';

interface FakeWs {
	ws: WSContext;
	closes: Array<{code?: number; reason?: string}>;
}

const create_fake_ws = (): FakeWs => {
	const closes: Array<{code?: number; reason?: string}> = [];
	const init: WSContextInit = {
		send: () => {},
		close: (code, reason) => {
			closes.push({code, reason});
		},
		readyState: 1,
	};
	return {ws: new WSContext(init), closes};
};

const silent_log = new Logger('ws_auth_guard_test', {level: 'off'});

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
	...overrides,
});

const ACCOUNT_A: Uuid = create_uuid();
const ACCOUNT_B: Uuid = create_uuid();
const HASH_A = 'session_hash_a';
const HASH_B = 'session_hash_b';
const TOKEN_A = 'token_id_a';
const TOKEN_B = 'token_id_b';

describe('WS_DISCONNECT_EVENT_TYPES', () => {
	test('includes token_revoke and token_revoke_all (the new granular scopes)', () => {
		assert.ok(WS_DISCONNECT_EVENT_TYPES.has('token_revoke'));
		assert.ok(WS_DISCONNECT_EVENT_TYPES.has('token_revoke_all'));
	});

	test('includes session_revoke, session_revoke_all, password_change', () => {
		assert.ok(WS_DISCONNECT_EVENT_TYPES.has('session_revoke'));
		assert.ok(WS_DISCONNECT_EVENT_TYPES.has('session_revoke_all'));
		assert.ok(WS_DISCONNECT_EVENT_TYPES.has('password_change'));
	});

	test('excludes role_grant_revoke (role-scoped disconnection not tracked)', () => {
		assert.ok(!WS_DISCONNECT_EVENT_TYPES.has('role_grant_revoke'));
	});

	test('excludes non-disconnect events (login, logout, bootstrap, etc.)', () => {
		assert.ok(!WS_DISCONNECT_EVENT_TYPES.has('login'));
		assert.ok(!WS_DISCONNECT_EVENT_TYPES.has('logout'));
		assert.ok(!WS_DISCONNECT_EVENT_TYPES.has('bootstrap'));
		assert.ok(!WS_DISCONNECT_EVENT_TYPES.has('token_create'));
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
				metadata: {session_id: HASH_A},
			}),
		);

		assert.strictEqual(session_a.closes.length, 1);
		assert.strictEqual(session_b.closes.length, 0);
		assert.strictEqual(bearer.closes.length, 0);
	});

	test('no-op when metadata.session_id is missing', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({event_type: 'session_revoke', metadata: null}));
		assert.strictEqual(closes.length, 0);
	});

	test('no-op when metadata.session_id is an empty string', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({event_type: 'session_revoke', metadata: {session_id: ''}}));
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
				metadata: {token_id: TOKEN_A},
			}),
		);

		assert.strictEqual(bearer_a.closes.length, 1);
		assert.strictEqual(bearer_b.closes.length, 0);
		assert.strictEqual(session.closes.length, 0, 'session sockets must not be torn down');
	});

	test('no-op when metadata.token_id is missing', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, null, ACCOUNT_A, TOKEN_A);

		guard(create_audit_event({event_type: 'token_revoke', metadata: null}));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_ws_auth_guard: account-scoped events', () => {
	const account_scoped_events = [
		'session_revoke_all',
		'token_revoke_all',
		'password_change',
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

			guard(create_audit_event({event_type, account_id: ACCOUNT_A}));

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
				target_account_id: ACCOUNT_A, // the victim
			}),
		);

		assert.strictEqual(target.closes.length, 1);
		assert.strictEqual(admin.closes.length, 0, 'admin must not self-disconnect');
	});

	test('no-op when both account_id and target_account_id are null', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(create_audit_event({event_type: 'password_change'}));
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_ws_auth_guard: safety', () => {
	test('ignores outcome=failure events (attacker-controlled metadata)', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		// attacker submits a valid session hash on a failed revoke; guard must not act
		guard(
			create_audit_event({
				event_type: 'session_revoke',
				outcome: 'failure',
				metadata: {session_id: HASH_A},
			}),
		);
		assert.strictEqual(closes.length, 0);
	});

	test('ignores outcome=failure for account-scoped events', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		guard(
			create_audit_event({
				event_type: 'password_change',
				outcome: 'failure',
				account_id: ACCOUNT_A,
			}),
		);
		assert.strictEqual(closes.length, 0);
	});

	test('ignores non-disconnect event types (login, token_create, role_grant_revoke, etc.)', () => {
		const transport = new BackendWebsocketTransport();
		const guard = create_ws_auth_guard(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		for (const event_type of ['login', 'logout', 'token_create', 'role_grant_revoke'] as const) {
			guard(create_audit_event({event_type, account_id: ACCOUNT_A}));
		}
		assert.strictEqual(closes.length, 0);
	});
});

describe('create_ws_logout_closer', () => {
	test('closes every socket for the account on successful logout', () => {
		const transport = new BackendWebsocketTransport();
		const closer = create_ws_logout_closer(transport, silent_log);

		const a1 = create_fake_ws();
		const a2 = create_fake_ws();
		const b = create_fake_ws();
		transport.add_connection(a1.ws, HASH_A, ACCOUNT_A);
		transport.add_connection(a2.ws, 'session_hash_a2', ACCOUNT_A);
		transport.add_connection(b.ws, HASH_B, ACCOUNT_B);

		closer(create_audit_event({event_type: 'logout', account_id: ACCOUNT_A}));

		assert.strictEqual(a1.closes.length, 1);
		assert.strictEqual(a2.closes.length, 1);
		assert.strictEqual(b.closes.length, 0);
	});

	test('ignores non-logout events (session_revoke, login, etc.)', () => {
		const transport = new BackendWebsocketTransport();
		const closer = create_ws_logout_closer(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		for (const event_type of [
			'session_revoke',
			'session_revoke_all',
			'token_revoke',
			'login',
			'role_grant_revoke',
		] as const) {
			closer(create_audit_event({event_type, account_id: ACCOUNT_A}));
		}
		assert.strictEqual(closes.length, 0);
	});

	test('ignores logout with outcome=failure (avoids unauthenticated probe attacks)', () => {
		const transport = new BackendWebsocketTransport();
		const closer = create_ws_logout_closer(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		closer(
			create_audit_event({
				event_type: 'logout',
				outcome: 'failure',
				account_id: ACCOUNT_A,
			}),
		);
		assert.strictEqual(closes.length, 0);
	});

	test('ignores logout without account_id', () => {
		const transport = new BackendWebsocketTransport();
		const closer = create_ws_logout_closer(transport, silent_log);
		const {ws, closes} = create_fake_ws();
		transport.add_connection(ws, HASH_A, ACCOUNT_A);

		closer(create_audit_event({event_type: 'logout', account_id: null}));
		assert.strictEqual(closes.length, 0);
	});
});
