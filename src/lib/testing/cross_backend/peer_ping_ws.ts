import '../assert_dev_env.ts';

/**
 * Cross-process **server-initiated `peer/ping`** suite — the machinery
 * proof for ActionPeer (a backend initiating a JSON-RPC request to a
 * connected client and awaiting its typed reply). The sibling of the
 * one-way notification suite (`role_grant_offer_notification_ws.ts`),
 * extended from server→client *notifications* to server→client
 * *request/response*.
 *
 * `peer/ping` is `initiator: both`: the client→server direction already
 * exists as `heartbeat`; the new server→client direction is what this
 * exercises. The observable trigger is the client invoking the `peer/ping`
 * **action** over its own socket — the handler turns around and *initiates*
 * a `peer/ping` request back to that socket, awaits the client's echo,
 * validates it against `PingResponse`, and returns the validated shape. So
 * one client RPC drives the whole round-trip, and every outcome
 * (success / `Timeout` / wrong-shape / client-error) surfaces as that RPC's
 * wire response — directly assertable.
 *
 * The client side attaches an `on_request` responder **at construction**
 * (via `create_ws_transport`'s seam) so the server-initiated request is
 * answered as soon as it arrives. Security negatives use the raw
 * `WsClient.send` to inject unsolicited / cross-connection frames.
 *
 * **Per-spec auth.** `peer/ping` is `auth: public` (a liveness echo is
 * non-sensitive — see the design doc); the WS upgrade itself still
 * authenticates, so the suite drives it over the keeper's session.
 *
 * Gated on `capabilities.peer_request` — `true` only for the Rust spine
 * (server-initiated requests landed Rust-first canonical); the TS family
 * skips until its server transport's request path lands (deferred twin-impl
 * convergence). Cross-process only: `create_ws_transport` needs a real bound
 * socket, so wire it from a `*.cross.test.ts`.
 *
 * @module
 */

import {assert, describe} from 'vitest';

import {rpc_call} from '../rpc_helpers.ts';
import {create_ws_transport} from '../transports/ws_transport.ts';
import {
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcSuccessResponseFrame,
	type WsClient,
	type WsRequestResponder,
} from '../transports/ws_client.ts';
import {create_jsonrpc_request, is_jsonrpc_request} from '../../http/jsonrpc_helpers.ts';
import {type BackendCapabilities, test_if} from './capabilities.ts';
import type {SetupTest} from './setup.ts';

/** JSON-RPC endpoint path — matches the spine's `/api/rpc` (and the forge's). */
const RPC_PATH = '/api/rpc';

/** Wire method (both directions). Mirrors the Rust `PEER_PING_METHOD`. */
const PEER_PING_METHOD = 'peer/ping';

// Stable `data.reason` discriminators — the cross-impl wire contract, kept
// as an independent TS-side copy of the Rust `REASON_PEER_*` constants
// (parity by test, not codegen).
const REASON_PEER_TIMEOUT = 'peer_timeout';
const REASON_PEER_INVALID_REPLY = 'peer_ping_invalid_reply';
const REASON_PEER_NO_TRANSPORT = 'peer_no_transport';

/** A reply payload that satisfies the Rust `PingResponse` shape. */
const valid_reply = (nonce: number) => ({nonce, protocol_version: 1});

/** Configuration for {@link describe_peer_ping_ws_tests}. */
export interface PeerPingWsTestOptions {
	/** Per-test fixture producer (`default_cross_process_setup(handle, ...)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `capabilities.peer_request`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1177`). */
	readonly base_url: string;
	/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
	readonly ws_path: string;
}

/**
 * Register the server-initiated `peer/ping` suite — a positive round-trip
 * plus the security negatives the design doc's §Security surface mandates
 * (unsolicited-response rejection, per-connection id isolation, never-reply
 * `Timeout`, wrong-shape reply rejection, plus client-error forwarding and
 * the HTTP no-transport path). Gated on `capabilities.peer_request`.
 */
export const describe_peer_ping_ws_tests = (options: PeerPingWsTestOptions): void => {
	const {setup_test, capabilities, base_url, ws_path} = options;

	// -- shared helpers -------------------------------------------------------

	/** Open a WS transport for a session cookie, with an optional responder. */
	const open_ws = (
		cookie: string | undefined,
		on_request?: WsRequestResponder,
	): Promise<WsClient> => {
		assert.ok(cookie, 'expected a session cookie for the WS upgrade');
		return create_ws_transport({
			base_url,
			ws_path,
			cookies: [cookie],
			origin: base_url,
			on_request,
		});
	};

	/** A responder that echoes a valid `PingResponse` for every `peer/ping`. */
	const echo_responder: WsRequestResponder = (req) => {
		const nonce = (req.params as {nonce?: number} | undefined)?.nonce ?? 0;
		return {result: valid_reply(nonce)};
	};

	/**
	 * Invoke `peer/ping` over the socket and return the **raw** response
	 * frame (success or error) so the negatives can assert on
	 * `error.data.reason`. The client wait is generous (longer than any
	 * server-side `timeout_ms`) so the server's own outcome is what we read.
	 */
	const ping_raw = (
		ws: WsClient,
		id: number,
		params: unknown,
	): Promise<JsonrpcSuccessResponseFrame | JsonrpcErrorResponseFrame> =>
		ws
			.send(create_jsonrpc_request(PEER_PING_METHOD, params as never, id))
			.then(() =>
				ws.wait_for<JsonrpcSuccessResponseFrame | JsonrpcErrorResponseFrame>(
					is_response_for(id),
					8000,
				),
			);

	const error_reason = (frame: JsonrpcErrorResponseFrame): unknown =>
		(frame.error.data as {reason?: unknown} | undefined)?.reason;

	// -- tests ----------------------------------------------------------------

	describe('peer/ping server-initiated request (cross-process)', () => {
		test_if(
			capabilities.peer_request,
			'a client peer/ping round-trips: server pings back, validates the echo, returns it',
			async () => {
				const fixture = await setup_test();
				const ws = await open_ws(fixture.create_session_headers().cookie, echo_responder);
				try {
					const result = await ws.request<{nonce: number; protocol_version: number}>(
						1,
						PEER_PING_METHOD,
						{nonce: 42},
						8000,
					);
					assert.strictEqual(result.nonce, 42, 'the server echoes the issued nonce back');
					assert.strictEqual(typeof result.protocol_version, 'number');
				} finally {
					await ws.close();
				}
			},
		);

		test_if(
			capabilities.peer_request,
			'a never-replying client yields a server-side Timeout (the liveness signal)',
			async () => {
				const fixture = await setup_test();
				// Responder swallows the ping (returns nothing) — the half-open peer.
				const ws = await open_ws(fixture.create_session_headers().cookie, () => undefined);
				try {
					// Short server-side deadline so the negative runs fast.
					const frame = await ping_raw(ws, 2, {nonce: 1, timeout_ms: 300});
					assert.ok('error' in frame, 'a swallowed ping must error, not succeed');
					assert.strictEqual(error_reason(frame), REASON_PEER_TIMEOUT);
				} finally {
					await ws.close();
				}
			},
		);

		test_if(
			capabilities.peer_request,
			'a wrong-shape reply is rejected at the validation boundary, never handed to the caller',
			async () => {
				const fixture = await setup_test();
				// Reply that fails `PingResponse` validation (nonce wrong type,
				// protocol_version missing).
				const ws = await open_ws(fixture.create_session_headers().cookie, () => ({
					result: {nonce: 'not-a-number'},
				}));
				try {
					const frame = await ping_raw(ws, 3, {nonce: 1, timeout_ms: 2000});
					assert.ok('error' in frame, 'a malformed reply must error, not return garbage');
					assert.strictEqual(error_reason(frame), REASON_PEER_INVALID_REPLY);
				} finally {
					await ws.close();
				}
			},
		);

		test_if(
			capabilities.peer_request,
			'a client JSON-RPC error reply surfaces as the action error (ClientError forwarded)',
			async () => {
				const fixture = await setup_test();
				const ws = await open_ws(fixture.create_session_headers().cookie, () => ({
					error: {code: -32603, message: 'client refused', data: {reason: 'client_says_no'}},
				}));
				try {
					const frame = await ping_raw(ws, 4, {nonce: 1, timeout_ms: 2000});
					assert.ok('error' in frame, 'a client error reply must surface as an error');
					assert.strictEqual(frame.error.code, -32603);
					assert.strictEqual(error_reason(frame), 'client_says_no');
				} finally {
					await ws.close();
				}
			},
		);

		test_if(
			capabilities.peer_request,
			'an unsolicited response is dropped: it resolves nothing and the socket survives',
			async () => {
				const fixture = await setup_test();
				const ws = await open_ws(fixture.create_session_headers().cookie, echo_responder);
				try {
					// Inject a reply for an id the server never issued on this socket.
					await ws.send({jsonrpc: '2.0', id: 's999999', result: valid_reply(7)});
					// A legitimate round-trip still works → the junk frame neither
					// crashed the read loop nor corrupted the pending registry.
					const result = await ws.request<{nonce: number}>(5, PEER_PING_METHOD, {nonce: 99}, 8000);
					assert.strictEqual(result.nonce, 99);
				} finally {
					await ws.close();
				}
			},
		);

		test_if(
			capabilities.peer_request,
			'a reply on socket B never resolves a request issued on socket A (per-connection isolation)',
			async () => {
				const fixture = await setup_test();
				// A has NO responder, so the inbound server-initiated request is
				// surfaced as a message A can observe (to learn its server id);
				// A never answers it.
				const ws_a = await open_ws(fixture.create_session_headers().cookie);
				const ws_b = await open_ws(fixture.create_session_headers().cookie, echo_responder);
				try {
					// A invokes peer/ping with a short server-side deadline; don't
					// await yet — observe the server→client request first.
					const ping_promise = ping_raw(ws_a, 6, {nonce: 1, timeout_ms: 1200});

					// The server-initiated request A received (id "sN", nonce 1).
					const inbound = await ws_a.wait_for(
						(m): m is {id: number | string; params: {nonce: number}} =>
							is_jsonrpc_request(m) && m.method === PEER_PING_METHOD,
						5000,
					);

					// B replies for A's id — a cross-connection echo. Correct
					// isolation drops it (not pending on B), so A still times out.
					await ws_b.send({
						jsonrpc: '2.0',
						id: inbound.id,
						result: valid_reply(inbound.params.nonce),
					});

					const frame = await ping_promise;
					assert.ok('error' in frame, "B's cross-connection reply must not resolve A's request");
					assert.strictEqual(error_reason(frame), REASON_PEER_TIMEOUT);
				} finally {
					await ws_a.close();
					await ws_b.close();
				}
			},
		);

		test_if(
			capabilities.peer_request,
			'peer/ping over HTTP (no return socket) is rejected as no-transport',
			async () => {
				const fixture = await setup_test();
				const res = await rpc_call({
					app: fixture.transport,
					path: RPC_PATH,
					method: PEER_PING_METHOD,
					params: {nonce: 1},
					headers: fixture.create_session_headers(),
				});
				assert.isFalse(res.ok, 'HTTP peer/ping has no socket to ping');
				if (!res.ok) {
					assert.strictEqual(
						(res.error.data as {reason?: unknown} | undefined)?.reason,
						REASON_PEER_NO_TRANSPORT,
					);
				}
			},
		);
	});
};
