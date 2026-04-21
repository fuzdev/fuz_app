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

import {
	BackendWebsocketTransport,
	type ConnectionIdentity,
} from '$lib/actions/transports_ws_backend.js';
import {WS_CLOSE_SESSION_REVOKED} from '$lib/actions/transports.js';
import type {JsonrpcNotification} from '$lib/http/jsonrpc.js';
import {create_fake_ws} from '$lib/testing/ws_round_trip.js';
import {create_uuid, type Uuid} from '$lib/uuid.js';

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

	test('get_connection_count tracks add/remove', () => {
		const t = new BackendWebsocketTransport();
		assert.strictEqual(t.get_connection_count(), 0);
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.get_connection_count(), 1);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);
		assert.strictEqual(t.get_connection_count(), 2);
		t.remove_connection(a.ws);
		assert.strictEqual(t.get_connection_count(), 1);
		t.close_sockets_for_account(ACCOUNT_B);
		assert.strictEqual(t.get_connection_count(), 0);
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

describe('BackendWebsocketTransport.broadcast_filtered', () => {
	const notification: JsonrpcNotification = {
		jsonrpc: '2.0',
		method: 'thing_changed',
		params: {id: 'abc'},
	};

	test('returns 0 and sends nothing when the predicate matches no connections', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);

		const count = t.broadcast_filtered(notification, () => false);
		assert.strictEqual(count, 0);
		assert.deepStrictEqual(a.sends, []);
		assert.deepStrictEqual(b.sends, []);
	});

	test('returns matching count and sends only to matching connections', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		const c = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);
		t.add_connection(c.ws, HASH_A, ACCOUNT_A);

		const count = t.broadcast_filtered(
			notification,
			(identity) => identity.account_id === ACCOUNT_A,
		);
		assert.strictEqual(count, 2);
		assert.deepStrictEqual(a.sends, [JSON.stringify(notification)]);
		assert.deepStrictEqual(b.sends, []);
		assert.deepStrictEqual(c.sends, [JSON.stringify(notification)]);
	});

	test('returns total count and sends to every connection when the predicate matches all', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);

		const count = t.broadcast_filtered(notification, () => true);
		assert.strictEqual(count, 2);
		assert.strictEqual(a.sends.length, 1);
		assert.strictEqual(b.sends.length, 1);
	});

	test('returns 0 on a transport with no connections', () => {
		const t = new BackendWebsocketTransport();
		assert.strictEqual(
			t.broadcast_filtered(notification, () => true),
			0,
		);
	});

	test('predicate sees full ConnectionIdentity for session, bearer, and daemon connections', () => {
		const t = new BackendWebsocketTransport();
		const session_ws = create_fake_ws();
		const bearer_ws = create_fake_ws();
		const daemon_ws = create_fake_ws();
		t.add_connection(session_ws.ws, HASH_A, ACCOUNT_A);
		t.add_connection(bearer_ws.ws, null, ACCOUNT_A, TOKEN_A);
		t.add_connection(daemon_ws.ws, null, ACCOUNT_A);

		const seen: Array<ConnectionIdentity> = [];
		const count = t.broadcast_filtered(notification, (identity) => {
			seen.push({...identity});
			return false;
		});

		assert.strictEqual(count, 0);
		assert.strictEqual(seen.length, 3);
		assert.ok(
			seen.some((i) => i.token_hash === HASH_A && i.api_token_id === null),
			'session connection exposed',
		);
		assert.ok(
			seen.some((i) => i.token_hash === null && i.api_token_id === TOKEN_A),
			'bearer connection exposed',
		);
		assert.ok(
			seen.some((i) => i.token_hash === null && i.api_token_id === null),
			'daemon connection exposed',
		);
	});

	test('excludes sockets after remove_connection', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);
		t.remove_connection(a.ws);

		const count = t.broadcast_filtered(notification, () => true);
		assert.strictEqual(count, 1);
		assert.deepStrictEqual(a.sends, []);
		assert.deepStrictEqual(b.sends, [JSON.stringify(notification)]);
	});
});

describe('BackendWebsocketTransport.send_to_account', () => {
	const notification: JsonrpcNotification = {
		jsonrpc: '2.0',
		method: 'thing_changed',
		params: {id: 'abc'},
	};

	test('delivers to the single matching connection and returns 1', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);

		const count = t.send_to_account(ACCOUNT_A, notification);
		assert.strictEqual(count, 1);
		assert.deepStrictEqual(a.sends, [JSON.stringify(notification)]);
		assert.deepStrictEqual(b.sends, []);
	});

	test('delivers to every socket bound to the account (multi-tab) and returns N', () => {
		const t = new BackendWebsocketTransport();
		const session_ws = create_fake_ws();
		const bearer_ws = create_fake_ws();
		const daemon_ws = create_fake_ws();
		const other_ws = create_fake_ws();
		t.add_connection(session_ws.ws, HASH_A, ACCOUNT_A);
		t.add_connection(bearer_ws.ws, null, ACCOUNT_A, TOKEN_A);
		t.add_connection(daemon_ws.ws, null, ACCOUNT_A);
		t.add_connection(other_ws.ws, HASH_B, ACCOUNT_B);

		const count = t.send_to_account(ACCOUNT_A, notification);
		assert.strictEqual(count, 3);
		assert.deepStrictEqual(session_ws.sends, [JSON.stringify(notification)]);
		assert.deepStrictEqual(bearer_ws.sends, [JSON.stringify(notification)]);
		assert.deepStrictEqual(daemon_ws.sends, [JSON.stringify(notification)]);
		assert.deepStrictEqual(other_ws.sends, []);
	});

	test('returns 0 when the account has no connections', () => {
		const t = new BackendWebsocketTransport();
		const {ws} = create_fake_ws();
		t.add_connection(ws, HASH_B, ACCOUNT_B);

		const count = t.send_to_account(ACCOUNT_A, notification);
		assert.strictEqual(count, 0);
	});

	test('returns 0 on a transport with no connections', () => {
		const t = new BackendWebsocketTransport();
		assert.strictEqual(t.send_to_account(ACCOUNT_A, notification), 0);
	});

	test('two consecutive sends both deliver, each returns the full count', () => {
		// Regression guard against any future per-invocation state
		// (rate limit window, dedup, queue handoff) sneaking in — today
		// `send_to_account` is stateless pass-through and both calls should
		// behave identically.
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, null, ACCOUNT_A, TOKEN_A);

		const first: JsonrpcNotification = {
			jsonrpc: '2.0',
			method: 'thing_changed',
			params: {id: 'first'},
		};
		const second: JsonrpcNotification = {
			jsonrpc: '2.0',
			method: 'thing_changed',
			params: {id: 'second'},
		};

		assert.strictEqual(t.send_to_account(ACCOUNT_A, first), 2);
		assert.strictEqual(t.send_to_account(ACCOUNT_A, second), 2);
		assert.deepStrictEqual(a.sends, [JSON.stringify(first), JSON.stringify(second)]);
		assert.deepStrictEqual(b.sends, [JSON.stringify(first), JSON.stringify(second)]);
	});

	test('excludes a socket revoked via a different identity axis, returns N-1', () => {
		// Revoking via session hash exercises a different code path
		// (`#close_where` keyed on `token_hash`) than `send_to_account`'s
		// `account_id` walk — so a shared bookkeeping bug in one path can't
		// hide in the other.
		const t = new BackendWebsocketTransport();
		const session_ws = create_fake_ws();
		const bearer_ws = create_fake_ws();
		const daemon_ws = create_fake_ws();
		const other_account_ws = create_fake_ws();
		t.add_connection(session_ws.ws, HASH_A, ACCOUNT_A);
		t.add_connection(bearer_ws.ws, null, ACCOUNT_A, TOKEN_A);
		t.add_connection(daemon_ws.ws, null, ACCOUNT_A);
		t.add_connection(other_account_ws.ws, HASH_B, ACCOUNT_B);

		assert.strictEqual(t.close_sockets_for_session(HASH_A), 1);

		const count = t.send_to_account(ACCOUNT_A, notification);
		assert.strictEqual(count, 2);
		assert.deepStrictEqual(session_ws.sends, []);
		assert.deepStrictEqual(bearer_ws.sends, [JSON.stringify(notification)]);
		assert.deepStrictEqual(daemon_ws.sends, [JSON.stringify(notification)]);
		assert.deepStrictEqual(other_account_ws.sends, []);
	});
});
