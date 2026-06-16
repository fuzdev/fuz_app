import '../assert_dev_env.ts';

/**
 * Cross-process WebSocket round-trip suite — the cross-process counterpart
 * to the in-process `testing/ws_round_trip.ts` harness.
 *
 * Where the in-process harness drives `register_action_ws` against a fake
 * Hono upgrade (no wire), this suite performs a **real** `WebSocket`
 * upgrade against a spawned backend via `create_ws_transport` (the `ws`
 * npm package), so the actual upgrade handshake + per-connection auth +
 * JSON-RPC dispatch over the socket are exercised end-to-end. It is the
 * only coverage of the spawned binary's live WS path — the standard
 * cross-process bundle (`describe_standard_cross_process_tests`) omits WS
 * by design, so consumers call this alongside it.
 *
 * **Consumer-agnostic.** Every case drives the `heartbeat` protocol action,
 * which `assert_ws_endpoints_include_protocol_actions` guarantees is present
 * on every WS endpoint — so the suite needs no knowledge of a consumer's
 * domain WS methods. It validates the transport, not the domain.
 *
 * The first three cases mirror the upgrade stack `register_ws_endpoint` wires
 * (origin check → `require_auth` → dispatch): an authenticated upgrade
 * round-trips `heartbeat`; an anonymous upgrade is refused; a
 * disallowed-origin upgrade is refused. Per-connection auth is enforced at
 * upgrade time (not per message), so the negative cases assert the upgrade
 * itself rejects rather than a per-message error frame.
 *
 * A fourth case (gated on `rpc_path`) covers server-initiated close: an
 * authenticated socket is dropped when the account's sessions are revoked
 * mid-connection. Per-message dispatch never re-checks credential validity,
 * so the live socket survives on the audit-fed `create_ws_auth_guard` seam —
 * firing `account_session_revoke_all` over the keeper's session channel
 * emits `session_revoke_all`, which closes the socket. Omit `rpc_path` to
 * skip it (consumers without the standard account actions on their RPC
 * endpoint).
 *
 * Gated on `capabilities.ws` — backends without an end-to-end WS transport
 * skip (the cases still surface as `.skip` in the report). Cross-process
 * only: `create_ws_transport` needs a real bound socket, so wire it from a
 * `*.cross.test.ts` file, never an in-process setup.
 *
 * @module
 */

import {assert, describe} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.ts';

import {heartbeat_action_spec} from '../../actions/heartbeat.ts';
import {account_session_revoke_all_action_spec} from '../../auth/account_action_specs.ts';
import {create_ws_transport} from '../transports/ws_transport.ts';
import {create_rpc_post_init} from '../rpc_helpers.ts';
import {type BackendCapabilities, test_if} from './capabilities.ts';
import type {SetupTest} from './setup.ts';

/** Origin guaranteed to fail the `http://localhost:*` allowlist the test backends run with. */
const DISALLOWED_ORIGIN = 'http://disallowed.example';

/** Configuration for {@link describe_cross_process_ws_tests}. */
export interface CrossProcessWsTestOptions {
	/**
	 * Per-test fixture producer (`default_cross_process_setup(handle)`).
	 * The authenticated case reads the fresh-per-test keeper's session
	 * cookies from `fixture.transport.cookies()` to thread onto the upgrade.
	 */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `capabilities.ws`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
	readonly ws_path: string;
	/** Origin for the authenticated upgrade. Defaults to `base_url`. */
	readonly origin?: string;
	/**
	 * RPC endpoint path (e.g. `/api/rpc`) used by the close-on-revoke case to
	 * fire `account_session_revoke_all` over the keeper's session channel.
	 * When omitted, that case is skipped — it depends on the standard account
	 * actions being mounted on the RPC endpoint.
	 */
	readonly rpc_path?: string;
}

/**
 * Register the cross-process WS round-trip suite. Up to four cases over a
 * real upgrade: authed `heartbeat` round-trip, anonymous-upgrade refusal,
 * disallowed-origin refusal, and — when `rpc_path` is supplied —
 * session-revocation closing the live socket.
 */
export const describe_cross_process_ws_tests = (options: CrossProcessWsTestOptions): void => {
	const {setup_test, capabilities, base_url, ws_path, origin, rpc_path} = options;

	describe('cross-process websocket', () => {
		test_if(capabilities.ws, 'authenticated upgrade round-trips heartbeat', async () => {
			const fixture = await setup_test();
			const client = await create_ws_transport({
				base_url,
				ws_path,
				cookies: fixture.transport.cookies(),
				origin,
			});
			try {
				const result = await client.request(1, heartbeat_action_spec.method, {});
				assert.deepStrictEqual(result, {}, 'heartbeat returns an empty result over the wire');
			} finally {
				await client.close();
			}
		});

		// Per-connection auth fires at upgrade time (`require_auth`), so an
		// anonymous socket never opens — the upgrade is refused outright.
		test_if(capabilities.ws, 'anonymous upgrade is refused', async () => {
			await assert_rejects(() => create_ws_transport({base_url, ws_path, cookies: [], origin}));
		});

		// Origin is checked before auth, so cookies are irrelevant here.
		test_if(capabilities.ws, 'disallowed-origin upgrade is refused', async () => {
			await assert_rejects(() =>
				create_ws_transport({base_url, ws_path, cookies: [], origin: DISALLOWED_ORIGIN}),
			);
		});

		// Per-message dispatch never re-checks credential validity, so a live
		// socket only drops via the audit-fed `create_ws_auth_guard`. Revoke the
		// keeper's sessions over its own session channel → `session_revoke_all`
		// closes the socket. Gated on `rpc_path` (depends on the standard
		// account actions on the RPC endpoint).
		test_if(
			capabilities.ws && rpc_path !== undefined,
			'session revocation closes the live socket',
			async () => {
				const fixture = await setup_test();
				const client = await create_ws_transport({
					base_url,
					ws_path,
					cookies: fixture.transport.cookies(),
					origin,
				});
				try {
					// Confirm the socket dispatches before revoking, so a failed
					// close assertion can't be confused with a dead connection.
					await client.request(1, heartbeat_action_spec.method, {});
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_revoke_all_action_spec.method),
					);
					assert.strictEqual(
						res.status,
						200,
						`account_session_revoke_all RPC failed (status=${res.status})`,
					);
					const closed = await client.wait_for_close(2000);
					assert.ok(closed, 'socket did not close within 2s after session_revoke_all');
				} finally {
					await client.close();
				}
			},
		);
	});
};
