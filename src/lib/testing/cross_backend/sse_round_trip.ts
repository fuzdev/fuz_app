import '../assert_dev_env.js';

/**
 * Cross-process SSE round-trip suite — the cross-process counterpart to the
 * in-process `testing/sse_round_trip.ts` harness.
 *
 * Where the in-process harness reads a Hono `Response.body` directly, this
 * suite opens a **real** streaming `fetch` against a spawned backend's
 * audit-log SSE endpoint via `create_sse_transport`, threading the
 * fresh-per-test keeper's session cookie. It is the only coverage of the
 * spawned binary's live SSE path — the standard cross-process bundle
 * (`describe_standard_cross_process_tests`) omits SSE by design, so consumers
 * call this alongside it (paralleling `describe_cross_process_ws_tests`).
 *
 * Four cases, mirroring the in-process SSE self-test against fuz_app's
 * standard audit-log stream:
 *
 * 1. **connects** — the stream opens and emits the `: connected` comment.
 * 2. **data frame** (gated on `rpc_path`) — a minted secondary's sessions are
 *    revoked over the keeper's admin channel (`admin_session_revoke_all`),
 *    broadcasting a `session_revoke_all` audit event as one `data:` frame to
 *    the subscribed keeper **without** closing its stream (the event targets
 *    the secondary, not the subscriber). The secondary is minted *before* the
 *    stream opens so `create_account`'s own audit events (invite / signup /
 *    login / token) don't land on it.
 * 3. **close-on-revoke, account-wide** (gated on `rpc_path`) — the subscriber's
 *    *own* sessions are revoked (`account_session_revoke_all`), so the
 *    `session_revoke_all` event targets the keeper and the audit guard drops
 *    the live stream via the account-wide `close_for_account` path. Asserted
 *    via `SseTransport.wait_for_close`.
 * 4. **close-on-revoke, session-scoped** (gated on `rpc_path`) — the
 *    subscriber's *own* single session is revoked (`account_session_revoke`),
 *    so the `session_revoke` event drops the stream via the session-hash-scoped
 *    `close_for_session` path (the distinct primitive cases 2–3 don't reach).
 *
 * The close-on-revoke matrix is layered: cases 3–4 exercise the account-wide
 * and session-scoped paths cross-process; the remaining union events
 * (`token_revoke_all` / `logout` / `password_change`, all account-wide; and
 * `role_grant_revoke`, role-matched) are covered by the spine's `fuz_realtime`
 * SSE-registry unit tests and the in-process guard self-test, so a cross-process
 * `token_revoke_all`-with-zero-tokens case (which may emit no audit row) stays
 * out to keep the spawned-backend suite non-flaky.
 *
 * Gated on `capabilities.sse` — backends without an end-to-end SSE stream
 * skip (the cases still surface as `.skip` in the report). Cross-process
 * only: `create_sse_transport` needs a real bound socket, so wire it from a
 * `*.cross.test.ts` file, never an in-process setup.
 *
 * @module
 */

import {assert, describe} from 'vitest';

import {
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
} from '../../auth/account_action_specs.js';
import {admin_session_revoke_all_action_spec} from '../../auth/admin_action_specs.js';
import {audit_log_event_specs} from '../../realtime/sse_auth_guard.js';
import {SSE_CONNECTED_COMMENT} from '../../realtime/sse_constants.js';
import {create_sse_transport} from '../transports/sse_transport.js';
import {create_rpc_post_init} from '../rpc_helpers.js';
import {type BackendCapabilities, test_if} from './capabilities.js';
import type {SetupTest} from './setup.js';

/** Default audit-log SSE stream path — the standard fuz_app `/api/admin/audit/stream`. */
const DEFAULT_SSE_PATH = '/api/admin/audit/stream';

/** Configuration for {@link describe_cross_process_sse_tests}. */
export interface CrossProcessSseTestOptions {
	/**
	 * Per-test fixture producer (`default_cross_process_setup(handle)`). Each
	 * case reads the fresh-per-test keeper's session cookies from
	 * `fixture.transport.cookies()` to thread onto the stream. The keeper
	 * holds `ROLE_ADMIN` by default, so it can subscribe to the admin-gated
	 * audit stream and drive `admin_session_revoke_all`.
	 */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `capabilities.sse`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** SSE stream path on the backend. Defaults to `/api/admin/audit/stream`. */
	readonly sse_path?: string;
	/**
	 * RPC endpoint path (e.g. `/api/rpc`) used by the data-frame and
	 * close-on-revoke cases to fire `admin_session_revoke_all` /
	 * `account_session_revoke_all` over the keeper's session channel. When
	 * omitted, those cases are skipped — they depend on the standard account
	 * + admin actions being mounted on the RPC endpoint.
	 */
	readonly rpc_path?: string;
	/** Origin for the stream request. Defaults to `base_url`. */
	readonly origin?: string;
}

/**
 * Assert a decoded SSE frame is a well-formed audit `{method, params}`
 * payload whose `params` validate against the matching `audit_log_event_specs`
 * entry.
 */
const assert_audit_data_frame = (frame: string): void => {
	const data_line = frame.split('\n').find((line) => line.startsWith('data: '));
	assert.ok(data_line, `SSE frame has no 'data:' line: ${JSON.stringify(frame)}`);
	const payload = JSON.parse(data_line.slice('data: '.length)) as {
		method?: unknown;
		params?: unknown;
	};
	assert.strictEqual(typeof payload.method, 'string', 'audit data frame method must be a string');
	const spec = audit_log_event_specs.find((s) => s.method === payload.method);
	assert.ok(spec, `no EventSpec declared for audit method '${String(payload.method)}'`);
	const result = spec.params.safeParse(payload.params);
	assert.ok(
		result.success,
		`audit data frame params mismatch for '${String(payload.method)}': ${
			result.success ? '' : JSON.stringify(result.error.issues)
		}`,
	);
};

/**
 * Register the cross-process SSE round-trip suite. Up to four cases over a
 * real streaming `fetch`: connected-comment, audit data frame, account-wide
 * close-on-revoke, and session-scoped close-on-revoke.
 */
export const describe_cross_process_sse_tests = (options: CrossProcessSseTestOptions): void => {
	const {setup_test, capabilities, base_url, rpc_path, origin} = options;
	const sse_path = options.sse_path ?? DEFAULT_SSE_PATH;

	describe('cross-process sse', () => {
		test_if(capabilities.sse, 'connects and emits the connected comment', async () => {
			const fixture = await setup_test();
			const sse = await create_sse_transport({
				base_url,
				sse_path,
				cookies: fixture.transport.cookies(),
				origin,
			});
			try {
				const first = await sse.read_frame();
				assert.strictEqual(
					first + '\n\n',
					SSE_CONNECTED_COMMENT,
					'first frame must be the connected comment',
				);
			} finally {
				await sse.close();
			}
		});

		// Mint the secondary BEFORE opening the stream so `create_account`'s own
		// audit events stay off it; then revoke the secondary's sessions over the
		// keeper's admin channel → one `session_revoke_all` data frame reaches the
		// keeper (target ≠ subscriber, so the stream stays open).
		test_if(
			capabilities.sse && rpc_path !== undefined,
			'broadcasts an audit event as a data frame',
			async () => {
				const fixture = await setup_test();
				const secondary = await fixture.create_account({username: 'sse_revoke_target', roles: []});
				const sse = await create_sse_transport({
					base_url,
					sse_path,
					cookies: fixture.transport.cookies(),
					origin,
				});
				try {
					const first = await sse.read_frame();
					assert.strictEqual(
						first + '\n\n',
						SSE_CONNECTED_COMMENT,
						'first frame must be the connected comment',
					);
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(admin_session_revoke_all_action_spec.method, {
							account_id: secondary.account.id,
						}),
					);
					assert.strictEqual(
						res.status,
						200,
						`admin_session_revoke_all RPC failed (status=${res.status})`,
					);
					const data_frame = await sse.read_frame();
					assert_audit_data_frame(data_frame);
				} finally {
					await sse.close();
				}
			},
		);

		// Revoke the subscriber's OWN sessions → `session_revoke_all` targets the
		// keeper, so the audit guard closes the live stream.
		test_if(
			capabilities.sse && rpc_path !== undefined,
			'stream closes when the subscriber sessions are revoked',
			async () => {
				const fixture = await setup_test();
				const sse = await create_sse_transport({
					base_url,
					sse_path,
					cookies: fixture.transport.cookies(),
					origin,
				});
				try {
					const first = await sse.read_frame();
					assert.strictEqual(
						first + '\n\n',
						SSE_CONNECTED_COMMENT,
						'first frame must be the connected comment',
					);
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_revoke_all_action_spec.method),
					);
					assert.strictEqual(
						res.status,
						200,
						`account_session_revoke_all RPC failed (status=${res.status})`,
					);
					const closed = await sse.wait_for_close(2000);
					assert.ok(closed, 'stream did not close within 2s after session_revoke_all');
				} finally {
					await sse.close();
				}
			},
		);

		// Single `session_revoke` of the subscriber's OWN session → the
		// session-hash-scoped close path (`close_for_session` / the TS guard's
		// `close_by_identity(session_id)`). The keeper holds exactly one session,
		// so revoking it by its blake3 hash drops the stream opened under it.
		// This is the close-on-revoke path the account-wide cases above don't
		// exercise; the remaining union events (`token_revoke_all` / `logout` /
		// `password_change`) share the account-wide `close_for_account` path the
		// `session_revoke_all` case already covers, and `role_grant_revoke`'s
		// role-matched path is covered by `fuz_realtime`'s SSE registry unit tests.
		test_if(
			capabilities.sse && rpc_path !== undefined,
			'stream closes on a single session_revoke of the subscriber session',
			async () => {
				const fixture = await setup_test();
				const sse = await create_sse_transport({
					base_url,
					sse_path,
					cookies: fixture.transport.cookies(),
					origin,
				});
				try {
					const first = await sse.read_frame();
					assert.strictEqual(
						first + '\n\n',
						SSE_CONNECTED_COMMENT,
						'first frame must be the connected comment',
					);
					const list_res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_list_action_spec.method),
					);
					assert.strictEqual(
						list_res.status,
						200,
						`account_session_list RPC failed (status=${list_res.status})`,
					);
					const list_body = (await list_res.json()) as {
						result?: {sessions?: ReadonlyArray<{id?: unknown}>};
					};
					const session_id = list_body.result?.sessions?.[0]?.id;
					assert.ok(
						typeof session_id === 'string' && session_id.length > 0,
						'expected the subscriber session id (blake3 hash) to revoke',
					);
					const revoke_res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_revoke_action_spec.method, {session_id}),
					);
					assert.strictEqual(
						revoke_res.status,
						200,
						`account_session_revoke RPC failed (status=${revoke_res.status})`,
					);
					const closed = await sse.wait_for_close(2000);
					assert.ok(closed, 'stream did not close within 2s after session_revoke');
				} finally {
					await sse.close();
				}
			},
		);
	});
};
