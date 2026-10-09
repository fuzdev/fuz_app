import '../assert_dev_env.ts';

/**
 * Cross-process suite for the two refusals a WebSocket request can meet ahead
 * of dispatch — the same on both spines, pinned over a real upgrade:
 *
 * - a request whose id names a request still running on the socket is
 *   answered `invalid_request` with `data.reason: 'duplicate_request_id'` and
 *   not dispatched; the running request keeps the id and answers as usual, and
 *   once it has answered the id is free again
 * - past the per-socket in-flight ceiling (128 on both spines) a new request is
 *   answered `queue_overflow` with its id and not dispatched; the socket stays
 *   open, the running requests still answer, and the duplicate check comes
 *   first
 *
 * A request has to stay in flight for either to be observable, so the suite
 * holds requests with `peer/ping`: the server's handler pings the client back
 * and waits for the echo, and the client's responder withholds it until the
 * test releases it. Gated on `capabilities.peer_request` for that reason.
 *
 * The wire literals are deliberate independent copies of the producers'
 * constants (`ERROR_DUPLICATE_REQUEST_ID`,
 * `MAX_INBOUND_DISPATCHES_PER_CONNECTION`, `WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE`
 * on TS; their Rust twins in `fuz_realtime`) — parity by test, so a value
 * renamed on one side fails here instead of moving both at once.
 *
 * Cross-process only: `create_ws_transport` needs a real bound socket, so wire
 * it from a `*.cross.test.ts` file.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import { create_jsonrpc_request } from '../../http/jsonrpc_helpers.ts';
import { create_ws_transport } from '../transports/ws_transport.ts';
import {
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcSuccessResponseFrame,
	type WsClient,
	type WsRequestResponder
} from '../transports/ws_client.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest } from './setup.ts';

/** `data.reason` of the duplicate-id refusal. */
const REASON_DUPLICATE_REQUEST_ID = 'duplicate_request_id';
/** The per-socket in-flight ceiling on both spines. */
const MAX_INBOUND_DISPATCHES = 128;
/** The `queue_overflow` message past the ceiling. */
const OVERFLOW_MESSAGE = 'too many concurrent requests on this connection';
const INVALID_REQUEST = -32600;
const QUEUE_OVERFLOW = -32009;

const PEER_PING_METHOD = 'peer/ping';
const HEARTBEAT_METHOD = 'heartbeat';

/** How long the test waits on a frame — above the server's peer-request deadline. */
const FRAME_TIMEOUT_MS = 12_000;

/** Configuration for `describe_ws_inbound_dispatch_cross_tests`. */
export interface WsInboundDispatchCrossTestOptions {
	/** Per-test fixture producer (`default_cross_process_setup(handle)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `capabilities.peer_request`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1177`). */
	readonly base_url: string;
	/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
	readonly ws_path: string;
}

/**
 * A client responder that withholds every server-initiated `peer/ping` echo
 * until `release` — so each client `peer/ping` stays in flight on the server —
 * and answers at once after it.
 */
const create_holding_responder = (): {
	responder: WsRequestResponder;
	release: () => void;
	/** Resolves once `count` pings have reached the client. */
	pinged: (count: number) => Promise<void>;
} => {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ping_count = 0;
	const ping_waiters: Array<{ count: number; resolve: () => void }> = [];
	const responder: WsRequestResponder = async (request) => {
		ping_count++;
		for (let i = ping_waiters.length - 1; i >= 0; i--) {
			const waiter = ping_waiters[i]!;
			if (ping_count >= waiter.count) {
				waiter.resolve();
				ping_waiters.splice(i, 1);
			}
		}
		await released;
		const nonce = (request.params as { nonce?: number } | undefined)?.nonce ?? 0;
		return { result: { nonce, protocol_version: 1 } };
	};
	const pinged = (count: number): Promise<void> =>
		ping_count >= count
			? Promise.resolve()
			: new Promise<void>((resolve) => ping_waiters.push({ count, resolve }));
	return { responder, release, pinged };
};

type ResponseFrame = JsonrpcSuccessResponseFrame | JsonrpcErrorResponseFrame;

/** A response for `id` that carries a `peer/ping` result (`nonce` present). */
const is_ping_result_for =
	(id: number | string) =>
	(msg: unknown): boolean =>
		is_response_for(id)(msg) &&
		typeof (msg as { result?: unknown }).result === 'object' &&
		(msg as { result: object | null }).result !== null &&
		'nonce' in (msg as { result: object }).result;

/** A response for `id` that carries a `heartbeat` result (an object without `nonce`). */
const is_heartbeat_result_for =
	(id: number | string) =>
	(msg: unknown): boolean =>
		is_response_for(id)(msg) &&
		typeof (msg as { result?: unknown }).result === 'object' &&
		(msg as { result: object | null }).result !== null &&
		!('nonce' in (msg as { result: object }).result);

/** An error response for `id`. */
const is_error_for =
	(id: number | string) =>
	(msg: unknown): boolean =>
		is_response_for(id)(msg) && 'error' in (msg as object);

/**
 * Register the duplicate-id and in-flight-ceiling cases. Gated on
 * `capabilities.peer_request` (the cases hold requests with `peer/ping`).
 */
export const describe_ws_inbound_dispatch_cross_tests = (
	options: WsInboundDispatchCrossTestOptions
): void => {
	const { setup_test, capabilities, base_url, ws_path } = options;

	const open_ws = (
		cookie: string | undefined,
		on_request: WsRequestResponder
	): Promise<WsClient> => {
		assert.ok(cookie, 'expected a session cookie for the WS upgrade');
		return create_ws_transport({
			base_url,
			ws_path,
			cookies: [cookie],
			origin: base_url,
			on_request,
			default_timeout_ms: FRAME_TIMEOUT_MS
		});
	};

	const send_ping = (ws: WsClient, id: number | string, nonce: number): Promise<void> =>
		ws.send(create_jsonrpc_request(PEER_PING_METHOD, { nonce } as never, id));

	const send_heartbeat = (ws: WsClient, id: number | string): Promise<void> =>
		ws.send(create_jsonrpc_request(HEARTBEAT_METHOD, undefined as never, id));

	const assert_duplicate_refusal = (frame: ResponseFrame, id: number | string): void => {
		assert.ok('error' in frame, `expected the duplicate to be refused: ${JSON.stringify(frame)}`);
		assert.strictEqual(frame.id, id);
		assert.strictEqual(frame.error.code, INVALID_REQUEST);
		assert.strictEqual(frame.error.message, 'invalid request');
		assert.deepStrictEqual(frame.error.data, { reason: REASON_DUPLICATE_REQUEST_ID });
	};

	describe('ws inbound dispatch refusals (cross-process)', () => {
		test_if(
			capabilities.peer_request,
			'a request reusing a live id is refused with that id; the first keeps it, then the id frees',
			async () => {
				const fixture = await setup_test();
				const { responder, release, pinged } = create_holding_responder();
				const ws = await open_ws(fixture.create_session_headers().cookie, responder);
				try {
					const id = 'held';
					await send_ping(ws, id, 41);
					// the server pinged back: the first request is dispatched and waiting
					await pinged(1);

					await send_heartbeat(ws, id);
					assert_duplicate_refusal(await ws.wait_for<ResponseFrame>(is_error_for(id)), id);

					// the string '7' and the number 7 are different ids on both spines
					await send_ping(ws, 7, 7);
					await pinged(2);
					await send_heartbeat(ws, '7');
					await ws.wait_for(is_heartbeat_result_for('7'));

					release();
					const first = await ws.wait_for<JsonrpcSuccessResponseFrame<{ nonce: number }>>(
						is_ping_result_for(id)
					);
					assert.strictEqual(first.result.nonce, 41, 'the first request answers under its id');
					await ws.wait_for(is_ping_result_for(7));

					// answered, the id is free again
					await send_heartbeat(ws, id);
					await ws.wait_for(is_heartbeat_result_for(id));
					const refusals = ws.messages.filter(is_error_for(id));
					assert.strictEqual(refusals.length, 1, 'only the duplicate was refused');
				} finally {
					await ws.close();
				}
			}
		);

		test_if(
			capabilities.peer_request,
			'past the in-flight ceiling a request is shed with queue_overflow and the socket keeps serving',
			async () => {
				const fixture = await setup_test();
				const { responder, release } = create_holding_responder();
				const ws = await open_ws(fixture.create_session_headers().cookie, responder);
				try {
					for (let n = 0; n < MAX_INBOUND_DISPATCHES; n++) {
						await send_ping(ws, n, n);
					}
					// a duplicate at the ceiling is refused as a duplicate — that check is first
					await send_heartbeat(ws, 0);
					await send_heartbeat(ws, 'over');

					assert_duplicate_refusal(await ws.wait_for<ResponseFrame>(is_error_for(0)), 0);
					const over = await ws.wait_for<ResponseFrame>(is_response_for('over'));
					assert.ok('error' in over, `expected the request to be shed: ${JSON.stringify(over)}`);
					assert.strictEqual(over.error.code, QUEUE_OVERFLOW);
					assert.strictEqual(over.error.message, OVERFLOW_MESSAGE);
					assert.strictEqual(ws.close_code, null, 'shedding never closes the socket');

					release();
					for (let n = 0; n < MAX_INBOUND_DISPATCHES; n++) {
						const frame = await ws.wait_for<JsonrpcSuccessResponseFrame<{ nonce: number }>>(
							is_ping_result_for(n)
						);
						assert.strictEqual(frame.result.nonce, n);
					}
					await send_heartbeat(ws, 'after');
					await ws.wait_for(is_heartbeat_result_for('after'));
				} finally {
					await ws.close();
				}
			}
		);
	});
};
