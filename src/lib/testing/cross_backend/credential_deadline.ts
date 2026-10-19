import '../assert_dev_env.ts';

/**
 * Cross-process **credential deadline** suite — a long-lived connection
 * closes when the credential it was opened with expires.
 *
 * A WebSocket or an audit stream is authorized once, at open, and closed on
 * revocation by identity — but expiry writes nothing a revocation listener
 * could hear. So each spine carries the credential's deadline onto the
 * connection (`ResolvedAuth.credential_deadline`: the earlier of a session's
 * cookie and row expiry, an API token's row expiry) and closes it there: a
 * socket with `WS_CLOSE_SESSION_REVOKED` and
 * `WS_CLOSE_CREDENTIAL_EXPIRED_REASON`, a stream by ending it as a revoked one
 * ends.
 *
 * Each case pulls a fresh account's credential expiries in to
 * `expiry_seconds` from now with the daemon-token
 * `_testing_shorten_credential_expiry` seam, **before** opening the
 * connection (the deadline is read when the credential resolves), then checks
 * the connection is open short of the deadline and closed at it:
 *
 * 1. WebSocket × session — 4001, "Credential expired".
 * 2. WebSocket × API token — the same.
 * 3. Audit stream × session — the stream ends.
 * 4. The seam only shortens: a second call asking for a later expiry moves
 *    nothing, and the socket still closes at the first deadline.
 *
 * The fourth reachable combination, API token × audit stream, is not here:
 * the stock audit stream admits sessions only on both spines. Each spine
 * covers it below the wire — the Rust stream route on a widened credential
 * gate, the TS deadline wait shared by both transports.
 *
 * Gated on `capabilities.ws` (cases 1, 2, 4) and `capabilities.sse` (case 3);
 * cross-process only — the seam is mounted on the spine test binaries.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import { heartbeat_action_spec } from '../../actions/heartbeat.ts';
import {
	WS_CLOSE_CREDENTIAL_EXPIRED_REASON,
	WS_CLOSE_SESSION_REVOKED
} from '../../actions/transports.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { SSE_CONNECTED_COMMENT } from '../../realtime/sse_constants.ts';
import { rpc_call_non_browser } from '../rpc_helpers.ts';
import { create_sse_transport } from '../transports/sse_transport.ts';
import type { WsClient } from '../transports/ws_client.ts';
import { create_admitted_ws_transport } from '../transports/ws_transport.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest, TestAccountFixture, TestFixture } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Default audit-log stream path. */
const DEFAULT_SSE_PATH = '/api/admin/audit/stream';

/** The shortened lifetime each case gives its credentials, in seconds. */
const EXPIRY_SECONDS = 2;

/**
 * How long past the deadline a close may take before the case fails — wide
 * for a loaded machine, and bounded so a missing close fails rather than
 * hangs.
 */
const CLOSE_GRACE_MS = 4000;

/**
 * The deadline counts from the seam's call, and the connection opens after
 * it; a close sooner than this after the call came before the deadline.
 */
const EARLIEST_CLOSE_MS = EXPIRY_SECONDS * 1000 - 300;

/** Configuration for `describe_credential_deadline_cross_tests`. */
export interface CredentialDeadlineCrossTestOptions {
	/** Per-test fixture producer (`default_cross_process_setup(handle)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags — the WebSocket cases gate on `ws`, the stream case on `sse`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at. */
	readonly base_url: string;
	/** The WebSocket endpoint path (e.g. `/api/ws`). */
	readonly ws_path: string;
	/** The audit-log stream path. Default `/api/admin/audit/stream`. */
	readonly sse_path?: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/**
 * Register the credential-deadline suite: a WebSocket on a session or an API
 * token closes with 4001 "Credential expired" at its credential's expiry, an
 * audit stream on a session ends there, and the expiry seam never extends.
 */
export const describe_credential_deadline_cross_tests = (
	options: CredentialDeadlineCrossTestOptions
): void => {
	const {
		setup_test,
		capabilities,
		base_url,
		ws_path,
		sse_path = DEFAULT_SSE_PATH,
		rpc_path = SPINE_RPC_PATH
	} = options;

	/**
	 * Pull `account`'s credential expiries in to `seconds` from now through the
	 * daemon-token seam, returning when it was called.
	 */
	const shorten = async (
		fixture: TestFixture,
		account: TestAccountFixture,
		seconds: number
	): Promise<{ called_at: number; sessions: number; api_tokens: number }> => {
		const called_at = performance.now();
		const result = await rpc_call_non_browser({
			app: fixture.fresh_transport({ origin: null }),
			path: rpc_path,
			method: '_testing_shorten_credential_expiry',
			params: { account_id: account.account.id, seconds },
			headers: fixture.create_daemon_token_headers()
		});
		if (!result.ok) {
			assert.fail(`_testing_shorten_credential_expiry failed: ${JSON.stringify(result)}`);
		}
		const counts = result.result as { sessions: number; api_tokens: number };
		return { called_at, ...counts };
	};

	const cookie_of = (account: TestAccountFixture): string => {
		const { cookie } = account.create_session_headers();
		assert.ok(cookie, 'expected a session cookie');
		return cookie;
	};

	/**
	 * Assert `client` is open short of the deadline, then closes with 4001
	 * "Credential expired" at it.
	 */
	const assert_closes_at_deadline = async (client: WsClient, called_at: number): Promise<void> => {
		// open and dispatching before the deadline
		assert.deepStrictEqual(await client.request(1, heartbeat_action_spec.method, {}), {});
		assert.ok(
			await client.wait_for_close(EXPIRY_SECONDS * 1000 + CLOSE_GRACE_MS),
			'the socket did not close at its credential deadline'
		);
		const elapsed = performance.now() - called_at;
		assert.ok(
			elapsed >= EARLIEST_CLOSE_MS,
			`closed ${Math.round(elapsed)}ms in, before the deadline`
		);
		assert.strictEqual(client.close_code, WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.close_reason, WS_CLOSE_CREDENTIAL_EXPIRED_REASON);
	};

	describe('credential deadline (cross-process)', () => {
		test_if(
			capabilities.ws,
			'a session socket closes with 4001 "Credential expired" at the deadline',
			async () => {
				const fixture = await setup_test();
				const account = await fixture.create_account();
				const { called_at, sessions } = await shorten(fixture, account, EXPIRY_SECONDS);
				assert.ok(sessions >= 1, 'the seam shortened the account session');

				const client = await create_admitted_ws_transport({
					base_url,
					ws_path,
					cookies: [cookie_of(account)],
					origin: base_url
				});
				try {
					await assert_closes_at_deadline(client, called_at);
				} finally {
					await client.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'an API token socket closes with 4001 "Credential expired" at the deadline',
			async () => {
				const fixture = await setup_test();
				const account = await fixture.create_account();
				const { called_at, api_tokens } = await shorten(fixture, account, EXPIRY_SECONDS);
				assert.ok(api_tokens >= 1, 'the seam shortened the account API token');

				// a bearer outside a browser context: no Origin, no cookie
				const client = await create_admitted_ws_transport({
					base_url,
					ws_path,
					cookies: [],
					origin: null,
					headers: { Authorization: `Bearer ${account.api_token}` }
				});
				try {
					await assert_closes_at_deadline(client, called_at);
				} finally {
					await client.close();
				}
			}
		);

		test_if(capabilities.sse, 'a session audit stream ends at the deadline', async () => {
			const fixture = await setup_test();
			const account = await fixture.create_account({ roles: [ROLE_ADMIN] });
			const { called_at } = await shorten(fixture, account, EXPIRY_SECONDS);

			const sse = await create_sse_transport({
				base_url,
				sse_path,
				cookies: [cookie_of(account)],
				origin: base_url
			});
			try {
				assert.strictEqual(
					(await sse.read_frame()) + '\n\n',
					SSE_CONNECTED_COMMENT,
					'the stream opened'
				);
				assert.ok(
					await sse.wait_for_close(EXPIRY_SECONDS * 1000 + CLOSE_GRACE_MS),
					'the stream did not end at its credential deadline'
				);
				const elapsed = performance.now() - called_at;
				assert.ok(
					elapsed >= EARLIEST_CLOSE_MS,
					`ended ${Math.round(elapsed)}ms in, before the deadline`
				);
			} finally {
				await sse.close();
			}
		});

		test_if(
			capabilities.ws,
			'the expiry seam only shortens: a later expiry moves nothing',
			async () => {
				const fixture = await setup_test();
				const account = await fixture.create_account();
				const { called_at } = await shorten(fixture, account, EXPIRY_SECONDS);
				// asks for a minute; the credentials stay due at the first deadline
				await shorten(fixture, account, 60);

				const client = await create_admitted_ws_transport({
					base_url,
					ws_path,
					cookies: [cookie_of(account)],
					origin: base_url
				});
				try {
					await assert_closes_at_deadline(client, called_at);
				} finally {
					await client.close();
				}
			}
		);
	});
};
