import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **per-connection outbound bound** over a
 * real upgrade.
 *
 * Both spines hold what waits to be written to one WebSocket to a byte budget
 * (`BackendWebsocketTransport`'s `outbound_queue_bytes` on the TS side, the
 * Rust `fuz_realtime` outbound queue on the other; both default to 4 MiB, each
 * waiting frame charged its UTF-8 length plus 64 bytes). A frame that does not
 * fit closes the socket with `WS_CLOSE_OUTBOUND_OVERFLOW` and the reason
 * `outbound queue overflow`; the credential stays good, so a client reconnects
 * under its ordinary backoff. The code and the reason are therefore wire
 * contract, and this suite is the pin that runs on both.
 *
 * It drives the backend's `_testing_flood_notifications` action, which queues
 * a burst of notifications onto the caller's own connection in one synchronous
 * run — so the burst waits at once whether or not the client is reading, and
 * the overflow is deterministic. The cases:
 *
 * - **within the budget** — a small burst arrives whole and in order, ahead of
 *   its response, and the socket stays open.
 * - **large, within the budget** — a burst of a few mebibytes, most of the
 *   default budget, arrives the same way: every frame whole, in order, the
 *   response last. Megabyte frames can outrun a socket's buffer, and where
 *   they do — the Deno TS spine, as observed; Node and Bun write the burst
 *   through — the frames behind the first wait on the backend's write pump.
 * - **overflow** — a burst far past the budget closes the socket with the code
 *   and the exact reason; the response of the flooding request never arrives;
 *   any flood frames that did arrive form a contiguous prefix of the burst.
 *   A second connection on the same account keeps dispatching throughout.
 * - **refusal** — a burst past the action's own size limit is refused with
 *   `invalid_params`, and the socket stays open.
 * - **no connection** — over HTTP RPC the action refuses with `invalid_params`
 *   and reason `no_connection`, rather than answering as though it flooded.
 * - **the action's limits** — over HTTP RPC a call at each of the action's
 *   limits (`count`, `size`, `count` × `size`) is refused for having no
 *   connection, and a call one past each is refused `invalid_params` with no
 *   reason. Both spines check the limits before they look for the connection
 *   and before they build a payload, so the boundaries are read off the
 *   refusal and no burst is ever allocated — which pins the two spines'
 *   limits equal.
 *
 * What the suite does **not** assert, because it is each implementation's own:
 * how many frames accepted before the overflow reach the client (the Rust
 * spine discards them all; the TS spine may deliver the first), and the exact
 * boundary a burst of tiny frames overflows at.
 *
 * The wire literals are deliberate independent copies of the producers'
 * constants — parity by test, so a value changed on one side fails here
 * instead of moving both at once.
 *
 * The flood action is gated on the daemon token, so the flooding socket
 * upgrades with it and no `Origin` (both spines discard a daemon token
 * presented in a browser context). Gated on `capabilities.ws`; cross-process
 * only (`create_ws_transport` needs a real bound socket), and only for a
 * backend that mounts `_testing_flood_notifications` on its WS endpoint.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import { create_jsonrpc_request } from '../../http/jsonrpc_helpers.ts';
import { create_admitted_ws_transport } from '../transports/ws_transport.ts';
import {
	is_notification,
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcNotificationFrame,
	type WsClient
} from '../transports/ws_client.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import { cross_rpc_call } from './cell_cross_helpers.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { open_session_ws, type WsEndpointTarget } from './ws_endpoint.ts';

/** The close code both spines send on an outbound overflow. */
const WS_CLOSE_OUTBOUND_OVERFLOW = 4005;
/** The close reason both spines send with it. */
const OUTBOUND_OVERFLOW_REASON = 'outbound queue overflow';

const FLOOD_METHOD = '_testing_flood_notifications';
const FLOOD_NOTIFICATION_METHOD = '_testing_flood';
const HEARTBEAT_METHOD = 'heartbeat';
const INVALID_PARAMS = -32602;
const REASON_NO_CONNECTION = 'no_connection';

const MIB = 1024 * 1024;

/** A burst within any budget. */
const FITS = { count: 3, size: 8 } as const;
/**
 * A burst of 3 MiB in megabyte frames: charged a little over 3 MiB with its
 * envelopes and overhead, inside the 4 MiB default budget.
 */
const LARGE_FITS = { count: 3, size: MIB } as const;
/** A burst of 32 MiB — eight times the default budget. */
const OVERFLOWS = { count: 32, size: MIB } as const;
/** One mebibyte past the action's `count` × `size` limit. */
const REFUSED = { count: 65, size: MIB } as const;

/** The most notifications one flood call may ask for. */
const FLOOD_MAX_COUNT = 65_536;
/** The largest payload one flood call may ask for. */
const FLOOD_MAX_SIZE = 16 * MIB;
/** The most payload bytes (`count` × `size`) one flood call may ask for. */
const FLOOD_MAX_TOTAL_BYTES = 64 * MIB;

/**
 * A `count` and `size`, each within its own limit, whose product is exactly
 * one byte past `FLOOD_MAX_TOTAL_BYTES` (the factors of 2^26 + 1).
 */
const FLOOD_ONE_BYTE_PAST_TOTAL = { count: 265, size: 253_241 } as const;

/**
 * Calls at and one past each of the flood action's limits. Each "past" call
 * holds the other axis at zero, or both axes within their own limit, so one
 * limit alone decides it.
 */
const FLOOD_LIMIT_CASES: ReadonlyArray<{
	readonly name: string;
	readonly params: { readonly count: number; readonly size: number };
	readonly within: boolean;
}> = [
	{ name: 'count at its limit', params: { count: FLOOD_MAX_COUNT, size: 1 }, within: true },
	{ name: 'count past its limit', params: { count: FLOOD_MAX_COUNT + 1, size: 0 }, within: false },
	{ name: 'size at its limit', params: { count: 1, size: FLOOD_MAX_SIZE }, within: true },
	{ name: 'size past its limit', params: { count: 0, size: FLOOD_MAX_SIZE + 1 }, within: false },
	{
		name: 'count × size at its limit, both axes at theirs or under',
		params: { count: FLOOD_MAX_TOTAL_BYTES / FLOOD_MAX_SIZE, size: FLOOD_MAX_SIZE },
		within: true
	},
	{
		name: 'count × size at its limit, count at its own',
		params: { count: FLOOD_MAX_COUNT, size: FLOOD_MAX_TOTAL_BYTES / FLOOD_MAX_COUNT },
		within: true
	},
	{
		name: 'count × size past its limit, each axis within its own',
		params: { count: FLOOD_MAX_COUNT, size: FLOOD_MAX_TOTAL_BYTES / FLOOD_MAX_COUNT + 1 },
		within: false
	},
	{
		// the smallest step past the product limit: the row above overshoots it by
		// `FLOOD_MAX_COUNT` bytes, so alone it admits a limit that many bytes loose
		name: 'count × size one byte past its limit',
		params: FLOOD_ONE_BYTE_PAST_TOTAL,
		within: false
	}
];

/** How long the test waits for the megabyte burst and its response. */
const LARGE_BURST_TIMEOUT_MS = 15_000;

/** How long the test waits for the overflow close. */
const CLOSE_TIMEOUT_MS = 15_000;

/** Options for the outbound-overflow parity suite. */
export interface WsOutboundOverflowCrossTestOptions extends WsEndpointTarget {
	/** Per-test fixture producer (`default_cross_process_setup(handle)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every WebSocket case gates on `capabilities.ws`. */
	readonly capabilities: BackendCapabilities;
	/**
	 * The backend's RPC endpoint path, for the over-HTTP refusal. Omitted, that
	 * case is skipped.
	 */
	readonly rpc_path?: string;
}

/**
 * Register the outbound-overflow parity suite over a real upgrade: a burst
 * within the budget arrives whole, one past it closes the socket with
 * `WS_CLOSE_OUTBOUND_OVERFLOW` and no response, and the account's other
 * connection is unaffected.
 */
export const describe_ws_outbound_overflow_cross_tests = (
	options: WsOutboundOverflowCrossTestOptions
): void => {
	const { setup_test, capabilities, base_url, ws_path, rpc_path } = options;

	/** A daemon-token socket the backend has admitted — the one that floods itself. */
	const open_flooder = (fixture: TestFixture): Promise<WsClient> =>
		create_admitted_ws_transport({
			base_url,
			ws_path,
			cookies: [],
			origin: null,
			headers: fixture.create_daemon_token_headers()
		});

	/** The `index` of every flood notification `client` received, in arrival order. */
	const flood_indices = (client: WsClient): Array<number> =>
		client.messages
			.filter(is_notification(FLOOD_NOTIFICATION_METHOD))
			.map((msg) => (msg as JsonrpcNotificationFrame<{ index: number }>).params.index);

	const assert_open_and_answering = async (
		client: WsClient,
		id: string,
		message: string
	): Promise<void> => {
		assert.deepStrictEqual(await client.request(id, HEARTBEAT_METHOD, {}), {}, message);
		assert.strictEqual(client.close_code, null, message);
	};

	describe('websocket outbound overflow parity', () => {
		test_if(
			capabilities.ws,
			'a burst within the budget arrives in order, ahead of its response',
			async () => {
				const fixture = await setup_test();
				const client = await open_flooder(fixture);
				try {
					const result = await client.request('fits', FLOOD_METHOD, FITS);
					assert.deepStrictEqual(result, { queued: FITS.count });
					assert.deepStrictEqual(flood_indices(client), [0, 1, 2]);
					const frames = client.messages.filter(
						is_notification(FLOOD_NOTIFICATION_METHOD)
					) as Array<JsonrpcNotificationFrame<{ index: number; payload: string }>>;
					for (const frame of frames) {
						assert.strictEqual(frame.params.payload, 'x'.repeat(FITS.size));
					}
					// the whole burst is ahead of the response
					const response_at = client.messages.findIndex(is_response_for('fits'));
					const last_flood_at = client.messages.lastIndexOf(frames.at(-1));
					assert.ok(last_flood_at < response_at, 'the burst precedes its response');
					await assert_open_and_answering(client, 'after_fits', 'the socket stays open');
				} finally {
					await client.close().catch(() => {});
				}
			}
		);

		test_if(
			capabilities.ws,
			'a multi-megabyte burst within the budget arrives whole and in order, the response last',
			async () => {
				const fixture = await setup_test();
				const client = await open_flooder(fixture);
				try {
					const result = await client.request(
						'large_fits',
						FLOOD_METHOD,
						LARGE_FITS,
						LARGE_BURST_TIMEOUT_MS
					);
					assert.deepStrictEqual(result, { queued: LARGE_FITS.count });
					assert.deepStrictEqual(flood_indices(client), [0, 1, 2]);
					const frames = client.messages.filter(
						is_notification(FLOOD_NOTIFICATION_METHOD)
					) as Array<JsonrpcNotificationFrame<{ index: number; payload: string }>>;
					const payload = 'x'.repeat(LARGE_FITS.size);
					for (const frame of frames) {
						// compared by length first: a mismatch would otherwise print a mebibyte
						assert.strictEqual(frame.params.payload.length, LARGE_FITS.size);
						assert.ok(frame.params.payload === payload, 'the payload arrived intact');
					}
					// nothing follows the response: the whole burst is ahead of it
					const response_at = client.messages.findIndex(is_response_for('large_fits'));
					const last_flood_at = client.messages.lastIndexOf(frames.at(-1));
					assert.ok(last_flood_at < response_at, 'the burst precedes its response');
					assert.strictEqual(client.close_code, null, 'a burst within the budget closes nothing');
					await assert_open_and_answering(client, 'after_large_fits', 'the socket stays open');
				} finally {
					await client.close().catch(() => {});
				}
			}
		);

		test_if(
			capabilities.ws,
			'a burst past the budget closes the socket with WS_CLOSE_OUTBOUND_OVERFLOW and no response',
			async () => {
				const fixture = await setup_test();
				// a second connection on the same account (the keeper's session)
				const bystander = await open_session_ws(options, fixture, { admitted: true });
				const client = await open_flooder(fixture);
				try {
					await client.send(create_jsonrpc_request(FLOOD_METHOD, OVERFLOWS, 'overflows'));
					const closed = await client.wait_for_close(CLOSE_TIMEOUT_MS);
					assert.ok(closed, 'the flooded socket did not close');
					assert.strictEqual(client.close_code, WS_CLOSE_OUTBOUND_OVERFLOW);
					assert.strictEqual(client.close_reason, OUTBOUND_OVERFLOW_REASON);

					// the response of the request whose handler overflowed is not sent
					assert.strictEqual(
						client.messages.some(is_response_for('overflows')),
						false,
						'no response may follow an overflow'
					);
					// frames accepted before the overflow may or may not arrive; any
					// that do are a contiguous prefix of the burst, and never all of it
					const indices = flood_indices(client);
					assert.ok(indices.length < OVERFLOWS.count, `${indices.length} flood frames arrived`);
					assert.deepStrictEqual(
						indices,
						indices.map((_, i) => i),
						'the flood frames that arrived are a contiguous prefix from index 0'
					);

					// the account's other connection kept working through it
					await assert_open_and_answering(
						bystander,
						'bystander',
						"another connection on the account is untouched by the first one's overflow"
					);

					// not a revocation: the daemon token still upgrades
					const again = await open_flooder(fixture);
					await again.close();
				} finally {
					await Promise.all([client.close().catch(() => {}), bystander.close().catch(() => {})]);
				}
			}
		);

		test_if(
			capabilities.ws,
			'a burst past the flood action size limit is refused, and the socket stays open',
			async () => {
				const fixture = await setup_test();
				const client = await open_flooder(fixture);
				try {
					await client.send(create_jsonrpc_request(FLOOD_METHOD, REFUSED, 'refused'));
					const frame = await client.wait_for<Partial<JsonrpcErrorResponseFrame>>(
						is_response_for('refused')
					);
					assert.ok(frame.error, 'expected invalid_params but the call succeeded');
					assert.strictEqual(frame.error.code, INVALID_PARAMS);
					assert.deepStrictEqual(flood_indices(client), [], 'a refused burst queues nothing');
					await assert_open_and_answering(client, 'after_refused', 'the socket stays open');
				} finally {
					await client.close().catch(() => {});
				}
			}
		);

		test_if(
			rpc_path !== undefined,
			'over HTTP the flood action refuses with invalid_params, reason no_connection',
			async () => {
				const fixture = await setup_test();
				const res = await cross_rpc_call(
					fixture.fresh_transport({ origin: null }),
					rpc_path!,
					FLOOD_METHOD,
					FITS,
					fixture.create_daemon_token_headers()
				);
				assert.strictEqual(res.ok, false, 'expected a refusal over HTTP');
				assert.strictEqual(res.error?.code, INVALID_PARAMS);
				assert.strictEqual(
					(res.error?.data as { reason?: unknown } | undefined)?.reason,
					REASON_NO_CONNECTION
				);
			}
		);

		test_if(
			rpc_path !== undefined,
			'over HTTP a flood call at each limit is refused for no connection, one past it for its params',
			async () => {
				const fixture = await setup_test();
				const transport = fixture.fresh_transport({ origin: null });
				// the hand-factored case is only "one byte past" for this limit
				assert.strictEqual(
					FLOOD_ONE_BYTE_PAST_TOTAL.count * FLOOD_ONE_BYTE_PAST_TOTAL.size,
					FLOOD_MAX_TOTAL_BYTES + 1
				);
				for (const { name, params, within } of FLOOD_LIMIT_CASES) {
					const res = await cross_rpc_call(
						transport,
						rpc_path!,
						FLOOD_METHOD,
						params,
						fixture.create_daemon_token_headers()
					);
					assert.strictEqual(res.ok, false, `${name}: expected a refusal over HTTP`);
					assert.strictEqual(res.error?.code, INVALID_PARAMS, name);
					// within the limits the call gets as far as the connection check;
					// past one it is refused before that, with no reason
					assert.strictEqual(
						(res.error?.data as { reason?: unknown } | undefined)?.reason,
						within ? REASON_NO_CONNECTION : undefined,
						`${name}: ${JSON.stringify(params)}`
					);
				}
			}
		);
	});
};
