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
 * **Consumer-agnostic**, apart from the cases `rpc_path` and
 * `capabilities.ws_account_actions` gate. Every other case drives the
 * `heartbeat` protocol action, which
 * `assert_ws_endpoints_include_protocol_actions` guarantees is present on
 * every WS endpoint — so the suite needs no knowledge of a consumer's domain
 * WS methods. It validates the transport, not the domain.
 *
 * The first three cases mirror the upgrade stack `register_ws_endpoint` wires
 * (origin check → `require_auth` → dispatch): an authenticated upgrade
 * round-trips `heartbeat`; an anonymous upgrade is refused; a
 * disallowed-origin upgrade is refused. Per-connection auth is enforced at
 * upgrade time (not per message), so the negative cases assert the upgrade
 * itself rejects rather than a per-message error frame.
 *
 * Spine-parity cases follow. Both spines admit a connection only after
 * re-reading its credential, and requests that arrive first wait for that
 * rather than being dropped: requests sent the moment the socket opens are all
 * answered, and — gated on `capabilities.ws_handshake_pipelining`, with the
 * ordering forced — so are frames written in the same TCP write as the upgrade
 * request (driven through `connect_raw_ws`, since a client library sends
 * nothing before its `open` event). `heartbeat` answers the parameterless
 * shapes (absent, `{}`) and refuses a declared param with `invalid_params`, and a
 * message over the backend's cap (`max_message_bytes`, default
 * `DEFAULT_WS_MAX_MESSAGE_BYTES`) closes the socket with
 * `WS_CLOSE_MESSAGE_TOO_BIG`.
 *
 * The final cases (gated on `rpc_path`) cover server-initiated close.
 * Per-message dispatch never re-checks credential validity, so an open socket
 * ends only when a revocation closes it — which every revocation does, once
 * its transaction commits. An authenticated socket is dropped when the
 * account's sessions are revoked over the keeper's session channel
 * (`account_session_revoke_all`), and when its account is deleted
 * (`account_delete`, also gated on `capabilities.account_lifecycle`). Omit
 * `rpc_path` to skip them (consumers without the standard account and admin
 * actions on their RPC endpoint).
 *
 * One more case is gated on `capabilities.ws_account_actions` — the backend's
 * WS endpoint mounts the self-service account actions: a socket that revokes
 * its own sessions *over that socket* is closed with
 * `WS_CLOSE_SESSION_REVOKED`, and — on a backend declaring
 * `capabilities.ws_self_revocation_reply` — reads the reply to its request
 * first. The TS spine queues the close behind the commit and sends the reply
 * ahead of it, so the caller is never left without an answer; the Rust spine
 * does not answer yet, which that flag records.
 *
 * Gated on `capabilities.ws` — backends without an end-to-end WS transport
 * skip (the cases still surface as `.skip` in the report). Cross-process
 * only: `create_ws_transport` needs a real bound socket, so wire it from a
 * `*.cross.test.ts` file, never an in-process setup.
 *
 * @module
 */

import { assert, describe } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { heartbeat_action_spec } from '../../actions/heartbeat.ts';
import {
	DEFAULT_WS_MAX_MESSAGE_BYTES,
	WS_CLOSE_MESSAGE_TOO_BIG,
	WS_CLOSE_SESSION_REVOKED
} from '../../actions/transports.ts';
import { account_session_revoke_all_action_spec } from '../../auth/account_action_specs.ts';
import { account_delete_action_spec } from '../../auth/admin_action_specs.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import {
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcSuccessResponseFrame,
	type WsClient
} from '../transports/ws_client.ts';
import { create_ws_transport } from '../transports/ws_transport.ts';
import {
	connect_raw_ws,
	is_raw_ws_close,
	RAW_WS_OPCODE_TEXT
} from '../transports/ws_raw_client.ts';
import { create_rpc_post_init } from '../rpc_helpers.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest } from './setup.ts';

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
	/**
	 * The backend's inbound WebSocket message cap, in bytes — the
	 * oversized-message case sends a message just past it. Defaults to
	 * `DEFAULT_WS_MAX_MESSAGE_BYTES`; pass the consumer's value when it raises
	 * the server cap.
	 */
	readonly max_message_bytes?: number;
}

/**
 * Register the cross-process WS round-trip suite over a real upgrade: authed
 * `heartbeat` round-trip, `heartbeat`'s parameterless-shape contract, an
 * oversized message closing with `WS_CLOSE_MESSAGE_TOO_BIG`, anonymous-upgrade
 * refusal, disallowed-origin refusal, and — when `rpc_path` is supplied —
 * session revocation and account deletion closing the live socket, plus a
 * self-revoking socket reading its reply before its close.
 */
export const describe_cross_process_ws_tests = (options: CrossProcessWsTestOptions): void => {
	const {
		setup_test,
		capabilities,
		base_url,
		ws_path,
		origin,
		rpc_path,
		max_message_bytes = DEFAULT_WS_MAX_MESSAGE_BYTES
	} = options;

	const open_authed = async (): Promise<WsClient> => {
		const fixture = await setup_test();
		return create_ws_transport({ base_url, ws_path, cookies: fixture.transport.cookies(), origin });
	};

	describe('cross-process websocket', () => {
		test_if(capabilities.ws, 'authenticated upgrade round-trips heartbeat', async () => {
			const client = await open_authed();
			try {
				const result = await client.request(1, heartbeat_action_spec.method, {});
				assert.deepStrictEqual(result, {}, 'heartbeat returns an empty result over the wire');
			} finally {
				await client.close();
			}
		});

		// Both spines answer the handshake before the connection is admitted
		// (the credential is re-read in between) and dispatch nothing until it
		// is. Requests that reach the backend first must wait for that
		// admission — not be dropped by it, and not run ahead of it.
		test_if(
			capabilities.ws,
			'requests sent the moment the socket opens are all answered',
			async () => {
				const client = await open_authed();
				try {
					const ids = [1, 2, 3];
					// back to back, with no round trip first — these may reach the
					// backend while the connection is still pending admission
					await Promise.all(
						ids.map((id) =>
							client.send({ jsonrpc: '2.0', id, method: heartbeat_action_spec.method })
						)
					);
					const frames = await Promise.all(
						ids.map((id) =>
							client.wait_for<JsonrpcSuccessResponseFrame | JsonrpcErrorResponseFrame>(
								is_response_for(id)
							)
						)
					);
					for (const frame of frames) {
						assert.ok('result' in frame, JSON.stringify(frame));
						assert.deepStrictEqual(frame.result, {});
					}
					assert.strictEqual(client.close_code, null);
				} finally {
					await client.close();
				}
			}
		);

		// The same contract with the ordering forced: frames written in the same
		// TCP write as the upgrade request are in the backend's hands before it
		// can have admitted anything.
		test_if(
			capabilities.ws && capabilities.ws_handshake_pipelining,
			'frames sent with the handshake are answered once the connection is admitted',
			async () => {
				const fixture = await setup_test();
				const url = new URL(base_url);
				const ids = [1, 2, 3];
				const client = await connect_raw_ws({
					hostname: url.hostname,
					port: url.port ? Number(url.port) : 80,
					path: ws_path,
					headers: {
						Cookie: fixture.transport.cookies().join('; '),
						Origin: origin ?? base_url
					},
					pipelined: ids.map((id) =>
						JSON.stringify({ jsonrpc: '2.0', id, method: heartbeat_action_spec.method })
					)
				});
				try {
					for (const id of ids) {
						const frame = await client.wait_for(
							(f) =>
								f.opcode === RAW_WS_OPCODE_TEXT &&
								(JSON.parse(f.payload.toString('utf-8')) as { id?: unknown }).id === id
						);
						assert.deepStrictEqual(JSON.parse(frame.payload.toString('utf-8')), {
							jsonrpc: '2.0',
							id,
							result: {}
						});
					}
					assert.ok(!client.frames.some(is_raw_ws_close), 'the socket stays open');
				} finally {
					client.destroy();
				}
			}
		);

		// `heartbeat` is parameterless on both spines (`z.void()` /
		// `require_void_params`): the empty shapes are the no-arg call, and a
		// declared param is `invalid_params`, not ignored.
		test_if(capabilities.ws, 'heartbeat admits only the parameterless shapes', async () => {
			const client = await open_authed();
			try {
				const cases: Array<[number, Record<string, unknown>, boolean]> = [
					[1, {}, true],
					[2, { params: {} }, true],
					[3, { params: { stray: 1 } }, false]
				];
				for (const [id, params, ok] of cases) {
					await client.send({
						jsonrpc: '2.0',
						id,
						method: heartbeat_action_spec.method,
						...params
					});
					const frame = await client.wait_for<
						JsonrpcSuccessResponseFrame | JsonrpcErrorResponseFrame
					>(is_response_for(id));
					const label = JSON.stringify(params);
					if (ok) {
						assert.ok('result' in frame, `${label}: ${JSON.stringify(frame)}`);
						assert.deepStrictEqual(frame.result, {}, label);
					} else {
						assert.ok('error' in frame, `${label}: ${JSON.stringify(frame)}`);
						assert.strictEqual(frame.error.code, JSONRPC_ERROR_CODES.invalid_params, label);
					}
				}
			} finally {
				await client.close();
			}
		});

		// Both spines cap an inbound message (`DEFAULT_WS_MAX_MESSAGE_BYTES` by
		// default) and close the socket on a larger one rather than replying.
		test_if(
			capabilities.ws,
			'an oversized message closes the socket with WS_CLOSE_MESSAGE_TOO_BIG',
			async () => {
				const client = await open_authed();
				try {
					await client.send({
						jsonrpc: '2.0',
						id: 1,
						method: heartbeat_action_spec.method,
						params: { pad: 'x'.repeat(max_message_bytes) }
					});
					const closed = await client.wait_for_close(5000);
					assert.ok(closed, 'socket did not close within 5s of an oversized message');
					assert.strictEqual(client.close_code, WS_CLOSE_MESSAGE_TOO_BIG);
				} finally {
					// the server may reset the connection under the unread tail
					await client.close().catch(() => {});
				}
			}
		);

		// Per-connection auth fires at upgrade time (`require_auth`), so an
		// anonymous socket never opens — the upgrade is refused outright.
		test_if(capabilities.ws, 'anonymous upgrade is refused', async () => {
			await assert_rejects(() => create_ws_transport({ base_url, ws_path, cookies: [], origin }));
		});

		// Origin is checked before auth, so cookies are irrelevant here.
		test_if(capabilities.ws, 'disallowed-origin upgrade is refused', async () => {
			await assert_rejects(() =>
				create_ws_transport({ base_url, ws_path, cookies: [], origin: DISALLOWED_ORIGIN })
			);
		});

		// Per-message dispatch never re-checks credential validity, so a live
		// socket drops only when a revocation closes it. Revoke the keeper's
		// sessions over its own session channel → the handler's post-commit
		// close ends the socket. Gated on `rpc_path` (depends on the standard
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
					origin
				});
				try {
					// Confirm the socket dispatches before revoking, so a failed
					// close assertion can't be confused with a dead connection.
					await client.request(1, heartbeat_action_spec.method, {});
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_revoke_all_action_spec.method)
					);
					assert.strictEqual(
						res.status,
						200,
						`account_session_revoke_all RPC failed (status=${res.status})`
					);
					const closed = await client.wait_for_close(2000);
					assert.ok(closed, 'socket did not close within 2s after session_revoke_all');
				} finally {
					await client.close();
				}
			}
		);

		// A soft-deleted account's credentials stop authenticating, and its open
		// socket must end with them: the tombstone revokes every session and
		// token, and the handler closes the account's connections once that has
		// committed. The keeper deletes a second account whose socket is open.
		test_if(
			capabilities.ws && capabilities.account_lifecycle && rpc_path !== undefined,
			'an account delete closes the live socket of the deleted account',
			async () => {
				const fixture = await setup_test();
				const target = await fixture.create_account({ username: 'ws_delete_target', roles: [] });
				const cookie = target.create_session_headers().cookie;
				assert.ok(cookie, 'expected a session cookie for the target account');
				const client = await create_ws_transport({ base_url, ws_path, cookies: [cookie], origin });
				try {
					// admitted and dispatching before the delete, so a failed close
					// assertion can't be confused with a dead connection
					await client.request(1, heartbeat_action_spec.method, {});
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_delete_action_spec.method, {
							account_id: target.account.id
						})
					);
					assert.strictEqual(res.status, 200, `account_delete RPC failed (status=${res.status})`);
					const closed = await client.wait_for_close(2000);
					assert.ok(closed, 'socket did not close within 2s after account_delete');
					assert.strictEqual(client.close_code, WS_CLOSE_SESSION_REVOKED);
				} finally {
					await client.close();
				}
			}
		);

		// A socket that revokes the session it is running on. It must be closed;
		// and where the backend declares `ws_self_revocation_reply`, the request
		// is answered first, the close following from behind the revocation's
		// commit. A caller left with only the close cannot tell a completed
		// revocation from a dropped connection.
		test_if(
			capabilities.ws && capabilities.ws_account_actions,
			capabilities.ws_self_revocation_reply
				? 'a socket that revokes its own sessions reads the reply, then the revocation close'
				: 'a socket that revokes its own sessions is closed with the revocation code',
			async () => {
				const client = await open_authed();
				try {
					await client.request(1, heartbeat_action_spec.method, {});
					const revoke_id = 2;
					await client.send({
						jsonrpc: '2.0',
						id: revoke_id,
						method: account_session_revoke_all_action_spec.method
					});
					const closed = await client.wait_for_close(2000);
					assert.ok(closed, 'socket did not close within 2s of revoking its own sessions');
					assert.strictEqual(client.close_code, WS_CLOSE_SESSION_REVOKED);
					if (capabilities.ws_self_revocation_reply) {
						// frames arrive in wire order and nothing arrives after the
						// close, so a reply in hand was written ahead of it
						const reply = client.messages.find(is_response_for(revoke_id)) as
							JsonrpcSuccessResponseFrame | JsonrpcErrorResponseFrame | undefined;
						assert.ok(reply, 'the reply must reach the caller before the close');
						assert.ok('result' in reply, JSON.stringify(reply));
						const result = reply.result as { ok?: boolean; count?: number };
						assert.strictEqual(result.ok, true);
						assert.ok((result.count ?? 0) >= 1, "at least the socket's own session was revoked");
					}
				} finally {
					await client.close();
				}
			}
		);
	});
};
