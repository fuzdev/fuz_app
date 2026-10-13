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
 * - **overflow** — a burst far past the budget closes the socket with the code
 *   and the exact reason; the response of the flooding request never arrives;
 *   any flood frames that did arrive form a contiguous prefix of the burst.
 *   A second connection on the same account keeps dispatching throughout.
 * - **refusal** — a burst past the action's own size limit is refused with
 *   `invalid_params`, and the socket stays open.
 * - **no connection** — over HTTP RPC the action refuses with `invalid_params`
 *   and reason `no_connection`, rather than answering as though it flooded.
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
/** A burst of 32 MiB — eight times the default budget. */
const OVERFLOWS = { count: 32, size: MIB } as const;
/** One mebibyte past the action's `count` × `size` limit. */
const REFUSED = { count: 65, size: MIB } as const;

/** How long the test waits for the overflow close. */
const CLOSE_TIMEOUT_MS = 15_000;

/** Options for the outbound-overflow parity suite. */
export interface WsOutboundOverflowCrossTestOptions {
	/** Per-test fixture producer (`default_cross_process_setup(handle)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every WebSocket case gates on `capabilities.ws`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
	readonly ws_path: string;
	/** Origin for the session socket's upgrade. Defaults to `base_url`. */
	readonly origin?: string;
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
	const { setup_test, capabilities, base_url, ws_path, origin, rpc_path } = options;

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

	describe('websocket outbound overflow parity', { timeout: 30_000 }, () => {
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
			'a burst past the budget closes the socket with WS_CLOSE_OUTBOUND_OVERFLOW and no response',
			async () => {
				const fixture = await setup_test();
				// a second connection on the same account (the keeper's session)
				const bystander = await create_admitted_ws_transport({
					base_url,
					ws_path,
					cookies: fixture.transport.cookies(),
					origin
				});
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
	});
};
