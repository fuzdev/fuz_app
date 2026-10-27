import '../assert_dev_env.ts';

/**
 * Cross-process suite for the WebSocket read loop's **frame envelope** — what
 * each spine answers to a frame before anything dispatches, pinned over a real
 * upgrade. The HTTP twin is `rpc_adversarial`'s envelope cases
 * (`create_rpc_envelope_cases`); a socket classifies its frames in its own
 * loop (TS `register_action_ws`, Rust `fuz_realtime`'s `ws_endpoint`), so the
 * HTTP pins say nothing about it.
 *
 * - **a parse error** — a frame that is not JSON answers `parse_error` with
 *   `id: null`, and the socket keeps serving
 * - **a non-object frame** — a JSON scalar answers `invalid_request` with
 *   `id: null` (the scalar is not read as its own id)
 * - **a batch array** — answers one `invalid_request` with `id: null`; batches
 *   are not supported on either transport
 * - **a notification** — a string method with no id answers no frame
 * - **a stray response** — a `{id, result}` frame matching no server-initiated
 *   request answers no frame (it demuxes as a peer response and is dropped)
 * - **`cancel`** — the notification answers no frame: for an unknown id, for
 *   malformed params, and for a request in flight, which keeps running and
 *   answers under its id once it completes (neither spine's `peer/ping`
 *   observes its signal, so the cancel's effect is invisible here; consumer
 *   suites with a signal-observing seam pin it)
 *
 * **Silence is asserted positively**: each case marks the received-message
 * count, sends its frames, then round-trips a `heartbeat` probe and reads back
 * everything after the mark. The socket is ordered, so a frame that should
 * produce nothing leaves exactly the probe's response, and the probe doubles as
 * proof the socket survived the frame.
 *
 * Wire codes are independent copies of the producers' constants — parity by
 * test. Gated on `capabilities.ws`; the in-flight cancel also on
 * `capabilities.peer_request` (it holds a request with `peer/ping`).
 *
 * Cross-process only: `create_ws_transport` needs a real bound socket, so wire
 * it from a `*.cross.test.ts` file.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import { create_jsonrpc_request } from '../../http/jsonrpc_helpers.ts';
import { is_response_for, type JsonrpcSuccessResponseFrame } from '../transports/ws_client.ts';
import type { WsTransportClient } from '../transports/ws_transport.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { open_session_ws, type WsEndpointTarget } from './ws_endpoint.ts';
import { create_holding_peer_ping_responder } from './ws_inbound_dispatch.ts';

const JSONRPC_VERSION = '2.0';
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;

const HEARTBEAT_METHOD = 'heartbeat';
const PEER_PING_METHOD = 'peer/ping';
const CANCEL_METHOD = 'cancel';

/** How long the test waits on a frame — above the server's peer-request deadline. */
const FRAME_TIMEOUT_MS = 12_000;

/** Configuration for `describe_ws_envelope_cross_tests`. */
export interface WsEnvelopeCrossTestOptions extends WsEndpointTarget {
	/** Per-test fixture producer (`default_cross_process_setup(handle)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags — `ws` gates every case, `peer_request` the in-flight cancel. */
	readonly capabilities: BackendCapabilities;
}

/** One frame sent as-is: an object serialized by the client, or raw text. */
type OutboundFrame = { readonly json: unknown } | { readonly text: string };

const frame_id = (frame: unknown): unknown =>
	typeof frame === 'object' && frame !== null ? (frame as { id?: unknown }).id : undefined;

/**
 * Send `frames`, round-trip a `heartbeat` probe, and return every frame that
 * arrived after the mark except the probe's response.
 */
const frames_after = async (
	ws: WsTransportClient,
	frames: ReadonlyArray<OutboundFrame>
): Promise<ReadonlyArray<unknown>> => {
	const mark = ws.messages.length;
	const probe_id = `probe-${mark}`;
	for (const frame of frames) {
		await ('text' in frame ? ws.send_text(frame.text) : ws.send(frame.json));
	}
	await ws.send(create_jsonrpc_request(HEARTBEAT_METHOD, undefined, probe_id));
	await ws.wait_for(is_response_for(probe_id), FRAME_TIMEOUT_MS);
	return ws.messages.slice(mark).filter((frame) => frame_id(frame) !== probe_id);
};

/** A frame each spine answers with one error envelope, and that envelope. */
interface RefusedFrameCase {
	readonly name: string;
	readonly frame: OutboundFrame;
	readonly code: number;
}

const REFUSED_FRAME_CASES: ReadonlyArray<RefusedFrameCase> = [
	{
		name: 'a frame that is not JSON',
		frame: { text: '{"jsonrpc": "2.0", "id": 1,' },
		code: PARSE_ERROR
	},
	{ name: 'a scalar frame', frame: { json: 5 }, code: INVALID_REQUEST },
	{ name: 'a bare string frame', frame: { json: HEARTBEAT_METHOD }, code: INVALID_REQUEST },
	{
		name: 'a batch array',
		frame: { json: [create_jsonrpc_request(HEARTBEAT_METHOD, undefined, 1)] },
		code: INVALID_REQUEST
	}
];

const SILENT_FRAME_CASES: ReadonlyArray<{ name: string; frames: ReadonlyArray<OutboundFrame> }> = [
	{
		name: 'a notification',
		frames: [{ json: { jsonrpc: JSONRPC_VERSION, method: HEARTBEAT_METHOD } }]
	},
	{
		name: 'a stray response matching no server request',
		frames: [{ json: { jsonrpc: JSONRPC_VERSION, id: 'stray', result: {} } }]
	},
	{
		name: 'a cancel for an unknown id',
		frames: [
			{ json: { jsonrpc: JSONRPC_VERSION, method: CANCEL_METHOD, params: { request_id: 'nope' } } }
		]
	},
	{
		name: 'a cancel with malformed params',
		frames: [
			{ json: { jsonrpc: JSONRPC_VERSION, method: CANCEL_METHOD, params: { request_id: true } } },
			{ json: { jsonrpc: JSONRPC_VERSION, method: CANCEL_METHOD } }
		]
	}
];

/**
 * Register the WS frame-envelope cases. Gated on `capabilities.ws`; the
 * in-flight cancel also on `capabilities.peer_request`.
 */
export const describe_ws_envelope_cross_tests = (options: WsEnvelopeCrossTestOptions): void => {
	const { setup_test, capabilities } = options;

	const open_ws = (fixture: TestFixture): Promise<WsTransportClient> =>
		open_session_ws(options, fixture, { admitted: true, default_timeout_ms: FRAME_TIMEOUT_MS });

	describe('ws frame envelope (cross-process)', () => {
		for (const { name, frame, code } of REFUSED_FRAME_CASES) {
			test_if(capabilities.ws, `${name} answers ${code} with id null`, async () => {
				const fixture = await setup_test();
				const ws = await open_ws(fixture);
				try {
					const frames = await frames_after(ws, [frame]);
					assert.lengthOf(frames, 1, `expected one refusal, got ${JSON.stringify(frames)}`);
					const answer = frames[0] as {
						jsonrpc?: unknown;
						id?: unknown;
						error?: { code?: unknown };
					};
					assert.deepStrictEqual(
						{ jsonrpc: answer.jsonrpc, id: answer.id, code: answer.error?.code },
						{ jsonrpc: JSONRPC_VERSION, id: null, code },
						`refusal envelope: ${JSON.stringify(answer)}`
					);
					assert.strictEqual(ws.close_code, null, 'the refusal never closes the socket');
				} finally {
					await ws.close();
				}
			});
		}

		for (const { name, frames: sent } of SILENT_FRAME_CASES) {
			test_if(capabilities.ws, `${name} answers no frame`, async () => {
				const fixture = await setup_test();
				const ws = await open_ws(fixture);
				try {
					const frames = await frames_after(ws, sent);
					assert.lengthOf(frames, 0, `expected no frame, got ${JSON.stringify(frames)}`);
				} finally {
					await ws.close();
				}
			});
		}

		test_if(
			capabilities.ws && capabilities.peer_request,
			'a cancel for a request in flight answers no frame; the request answers under its id',
			async () => {
				const fixture = await setup_test();
				const { responder, release, pinged } = create_holding_peer_ping_responder();
				const ws = await open_session_ws(options, fixture, {
					admitted: true,
					on_request: responder,
					default_timeout_ms: FRAME_TIMEOUT_MS
				});
				try {
					const id = 'held';
					await ws.send(create_jsonrpc_request(PEER_PING_METHOD, { nonce: 41 }, id));
					// the server pinged back: the request is dispatched and waiting
					await pinged(1);

					const frames = await frames_after(ws, [
						{
							json: { jsonrpc: JSONRPC_VERSION, method: CANCEL_METHOD, params: { request_id: id } }
						}
					]);
					assert.lengthOf(frames, 0, `expected no frame, got ${JSON.stringify(frames)}`);

					release();
					const answer = await ws.wait_for<JsonrpcSuccessResponseFrame<{ nonce: number }>>(
						is_response_for(id)
					);
					assert.deepStrictEqual(
						(answer as { result?: { nonce?: unknown } }).result?.nonce,
						41,
						`the cancelled request's answer: ${JSON.stringify(answer)}`
					);
				} finally {
					release();
					await ws.close();
				}
			}
		);
	});
};
