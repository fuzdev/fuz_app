/**
 * Tests for BackendWebsocketTransport — connection tracking and revocation.
 *
 * Uses a fake `WSContextInit` to construct real `WSContext`
 * instances without a live WebSocket. Exercises the three revocation paths
 * (session, account, api_token) and verifies bookkeeping stays in sync.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {WSContext, type WSContextInit} from 'hono/ws';

import {BackendWebsocketTransport} from '$lib/actions/transports_ws_backend.js';
import {WS_CLOSE_SESSION_REVOKED} from '$lib/actions/transports.js';
import {create_uuid, type Uuid} from '$lib/uuid.js';

interface FakeWs {
	ws: WSContext;
	sends: Array<string>;
	closes: Array<{code?: number; reason?: string}>;
}

const create_fake_ws = (): FakeWs => {
	const sends: Array<string> = [];
	const closes: Array<{code?: number; reason?: string}> = [];
	const init: WSContextInit = {
		send: (data) => {
			sends.push(typeof data === 'string' ? data : '<binary>');
		},
		close: (code, reason) => {
			closes.push({code, reason});
		},
		readyState: 1,
	};
	return {ws: new WSContext(init), sends, closes};
};

const ACCOUNT_A = create_uuid();
const ACCOUNT_B = create_uuid();
const HASH_A = 'hash_session_a';
const HASH_B = 'hash_session_b';
const TOKEN_A = 'token_id_a';
const TOKEN_B = 'token_id_b';

describe('BackendWebsocketTransport.add_connection', () => {
	test('returns a unique id per connection', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		const id_b = t.add_connection(b.ws, HASH_B, ACCOUNT_B);
		assert.notStrictEqual(id_a, id_b);
	});

	test('api_token_id defaults to null (backward-compatible 3-arg call)', () => {
		const t = new BackendWebsocketTransport();
		const {ws} = create_fake_ws();
		t.add_connection(ws, HASH_A, ACCOUNT_A);
		// revoking by a made-up token id closes nothing
		assert.strictEqual(t.close_sockets_for_token('nonexistent'), 0);
	});

	test('is_ready reflects connection count', () => {
		const t = new BackendWebsocketTransport();
		assert.strictEqual(t.is_ready(), false);
		const {ws} = create_fake_ws();
		t.add_connection(ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.is_ready(), true);
	});
});

describe('BackendWebsocketTransport.close_sockets_for_session', () => {
	test('closes only the matching session, returns count', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_A);

		const count = t.close_sockets_for_session(HASH_A);
		assert.strictEqual(count, 1);
		assert.deepStrictEqual(a.closes, [{code: WS_CLOSE_SESSION_REVOKED, reason: 'Session revoked'}]);
		assert.deepStrictEqual(b.closes, []);
	});

	test('closes all sockets sharing the session hash', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_A, ACCOUNT_A);

		assert.strictEqual(t.close_sockets_for_session(HASH_A), 2);
	});

	test('returns 0 when no sockets match', () => {
		const t = new BackendWebsocketTransport();
		const {ws} = create_fake_ws();
		t.add_connection(ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.close_sockets_for_session('nope'), 0);
	});
});

describe('BackendWebsocketTransport.close_sockets_for_account', () => {
	test('closes all sockets for the account across session and bearer', () => {
		const t = new BackendWebsocketTransport();
		const session_ws = create_fake_ws();
		const bearer_ws = create_fake_ws();
		const daemon_ws = create_fake_ws();
		const other_ws = create_fake_ws();
		t.add_connection(session_ws.ws, HASH_A, ACCOUNT_A);
		t.add_connection(bearer_ws.ws, null, ACCOUNT_A, TOKEN_A);
		t.add_connection(daemon_ws.ws, null, ACCOUNT_A);
		t.add_connection(other_ws.ws, HASH_B, ACCOUNT_B);

		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 3);
		assert.strictEqual(session_ws.closes.length, 1);
		assert.strictEqual(bearer_ws.closes.length, 1);
		assert.strictEqual(daemon_ws.closes.length, 1);
		assert.strictEqual(other_ws.closes.length, 0);
	});
});

describe('BackendWebsocketTransport.close_sockets_for_token', () => {
	test('closes only the socket bound to that api_token.id', () => {
		const t = new BackendWebsocketTransport();
		const bearer_a = create_fake_ws();
		const bearer_b = create_fake_ws();
		const session_ws = create_fake_ws();
		t.add_connection(bearer_a.ws, null, ACCOUNT_A, TOKEN_A);
		t.add_connection(bearer_b.ws, null, ACCOUNT_A, TOKEN_B);
		t.add_connection(session_ws.ws, HASH_A, ACCOUNT_A);

		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 1);
		assert.strictEqual(bearer_a.closes.length, 1);
		assert.strictEqual(bearer_b.closes.length, 0);
		assert.strictEqual(session_ws.closes.length, 0);
	});

	test('does not affect session-authenticated sockets on the same account', () => {
		const t = new BackendWebsocketTransport();
		const session_ws = create_fake_ws();
		const bearer_ws = create_fake_ws();
		t.add_connection(session_ws.ws, HASH_A, ACCOUNT_A);
		t.add_connection(bearer_ws.ws, null, ACCOUNT_A, TOKEN_A);

		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 1);
		assert.strictEqual(session_ws.closes.length, 0);
	});

	test('returns 0 when no bearer connections match', () => {
		const t = new BackendWebsocketTransport();
		const {ws} = create_fake_ws();
		t.add_connection(ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 0);
	});
});

describe('BackendWebsocketTransport.remove_connection', () => {
	test('clears all per-connection bookkeeping (cannot be revoked twice)', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A, TOKEN_A);
		t.remove_connection(a.ws);

		// all three maps now empty — no close code from any revocation path
		assert.strictEqual(t.close_sockets_for_session(HASH_A), 0);
		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 0);
		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 0);
		assert.strictEqual(a.closes.length, 0);
	});

	test('is idempotent — safe after revocation has already cleaned up', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.close_sockets_for_session(HASH_A);
		// already cleaned up; this must not throw or double-close
		t.remove_connection(a.ws);
		assert.strictEqual(a.closes.length, 1);
	});
});

describe('BackendWebsocketTransport revocation bookkeeping', () => {
	test('revoked connection stops matching any future close_sockets_for_* call', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A, TOKEN_A);

		// first revocation path closes the socket once
		assert.strictEqual(t.close_sockets_for_session(HASH_A), 1);
		assert.strictEqual(a.closes.length, 1);

		// subsequent revocations via any other key find nothing to close
		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 0);
		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 0);
		assert.strictEqual(a.closes.length, 1);
	});

	test('daemon-token connection (null token_hash + null api_token_id) is only reachable via account', () => {
		const t = new BackendWebsocketTransport();
		const daemon = create_fake_ws();
		t.add_connection(daemon.ws, null, ACCOUNT_A);

		assert.strictEqual(t.close_sockets_for_session(HASH_A), 0);
		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 0);
		assert.strictEqual(daemon.closes.length, 0);

		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 1);
		assert.strictEqual(daemon.closes.length, 1);
	});

	test('adding the same ws twice registers two connection ids (contract: caller must not re-add)', () => {
		// Documents current behavior: add_connection trusts the caller to
		// only call it once per socket. If misused, WeakMap lookup via
		// remove_connection picks up the most recent id only.
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const id1 = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		const id2 = t.add_connection(a.ws, HASH_B, ACCOUNT_B);
		assert.notStrictEqual(id1 as unknown as Uuid, id2 as unknown as Uuid);
		// revocation still closes the socket, possibly more than once
		t.close_sockets_for_account(ACCOUNT_A);
		t.close_sockets_for_account(ACCOUNT_B);
		assert.ok(a.closes.length >= 1);
	});
});
