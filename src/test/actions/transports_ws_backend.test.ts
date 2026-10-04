/**
 * Tests for BackendWebsocketTransport — connection tracking, revocation, the
 * per-account connection cap, and two-phase registration.
 *
 * Uses a fake `WSContextInit` to construct real `WSContext`
 * instances without a live WebSocket. Exercises the three revocation paths
 * (session, account, api_token) and verifies bookkeeping stays in sync.
 *
 * @module
 */

import { afterEach, describe, assert, test, vi } from 'vitest';
import { WSContext } from 'hono/ws';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	BackendWebsocketTransport,
	DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT,
	type ConnectionIdentity
} from '$lib/actions/transports_ws_backend.ts';
import {
	WS_CLOSE_CONNECTION_LIMIT,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '$lib/actions/transports.ts';
import type { JsonrpcNotification } from '$lib/http/jsonrpc.ts';
import { create_fake_ws } from '$lib/testing/ws_round_trip.ts';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

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
		const { ws } = create_fake_ws();
		t.add_connection(ws, HASH_A, ACCOUNT_A);
		// revoking by a made-up token id closes nothing
		assert.strictEqual(t.close_sockets_for_token('nonexistent'), 0);
	});

	test('is_ready reflects connection count', () => {
		const t = new BackendWebsocketTransport();
		assert.strictEqual(t.is_ready(), false);
		const { ws } = create_fake_ws();
		t.add_connection(ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.is_ready(), true);
	});

	test('get_connection_count tracks add/remove', () => {
		const t = new BackendWebsocketTransport();
		assert.strictEqual(t.get_connection_count(), 0);
		const a = create_fake_ws();
		const b = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.get_connection_count(), 1);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);
		assert.strictEqual(t.get_connection_count(), 2);
		t.remove_connection(id_a);
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
		assert.deepStrictEqual(a.closes, [
			{ code: WS_CLOSE_SESSION_REVOKED, reason: 'Session revoked' }
		]);
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
		const { ws } = create_fake_ws();
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
		const { ws } = create_fake_ws();
		t.add_connection(ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 0);
	});
});

describe('BackendWebsocketTransport.remove_connection', () => {
	test('clears all per-connection bookkeeping (cannot be revoked twice)', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A, TOKEN_A);
		t.remove_connection(id_a);

		// both maps now empty — no close code from any revocation path
		assert.strictEqual(t.close_sockets_for_session(HASH_A), 0);
		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 0);
		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 0);
		assert.strictEqual(a.closes.length, 0);
	});

	test('is idempotent — safe after revocation has already cleaned up', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.close_sockets_for_session(HASH_A);
		// already cleaned up; this must not throw or double-close
		t.remove_connection(id_a);
		t.remove_connection(id_a);
		assert.strictEqual(a.closes.length, 1);
	});

	test('removes only the connection the id names', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_A, ACCOUNT_A);

		// an id the transport never issued removes nothing
		t.remove_connection(create_uuid());
		assert.strictEqual(t.get_connection_count(), 2);

		t.remove_connection(id_a);
		assert.strictEqual(t.get_connection_count(), 1);
		assert.strictEqual(t.close_sockets_for_session(HASH_A), 1);
		assert.deepStrictEqual(a.closes, []);
		assert.strictEqual(b.closes.length, 1);
	});
});

describe('BackendWebsocketTransport per-account connection cap', () => {
	const CONNECTION_LIMIT_CLOSE = { code: WS_CLOSE_CONNECTION_LIMIT, reason: 'connection limit' };

	test('past the default cap the oldest connection closes with 4004', () => {
		assert.strictEqual(DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT, 50);
		const t = new BackendWebsocketTransport();
		const sockets = Array.from({ length: DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT }, () => {
			const fake = create_fake_ws();
			t.add_connection(fake.ws, HASH_A, ACCOUNT_A);
			return fake;
		});
		// at the cap, nothing has closed
		assert.ok(sockets.every((s) => s.closes.length === 0));
		assert.strictEqual(t.get_connection_count(), DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT);

		const newest = create_fake_ws();
		t.add_connection(newest.ws, HASH_A, ACCOUNT_A);

		assert.deepStrictEqual(sockets[0]!.closes, [CONNECTION_LIMIT_CLOSE]);
		assert.ok(sockets.slice(1).every((s) => s.closes.length === 0));
		assert.deepStrictEqual(newest.closes, []);
		assert.strictEqual(t.get_connection_count(), DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT);
	});

	test('evicts oldest-first, one per connection past the cap', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 2 });
		const a = create_fake_ws();
		const b = create_fake_ws();
		const c = create_fake_ws();
		const d = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_A, ACCOUNT_A);

		t.add_connection(c.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(a.closes, [CONNECTION_LIMIT_CLOSE]);
		assert.deepStrictEqual(b.closes, []);

		t.add_connection(d.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(a.closes, [CONNECTION_LIMIT_CLOSE]);
		assert.deepStrictEqual(b.closes, [CONNECTION_LIMIT_CLOSE]);
		assert.deepStrictEqual(c.closes, []);
		assert.deepStrictEqual(d.closes, []);
		assert.strictEqual(t.get_connection_count(), 2);
	});

	test('a cap of 1 closes the previous connection for each new one', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const a = create_fake_ws();
		const b = create_fake_ws();
		t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(a.closes, []);
		t.add_connection(b.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(a.closes, [CONNECTION_LIMIT_CLOSE]);
		assert.deepStrictEqual(b.closes, []);
	});

	test('counts per account, across every credential type', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 3 });
		const other = create_fake_ws();
		t.add_connection(other.ws, HASH_B, ACCOUNT_B);

		const session = create_fake_ws();
		const bearer = create_fake_ws();
		const daemon = create_fake_ws();
		t.add_connection(session.ws, HASH_A, ACCOUNT_A);
		t.add_connection(bearer.ws, null, ACCOUNT_A, TOKEN_A);
		t.add_connection(daemon.ws, null, ACCOUNT_A);
		// another account's connection neither counts nor is evicted
		assert.deepStrictEqual(session.closes, []);

		// a second session of the same account is past the account's cap
		const second_session = create_fake_ws();
		t.add_connection(second_session.ws, 'hash_session_a2', ACCOUNT_A);
		assert.deepStrictEqual(session.closes, [CONNECTION_LIMIT_CLOSE]);

		// the bearer and daemon connections are next in line — none is exempt
		const fifth = create_fake_ws();
		t.add_connection(fifth.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(bearer.closes, [CONNECTION_LIMIT_CLOSE]);
		const sixth = create_fake_ws();
		t.add_connection(sixth.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(daemon.closes, [CONNECTION_LIMIT_CLOSE]);

		assert.deepStrictEqual(other.closes, []);
		assert.strictEqual(t.get_connection_count(), 4);
	});

	test('a removed or revoked connection frees its slot', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 2 });
		const a = create_fake_ws();
		const b = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_A);

		t.remove_connection(id_a);
		const c = create_fake_ws();
		t.add_connection(c.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(b.closes, []);

		assert.strictEqual(t.close_sockets_for_session(HASH_B), 1);
		const d = create_fake_ws();
		t.add_connection(d.ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(c.closes, []);
		assert.deepStrictEqual(d.closes, []);
	});

	test('null disables the cap', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: null });
		const sockets = Array.from({ length: DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT + 5 }, () => {
			const fake = create_fake_ws();
			t.add_connection(fake.ws, HASH_A, ACCOUNT_A);
			return fake;
		});
		assert.ok(sockets.every((s) => s.closes.length === 0));
		assert.strictEqual(t.get_connection_count(), DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT + 5);
	});

	test('an evicted connection is fully untracked — its later remove is a no-op', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const a = create_fake_ws();
		const b = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A, TOKEN_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_A, TOKEN_B);
		assert.deepStrictEqual(a.closes, [CONNECTION_LIMIT_CLOSE]);

		// the runtime adapter fires onClose for the evicted socket afterwards
		t.remove_connection(id_a);
		assert.strictEqual(t.get_connection_count(), 1);

		// nothing reaches it any more: no broadcast, no second close
		const notification: JsonrpcNotification = { jsonrpc: '2.0', method: 'ping' };
		assert.strictEqual(t.send_to_account(ACCOUNT_A, notification), 1);
		assert.strictEqual(a.sends.length, 0);
		assert.strictEqual(b.sends.length, 1);
		assert.strictEqual(t.close_sockets_for_session(HASH_A), 0);
		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 0);
		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 1);
		assert.deepStrictEqual(a.closes, [CONNECTION_LIMIT_CLOSE]);
	});

	test('eviction drains the pending peer requests of the evicted connection', async () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const a = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		const outcome = t.request_connection(id_a, 'peer/ping', {}, { timeout_ms: 60_000 });

		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);
		assert.deepStrictEqual(await outcome, { ok: false, error: { kind: 'connection_gone' } });
	});

	test('a close that throws on the evicted socket still admits the new connection', () => {
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1, log });
		const throwing = new WSContext({
			send: () => {},
			close: () => {
				throw new Error('already closed');
			},
			readyState: 1
		});
		t.add_connection(throwing, HASH_A, ACCOUNT_A);

		const id = t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(typeof id, 'string');
		// the failure goes to the transport's log
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(errors[0]![0], 'error closing superseded client:');
		// the evicted entry is gone despite the failed close
		assert.strictEqual(t.get_connection_count(), 1);
	});

	test('an eviction logs the account, the closed count, and the cap', () => {
		const infos: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.info = (...args: Array<unknown>) => {
			infos.push(args);
		};
		const t = new BackendWebsocketTransport({ max_connections_per_account: 2, log });
		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);
		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);
		// another account's connection, and reaching the cap, log nothing
		t.add_connection(create_fake_ws().ws, HASH_B, ACCOUNT_B);
		assert.deepStrictEqual(infos, []);

		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);
		// the Rust spine's registry logs the same line
		assert.deepStrictEqual(infos, [
			['ws: connection cap closed oldest', { account_id: ACCOUNT_A, closed: 1, max: 2 }]
		]);

		// a revocation and a plain remove are not cap evictions
		t.close_sockets_for_account(ACCOUNT_A);
		assert.strictEqual(infos.length, 1);
	});

	test('rejects a cap that is not a positive integer or null', () => {
		for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(
				() => new BackendWebsocketTransport({ max_connections_per_account: max }),
				/max_connections_per_account must be a positive integer or null/,
				String(max)
			);
		}
	});
});

describe('BackendWebsocketTransport log', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A socket whose `send` and `close` both throw. */
	const create_throwing_ws = (): WSContext =>
		new WSContext({
			send: () => {
				throw new Error('send failed');
			},
			close: () => {
				throw new Error('already closed');
			},
			readyState: 1
		});

	/** Spy on every `Logger`'s `error`, recording the label it was called on. */
	const spy_logger_errors = (): Array<Array<unknown>> => {
		const calls: Array<Array<unknown>> = [];
		vi.spyOn(Logger.prototype, 'error').mockImplementation(function (
			this: Logger,
			...args: Array<unknown>
		) {
			calls.push([this.label, ...args]);
		});
		return calls;
	};

	test('unset falls back to a [ws] logger rather than staying silent', () => {
		const calls = spy_logger_errors();
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		t.add_connection(create_throwing_ws(), HASH_A, ACCOUNT_A);
		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]![0], '[ws]');
		assert.strictEqual(calls[0]![1], 'error closing superseded client:');
	});

	test('null silences it', () => {
		const calls = spy_logger_errors();
		const infos = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1, log: null });
		t.add_connection(create_throwing_ws(), HASH_A, ACCOUNT_A);
		// evicts the throwing socket — neither the eviction nor the failed close logs
		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);

		assert.deepStrictEqual(calls, []);
		assert.strictEqual(infos.mock.calls.length, 0);
	});

	test('a failed broadcast send goes to the log and does not stop the fan-out', async () => {
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const t = new BackendWebsocketTransport({ log });
		t.add_connection(create_throwing_ws(), HASH_A, ACCOUNT_A);
		const ok = create_fake_ws();
		t.add_connection(ok.ws, HASH_B, ACCOUNT_B);
		const notification: JsonrpcNotification = { jsonrpc: '2.0', method: 'ping' };

		assert.strictEqual(await t.send(notification), null);
		assert.strictEqual(ok.sends.length, 1);
		assert.deepStrictEqual(
			errors.map((args) => args[0]),
			['error broadcasting to client:']
		);

		// the filtered fan-out counts only the send that went through
		assert.strictEqual(
			t.broadcast_filtered(notification, () => true),
			1
		);
		assert.strictEqual(ok.sends.length, 2);
		assert.deepStrictEqual(
			errors.map((args) => args[0]),
			['error broadcasting to client:', 'error broadcasting filtered to client:']
		);
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
		// only call it once per socket. If misused, each id is its own
		// connection and needs its own remove_connection.
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
		params: { id: 'abc' }
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
			(identity) => identity.account_id === ACCOUNT_A
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
			0
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
			seen.push({ ...identity });
			return false;
		});

		assert.strictEqual(count, 0);
		assert.strictEqual(seen.length, 3);
		assert.ok(
			seen.some((i) => i.token_hash === HASH_A && i.api_token_id === null),
			'session connection exposed'
		);
		assert.ok(
			seen.some((i) => i.token_hash === null && i.api_token_id === TOKEN_A),
			'bearer connection exposed'
		);
		assert.ok(
			seen.some((i) => i.token_hash === null && i.api_token_id === null),
			'daemon connection exposed'
		);
	});

	test('excludes sockets after remove_connection', () => {
		const t = new BackendWebsocketTransport();
		const a = create_fake_ws();
		const b = create_fake_ws();
		const id_a = t.add_connection(a.ws, HASH_A, ACCOUNT_A);
		t.add_connection(b.ws, HASH_B, ACCOUNT_B);
		t.remove_connection(id_a);

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
		params: { id: 'abc' }
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
		const { ws } = create_fake_ws();
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
			params: { id: 'first' }
		};
		const second: JsonrpcNotification = {
			jsonrpc: '2.0',
			method: 'thing_changed',
			params: { id: 'second' }
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

describe('BackendWebsocketTransport two-phase registration', () => {
	const REVOKED_CLOSE = { code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON };
	const CONNECTION_LIMIT_CLOSE = { code: WS_CLOSE_CONNECTION_LIMIT, reason: 'connection limit' };

	const notification: JsonrpcNotification = {
		jsonrpc: '2.0',
		method: 'thing_changed',
		params: { id: 'x' }
	};

	test('a pending connection is not a connection until admitted', () => {
		const t = new BackendWebsocketTransport();
		const { ws } = create_fake_ws();
		const id = t.register_pending(ws, HASH_A, ACCOUNT_A);

		assert.strictEqual(t.get_connection_count(), 0);
		assert.strictEqual(t.get_pending_connection_count(), 1);
		assert.strictEqual(t.is_ready(), false);
		assert.strictEqual(t.is_registered(id), false);

		assert.strictEqual(t.admit(id), true);

		assert.strictEqual(t.get_connection_count(), 1);
		assert.strictEqual(t.get_pending_connection_count(), 0);
		assert.strictEqual(t.is_ready(), true);
		assert.strictEqual(t.is_registered(id), true);
	});

	test('a pending connection receives nothing until admitted', async () => {
		const t = new BackendWebsocketTransport();
		const fake = create_fake_ws();
		const id = t.register_pending(fake.ws, HASH_A, ACCOUNT_A);

		// every delivery path skips it
		assert.strictEqual(await t.send(notification), null);
		assert.strictEqual(
			t.broadcast_filtered(notification, () => true),
			0
		);
		assert.strictEqual(t.send_to_account(ACCOUNT_A, notification), 0);
		assert.deepStrictEqual(await t.request_connection(id, 'peer/ping', {}), {
			ok: false,
			error: { kind: 'connection_gone' }
		});
		assert.deepStrictEqual(fake.sends, []);

		assert.strictEqual(t.admit(id), true);

		assert.strictEqual(await t.send(notification), null);
		assert.strictEqual(
			t.broadcast_filtered(notification, () => true),
			1
		);
		assert.strictEqual(t.send_to_account(ACCOUNT_A, notification), 1);
		assert.strictEqual(fake.sends.length, 3);
	});

	test('a broadcast predicate never sees a pending connection', () => {
		const t = new BackendWebsocketTransport();
		t.register_pending(create_fake_ws().ws, HASH_A, ACCOUNT_A);
		t.add_connection(create_fake_ws().ws, HASH_B, ACCOUNT_B);

		const seen: Array<ConnectionIdentity> = [];
		t.broadcast_filtered(notification, (identity) => {
			seen.push(identity);
			return true;
		});

		assert.deepStrictEqual(
			seen.map((identity) => identity.account_id),
			[ACCOUNT_B]
		);
	});

	test('a session revoked while pending is refused and evicts nothing', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const live = create_fake_ws();
		t.add_connection(live.ws, HASH_A, ACCOUNT_A);
		const pending = create_fake_ws();
		const id = t.register_pending(pending.ws, HASH_B, ACCOUNT_A);

		assert.strictEqual(t.close_sockets_for_session(HASH_B), 1, 'the close finds the pending entry');
		assert.deepStrictEqual(pending.closes, [REVOKED_CLOSE]);
		assert.strictEqual(t.get_pending_connection_count(), 0);

		assert.strictEqual(t.admit(id), false, 'a registration closed while pending is refused');
		assert.deepStrictEqual(live.closes, [], 'a refused admission evicts nothing');
		assert.strictEqual(t.get_connection_count(), 1);
		assert.strictEqual(t.is_registered(id), false);
	});

	test('an account close reaches a pending connection', () => {
		const t = new BackendWebsocketTransport();
		const pending = create_fake_ws();
		const id = t.register_pending(pending.ws, null, ACCOUNT_A);
		const other = create_fake_ws();
		const other_id = t.register_pending(other.ws, null, ACCOUNT_B);

		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 1);

		assert.deepStrictEqual(pending.closes, [REVOKED_CLOSE]);
		assert.strictEqual(t.admit(id), false);
		assert.deepStrictEqual(other.closes, []);
		assert.strictEqual(t.admit(other_id), true);
	});

	test('a token close reaches a pending connection', () => {
		const t = new BackendWebsocketTransport();
		const pending = create_fake_ws();
		const id = t.register_pending(pending.ws, null, ACCOUNT_A, TOKEN_A);
		const other = create_fake_ws();
		const other_id = t.register_pending(other.ws, null, ACCOUNT_A, TOKEN_B);

		assert.strictEqual(t.close_sockets_for_token(TOKEN_A), 1);

		assert.deepStrictEqual(pending.closes, [REVOKED_CLOSE]);
		assert.strictEqual(t.admit(id), false);
		assert.deepStrictEqual(other.closes, []);
		assert.strictEqual(t.admit(other_id), true);
	});

	test('the cap evicts at admission, not at registration', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const live = create_fake_ws();
		t.add_connection(live.ws, HASH_A, ACCOUNT_A);
		const pending = create_fake_ws();

		const id = t.register_pending(pending.ws, HASH_B, ACCOUNT_A);
		assert.deepStrictEqual(live.closes, [], 'registering pending closes nothing');

		assert.strictEqual(t.admit(id), true);
		assert.deepStrictEqual(live.closes, [CONNECTION_LIMIT_CLOSE]);
		assert.deepStrictEqual(pending.closes, []);
		assert.strictEqual(t.get_connection_count(), 1);
	});

	test('pending connections do not count toward the cap', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 2 });
		const live = create_fake_ws();
		t.add_connection(live.ws, HASH_A, ACCOUNT_A);
		// any number of pending registrations leave the account's one admitted
		// connection alone
		for (let i = 0; i < 5; i++) t.register_pending(create_fake_ws().ws, HASH_B, ACCOUNT_A);

		const admitted = create_fake_ws();
		t.add_connection(admitted.ws, HASH_A, ACCOUNT_A);

		assert.deepStrictEqual(live.closes, [], 'two admitted connections fit under a cap of two');
		assert.strictEqual(t.get_connection_count(), 2);
		assert.strictEqual(t.get_pending_connection_count(), 5);
	});

	test('the cap never evicts a pending connection', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		// registered first, so it is the account's oldest entry
		const pending = create_fake_ws();
		const pending_id = t.register_pending(pending.ws, HASH_A, ACCOUNT_A);
		const first = create_fake_ws();
		t.add_connection(first.ws, HASH_A, ACCOUNT_A);
		const second = create_fake_ws();
		t.add_connection(second.ws, HASH_A, ACCOUNT_A);

		assert.deepStrictEqual(pending.closes, []);
		assert.deepStrictEqual(first.closes, [CONNECTION_LIMIT_CLOSE]);
		assert.strictEqual(t.get_pending_connection_count(), 1);

		// and admitting it later supersedes the admitted one in turn
		assert.strictEqual(t.admit(pending_id), true);
		assert.deepStrictEqual(second.closes, [CONNECTION_LIMIT_CLOSE]);
	});

	test('removing a pending connection removes its entry, and its admission is refused', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const live = create_fake_ws();
		t.add_connection(live.ws, HASH_A, ACCOUNT_A);
		const pending = create_fake_ws();
		const id = t.register_pending(pending.ws, HASH_B, ACCOUNT_A);

		t.remove_connection(id);

		assert.strictEqual(t.get_pending_connection_count(), 0);
		assert.strictEqual(t.admit(id), false);
		assert.deepStrictEqual(live.closes, []);
		// removal alone sends no close frame — the caller that refused it does
		assert.deepStrictEqual(pending.closes, []);
	});

	test('admit refuses an id the transport never registered', () => {
		const t = new BackendWebsocketTransport();
		const other = new BackendWebsocketTransport();
		const id = other.register_pending(create_fake_ws().ws, HASH_A, ACCOUNT_A);

		assert.strictEqual(t.admit(id), false);
		assert.strictEqual(t.admit(create_uuid()), false);
		assert.strictEqual(t.get_connection_count(), 0);
	});

	test('admitting an admitted connection again evicts nothing', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 2 });
		const first = create_fake_ws();
		t.add_connection(first.ws, HASH_A, ACCOUNT_A);
		const second = create_fake_ws();
		const id = t.register_pending(second.ws, HASH_A, ACCOUNT_A);

		assert.strictEqual(t.admit(id), true);
		assert.strictEqual(t.admit(id), true);

		assert.deepStrictEqual(first.closes, []);
		assert.strictEqual(t.get_connection_count(), 2);
	});
});

describe('BackendWebsocketTransport server-side close', () => {
	test('a revocation aborts the registered controller of a pending and an admitted connection', () => {
		const t = new BackendWebsocketTransport();
		const pending_abort = new AbortController();
		const admitted_abort = new AbortController();
		const other_abort = new AbortController();
		t.register_pending(create_fake_ws().ws, HASH_A, ACCOUNT_A, null, pending_abort);
		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A, null, admitted_abort);
		t.add_connection(create_fake_ws().ws, HASH_B, ACCOUNT_B, null, other_abort);

		assert.strictEqual(t.close_sockets_for_account(ACCOUNT_A), 2);

		assert.strictEqual(pending_abort.signal.aborted, true);
		assert.strictEqual(admitted_abort.signal.aborted, true);
		assert.strictEqual(other_abort.signal.aborted, false);
	});

	test('a cap eviction aborts the evicted connection controller, and only it', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const oldest_abort = new AbortController();
		const newest_abort = new AbortController();
		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A, null, oldest_abort);

		t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A, null, newest_abort);

		assert.strictEqual(oldest_abort.signal.aborted, true);
		assert.strictEqual(newest_abort.signal.aborted, false);
	});

	test('remove_connection leaves the controller alone', () => {
		const t = new BackendWebsocketTransport();
		const abort = new AbortController();
		const id = t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A, null, abort);

		t.remove_connection(id);

		assert.strictEqual(abort.signal.aborted, false);
	});

	test('is_registered is false once the connection is revoked, evicted, or removed', () => {
		const t = new BackendWebsocketTransport({ max_connections_per_account: 1 });
		const revoked = t.add_connection(create_fake_ws().ws, HASH_A, ACCOUNT_A);
		assert.strictEqual(t.is_registered(revoked), true);
		t.close_sockets_for_session(HASH_A);
		assert.strictEqual(t.is_registered(revoked), false);

		const evicted = t.add_connection(create_fake_ws().ws, HASH_B, ACCOUNT_B);
		const newest = t.add_connection(create_fake_ws().ws, HASH_B, ACCOUNT_B);
		assert.strictEqual(t.is_registered(evicted), false);
		assert.strictEqual(t.is_registered(newest), true);

		t.remove_connection(newest);
		assert.strictEqual(t.is_registered(newest), false);
		assert.strictEqual(t.is_registered(create_uuid()), false);
	});
});
