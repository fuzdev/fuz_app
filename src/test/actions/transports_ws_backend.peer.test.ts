import { describe, test, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import {
	create_jsonrpc_response,
	create_jsonrpc_error_response
} from '$lib/http/jsonrpc_helpers.ts';
import { jsonrpc_error_messages } from '$lib/http/jsonrpc_errors.ts';
import { create_fake_ws } from '$lib/testing/ws_round_trip.ts';

// In-process coverage of the transport's server→client request path
// (`request_connection` / `resolve_peer_response`) over a fake `WSContext` —
// the fast complement to the cross-process `describe_peer_ping_ws_tests`, which
// needs a real bound socket. The registry mechanics (cap, isolation, timeout)
// are unit-tested in `peer_request.test.ts`; here we exercise the socket send +
// the delegation + close-driven drain.

describe('BackendWebsocketTransport server→client requests', () => {
	test('request_connection frames the request to the one socket and resolve_peer_response settles it', async () => {
		const t = new BackendWebsocketTransport();
		const { ws, sends } = create_fake_ws();
		const conn = t.add_connection(ws, null, create_uuid());

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
		const t = new BackendWebsocketTransport();
		const { ws, sends } = create_fake_ws();
		const conn = t.add_connection(ws, null, create_uuid());

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
		const t = new BackendWebsocketTransport();
		assert.deepStrictEqual(await t.request_connection(create_uuid(), 'peer/ping', {}), {
			ok: false,
			error: { kind: 'connection_gone' }
		});
	});

	test('removing the connection drains its pending requests as connection_gone', async () => {
		const t = new BackendWebsocketTransport();
		const { ws } = create_fake_ws();
		const conn = t.add_connection(ws, null, create_uuid());

		const outcome_promise = t.request_connection(conn, 'peer/ping', {});
		t.remove_connection(ws);
		assert.deepStrictEqual(await outcome_promise, {
			ok: false,
			error: { kind: 'connection_gone' }
		});
		// The pending entry was drained, so a stale reply now matches nothing.
		assert.isFalse(t.resolve_peer_response(conn, create_jsonrpc_response('s1', {})));
	});

	test('an unsolicited reply (unknown id) resolves nothing', () => {
		const t = new BackendWebsocketTransport();
		const { ws } = create_fake_ws();
		const conn = t.add_connection(ws, null, create_uuid());
		assert.isFalse(t.resolve_peer_response(conn, create_jsonrpc_response('s999', { result: 1 })));
	});
});
