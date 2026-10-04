import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **per-account WebSocket connection cap**
 * over a real upgrade.
 *
 * Both spines bound an account's concurrent WebSocket connections
 * (`BackendWebsocketTransport`'s `max_connections_per_account` on the TS side,
 * the Rust `fuz_realtime` `ConnectionRegistry` on the other; both default to
 * `DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`) with the same policy: **evict-oldest**
 * — a connection past the cap is always admitted, and the account's oldest is
 * closed with `WS_CLOSE_CONNECTION_LIMIT` and the reason `connection limit`.
 * A client reads that close as "superseded": closed until the user acts, not
 * revoked and not reconnecting (`FrontendWebsocketClient.superseded`). The
 * code, the reason, and which socket closes are therefore wire contract, and
 * this suite is the pin that runs on both. Two cases:
 *
 * - **the oldest is superseded, and it is not a revocation** — on one session,
 *   opening one socket past the cap closes exactly the first with the
 *   connection-limit code and reason; every other socket, the newest included,
 *   stays open and still dispatches. The session then upgrades again, which a
 *   revoked session could not — and that upgrade supersedes the next-oldest
 *   in turn.
 * - **a closed connection frees its slot** — one socket held open while a
 *   cap's worth of others open and close in sequence is never evicted. A
 *   backend that leaks closed connections in its registry counts them toward
 *   the cap and closes the held socket, which is what this catches.
 *
 * Sockets open in sequence, each answering a `heartbeat` before the next
 * opens, so the backend registered them in that order and "oldest" names the
 * same socket on both spines (an upgrade answers its handshake before the
 * connection is registered, so the handshake alone doesn't order them).
 *
 * **Consumer-agnostic**, like `describe_cross_process_ws_tests`: it drives
 * only the `heartbeat` protocol action, present on every WS endpoint. Gated on
 * `capabilities.ws`; cross-process only (`create_ws_transport` needs a real
 * bound socket). Each case opens more than a cap's worth of real sockets,
 * which is why it's a separate call rather than more cases on the WS
 * round-trip suite.
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import { heartbeat_action_spec } from '../../actions/heartbeat.ts';
import { WS_CLOSE_CONNECTION_LIMIT } from '../../actions/transports.ts';
import { DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT } from '../../actions/transports_ws_backend.ts';
import type { WsClient } from '../transports/ws_client.ts';
import { create_ws_transport } from '../transports/ws_transport.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest } from './setup.ts';

/** The close reason both spines send with `WS_CLOSE_CONNECTION_LIMIT`. */
const CONNECTION_LIMIT_REASON = 'connection limit';

/** Options for the WebSocket connection-cap parity suite. */
export interface WsConnectionCapCrossTestOptions {
	/**
	 * Per-test fixture producer (`default_cross_process_setup(handle)`). Every
	 * socket in a case upgrades with the fresh-per-test keeper's session
	 * cookies, so they all land on one account.
	 */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `capabilities.ws`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
	readonly ws_path: string;
	/** Origin for the upgrades. Defaults to `base_url`. */
	readonly origin?: string;
	/**
	 * The backend's per-account connection cap, which each case opens past.
	 * Defaults to `DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`, the cap both spines
	 * apply unless overridden; pass the consumer's value when it sets one, or
	 * `null` (a backend with the cap disabled) to skip the cases.
	 */
	readonly max_connections_per_account?: number | null;
}

/**
 * Register the WebSocket connection-cap parity suite over a real upgrade:
 * one connection past the cap closes the account's oldest with
 * `WS_CLOSE_CONNECTION_LIMIT` and nothing else, and a closed connection
 * frees its slot.
 */
export const describe_ws_connection_cap_cross_tests = (
	options: WsConnectionCapCrossTestOptions
): void => {
	const { setup_test, capabilities, base_url, ws_path, origin } = options;
	const max =
		options.max_connections_per_account === undefined
			? DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
			: options.max_connections_per_account;
	const enabled = capabilities.ws && max !== null;

	/**
	 * Open a socket and round-trip `heartbeat` on it, so the backend has
	 * registered the connection by the time this resolves.
	 */
	const open_registered = async (cookies: ReadonlyArray<string>): Promise<WsClient> => {
		const client = await create_ws_transport({ base_url, ws_path, cookies, origin });
		try {
			await client.request('open', heartbeat_action_spec.method, {});
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
		return client;
	};

	const assert_superseded = async (client: WsClient, label: string): Promise<void> => {
		const closed = await client.wait_for_close(2000);
		assert.ok(closed, `${label} did not close within 2s of the cap overflow`);
		assert.strictEqual(client.close_code, WS_CLOSE_CONNECTION_LIMIT, `${label} close code`);
		assert.strictEqual(client.close_reason, CONNECTION_LIMIT_REASON, `${label} close reason`);
	};

	/** Every client still open and answering — a fresh request id per call via `id`. */
	const assert_all_answer = async (
		clients: ReadonlyArray<WsClient>,
		id: string,
		message: string
	): Promise<void> => {
		const results = await Promise.all(
			clients.map((client) => client.request(id, heartbeat_action_spec.method, {}))
		);
		assert.deepStrictEqual(
			results,
			clients.map(() => ({})),
			message
		);
		assert.deepStrictEqual(
			clients.map((client) => client.close_code),
			clients.map(() => null),
			message
		);
	};

	// each case opens more than a cap's worth of real sockets in sequence, so its
	// time scales with the cap and the backend's upgrade cost
	describe('per-account websocket connection cap parity', { timeout: 30_000 }, () => {
		test_if(
			enabled,
			'one connection past the cap closes the oldest with WS_CLOSE_CONNECTION_LIMIT, and only it',
			async () => {
				const fixture = await setup_test();
				const cookies = fixture.transport.cookies();
				const sockets: Array<WsClient> = [];
				try {
					for (let i = 0; i < max!; i++) {
						sockets.push(await open_registered(cookies));
					}
					// at the cap, nothing has closed
					await assert_all_answer(sockets, 'at_cap', 'every socket at the cap stays open');

					// one past it: always admitted, never refused
					sockets.push(await open_registered(cookies));
					const [oldest, ...survivors] = sockets;
					await assert_superseded(oldest!, 'the oldest socket');
					await assert_all_answer(
						survivors,
						'past_cap',
						'only the oldest may close; every other socket, the newest included, keeps answering'
					);

					// Not a revocation — the session still authenticates an upgrade
					// (a revoked one is refused there). That upgrade is one more past
					// the cap, so it supersedes the next-oldest.
					sockets.push(await open_registered(cookies));
					await assert_superseded(survivors[0]!, 'the next-oldest socket');
					await assert_all_answer(
						sockets.slice(2),
						'past_cap_again',
						'the session keeps its newest sockets after a second overflow'
					);
				} finally {
					await Promise.all(sockets.map((client) => client.close().catch(() => {})));
				}
			}
		);

		test_if(enabled, 'a closed connection frees its slot', async () => {
			const fixture = await setup_test();
			const cookies = fixture.transport.cookies();
			const held = await open_registered(cookies);
			try {
				// A cap's worth of connections, one at a time, each closed before
				// the next opens — the account never holds more than a few at once,
				// however late the backend notices each close.
				for (let i = 0; i < max!; i++) {
					const client = await open_registered(cookies);
					await client.close();
				}
				await assert_all_answer(
					[held],
					'held',
					'closed connections must not count toward the cap — the held socket was evicted'
				);
			} finally {
				await held.close().catch(() => {});
			}
		});
	});
};
