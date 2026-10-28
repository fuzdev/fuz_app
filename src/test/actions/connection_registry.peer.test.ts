import { describe, test, assert } from 'vitest';
import { create_uuid } from '#lib/primitive_schemas.ts';

import { ConnectionRegistry } from '#lib/actions/connection_registry.ts';
import {
	create_jsonrpc_response,
	create_jsonrpc_error_response
} from '#lib/http/jsonrpc_helpers.ts';
import { jsonrpc_error_messages } from '#lib/http/jsonrpc_errors.ts';
import { peer_ping_action_spec } from '#lib/actions/peer_ping.ts';
import { create_fake_ws } from '#lib/testing/ws_round_trip.ts';
import { create_test_identity } from './connection_identity_helpers.ts';

// In-process coverage of the registry's server→client request path
// (`request_connection` / `resolve_peer_response`) over a fake `WSContext` —
// the fast complement to the cross-process `describe_peer_ping_ws_tests`, which
// needs a real bound socket. The registry mechanics (cap, isolation, timeout)
// are unit-tested in `peer_request.test.ts`; here we exercise the socket send +
// the delegation + close-driven drain.

describe('ConnectionRegistry server→client requests', () => {
	test('request_connection frames the request to the one socket and resolve_peer_response settles it', async () => {
		const t = new ConnectionRegistry();
		const { ws, sends } = create_fake_ws();
		const conn = t.add_connection(ws, create_test_identity({ account_id: create_uuid() }));

		const outcome_promise = t.request_connection(conn, 'peer/ping', { nonce: 7 });
		assert.strictEqual(sends.length, 1, 'the request frame was sent to the socket');
		const frame = JSON.parse(sends[0]!);
		assert.strictEqual(frame.jsonrpc, '2.0');
		assert.strictEqual(frame.method, 'peer/ping');
		assert.deepStrictEqual(frame.params, { nonce: 7 });
		assert.strictEqual(frame.id, 's1', 'server-issued namespaced id');

		assert.ok(
			t.resolve_peer_response(
				conn,
				create_jsonrpc_response(frame.id, { nonce: 7, protocol_version: 1 })
			)
		);
		assert.deepStrictEqual(await outcome_promise, {
			ok: true,
			value: { nonce: 7, protocol_version: 1 }
		});
	});

	test('a client error reply surfaces as client_error (envelope forwarded)', async () => {
		const t = new ConnectionRegistry();
		const { ws, sends } = create_fake_ws();
		const conn = t.add_connection(ws, create_test_identity({ account_id: create_uuid() }));

		const outcome_promise = t.request_connection(conn, 'peer/ping', { nonce: 1 });
		const frame = JSON.parse(sends[0]!);
		const err = jsonrpc_error_messages.forbidden('no', { reason: 'client_says_no' });
		assert.ok(t.resolve_peer_response(conn, create_jsonrpc_error_response(frame.id, err)));
		const outcome = await outcome_promise;
		assert.ok(!outcome.ok);
		assert.strictEqual(outcome.error.kind, 'client_error');
		if (outcome.error.kind === 'client_error') {
			assert.deepStrictEqual(outcome.error.error, err);
		}
	});

	test('request_connection on an unknown connection is connection_gone (no send)', async () => {
		const t = new ConnectionRegistry();
		assert.deepStrictEqual(await t.request_connection(create_uuid(), 'peer/ping', {}), {
			ok: false,
			error: { kind: 'connection_gone' }
		});
	});

	test('params that cannot be serialized settle connection_gone, never throw, and send nothing', async () => {
		const t = new ConnectionRegistry();
		const { ws, sends } = create_fake_ws();
		const conn = t.add_connection(ws, create_test_identity({ account_id: create_uuid() }));

		// a BigInt has no JSON form; a handler passing one must get an outcome
		const outcome = await t.request_connection(conn, 'peer/ping', { count: 1n });
		assert.deepStrictEqual(outcome, { ok: false, error: { kind: 'connection_gone' } });
		assert.deepStrictEqual(sends, []);
		// the connection is untouched and its next request goes out
		assert.isTrue(t.is_registered(conn));
		const next = t.request_connection(conn, 'peer/ping', {});
		assert.strictEqual(sends.length, 1);
		const frame = JSON.parse(sends[0]!);
		assert.isTrue(t.resolve_peer_response(conn, create_jsonrpc_response(frame.id, {})));
		assert.deepStrictEqual(await next, { ok: true, value: {} });
		t.remove_connection(conn);
	});

	test('removing the connection drains its pending requests as connection_gone', async () => {
		const t = new ConnectionRegistry();
		const { ws } = create_fake_ws();
		const conn = t.add_connection(ws, create_test_identity({ account_id: create_uuid() }));

		const outcome_promise = t.request_connection(conn, 'peer/ping', {});
		t.remove_connection(conn);
		assert.deepStrictEqual(await outcome_promise, {
			ok: false,
			error: { kind: 'connection_gone' }
		});
		// The pending entry was drained, so a stale reply now matches nothing.
		assert.isFalse(t.resolve_peer_response(conn, create_jsonrpc_response('s1', {})));
	});

	test('an unsolicited reply (unknown id) resolves nothing', () => {
		const t = new ConnectionRegistry();
		const { ws } = create_fake_ws();
		const conn = t.add_connection(ws, create_test_identity({ account_id: create_uuid() }));
		assert.isFalse(t.resolve_peer_response(conn, create_jsonrpc_response('s999', { result: 1 })));
	});
});

describe('peer_ping_action_spec', () => {
	test('carries the IP rate-limit class', () => {
		// The only throttle a public method can take — there is no account to
		// key on — and the one that bounds an anonymous HTTP caller looping
		// the no-transport refusal. Twin of the Rust spec's
		// `RateLimitClass::Ip`; the two must move together or the backends
		// throttle the same method differently.
		assert.strictEqual(peer_ping_action_spec.rate_limit, 'ip');
		assert.deepStrictEqual(peer_ping_action_spec.auth, { account: 'none', actor: 'none' });
	});
});
