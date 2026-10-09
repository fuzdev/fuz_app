import '../assert_dev_env.ts';

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
 * Its cases follow the in-process SSE self-test against fuz_app's
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
 *    *own* sessions are revoked (`account_session_revoke_all`), which closes
 *    every stream of the account once the revoke commits (the handler's
 *    close, repeated by the audit guard on the `session_revoke_all` row).
 *    Asserted via `SseTransport.wait_for_close`.
 * 4. **close-on-revoke, session-scoped** (gated on `rpc_path`) — the
 *    subscriber's *own* single session is revoked (`account_session_revoke`),
 *    which closes only the stream registered under that session's hash (the
 *    distinct close cases 2–3 don't reach).
 * 5. **close on account delete** (gated on `rpc_path` and
 *    `capabilities.account_lifecycle`) — the keeper soft-deletes a second
 *    admin whose stream is open; the delete revokes its credentials and
 *    closes its stream.
 * 6. **per-session cap** — one stream past `max_per_scope` on one session
 *    closes the oldest (evict-oldest, no final frame) and leaves every other
 *    stream open. Needs no RPC: the cap runs inside the subscribe itself.
 *
 * The close-on-revoke matrix is layered: cases 3–5 exercise the account-wide
 * and session-scoped paths cross-process; the remaining revocation events
 * (`token_revoke_all` / `logout` / `password_change` / `account_purge`, all
 * account-wide; `token_revoke`, token-scoped; and `role_grant_revoke`,
 * role-matched) are covered by the spine's `fuz_realtime` SSE-registry unit
 * tests and the in-process guard self-test, so a cross-process
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

import { assert, describe } from 'vitest';

import {
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec
} from '../../auth/account_action_specs.ts';
import {
	account_delete_action_spec,
	admin_session_revoke_all_action_spec
} from '../../auth/admin_action_specs.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import {
	AUDIT_LOG_SSE_MAX_PER_SCOPE,
	audit_log_event_specs
} from '../../realtime/sse_auth_guard.ts';
import { SSE_CONNECTED_COMMENT } from '../../realtime/sse_constants.ts';
import { create_sse_transport, type SseTransport } from '../transports/sse_transport.ts';
import { create_rpc_post_init } from '../rpc_helpers.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest } from './setup.ts';

/** Default audit-log SSE stream path — the standard fuz_app `/api/admin/audit/stream`. */
const DEFAULT_SSE_PATH = '/api/admin/audit/stream';

/** Configuration for `describe_cross_process_sse_tests`. */
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
	/**
	 * The backend's per-session audit-stream cap, which the cap case opens one
	 * stream past. Defaults to `AUDIT_LOG_SSE_MAX_PER_SCOPE`, the cap both
	 * spines apply unless overridden; `null` (a backend with the cap disabled)
	 * skips the case.
	 */
	readonly max_per_scope?: number | null;
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
		}`
	);
};

/**
 * Register the cross-process SSE round-trip suite. Its cases run over a
 * real streaming `fetch`: connected-comment, audit data frame, account-wide
 * close-on-revoke, session-scoped close-on-revoke, close on account delete,
 * and the per-session cap.
 */
export const describe_cross_process_sse_tests = (options: CrossProcessSseTestOptions): void => {
	const { setup_test, capabilities, base_url, rpc_path, origin } = options;
	const sse_path = options.sse_path ?? DEFAULT_SSE_PATH;
	const max_per_scope =
		options.max_per_scope === undefined ? AUDIT_LOG_SSE_MAX_PER_SCOPE : options.max_per_scope;

	describe('cross-process sse', () => {
		test_if(capabilities.sse, 'connects and emits the connected comment', async () => {
			const fixture = await setup_test();
			const sse = await create_sse_transport({
				base_url,
				sse_path,
				cookies: fixture.transport.cookies(),
				origin
			});
			try {
				const first = await sse.read_frame();
				assert.strictEqual(
					first + '\n\n',
					SSE_CONNECTED_COMMENT,
					'first frame must be the connected comment'
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
				const secondary = await fixture.create_account({
					username: 'sse_revoke_target',
					roles: []
				});
				const sse = await create_sse_transport({
					base_url,
					sse_path,
					cookies: fixture.transport.cookies(),
					origin
				});
				try {
					const first = await sse.read_frame();
					assert.strictEqual(
						first + '\n\n',
						SSE_CONNECTED_COMMENT,
						'first frame must be the connected comment'
					);
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(admin_session_revoke_all_action_spec.method, {
							account_id: secondary.account.id
						})
					);
					assert.strictEqual(
						res.status,
						200,
						`admin_session_revoke_all RPC failed (status=${res.status})`
					);
					const data_frame = await sse.read_frame();
					assert_audit_data_frame(data_frame);
				} finally {
					await sse.close();
				}
			}
		);

		// Revoke the subscriber's OWN sessions → the handler closes the keeper's
		// streams once the revoke commits (the audit guard repeats the close on
		// the `session_revoke_all` row).
		test_if(
			capabilities.sse && rpc_path !== undefined,
			'stream closes when the subscriber sessions are revoked',
			async () => {
				const fixture = await setup_test();
				const sse = await create_sse_transport({
					base_url,
					sse_path,
					cookies: fixture.transport.cookies(),
					origin
				});
				try {
					const first = await sse.read_frame();
					assert.strictEqual(
						first + '\n\n',
						SSE_CONNECTED_COMMENT,
						'first frame must be the connected comment'
					);
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_revoke_all_action_spec.method)
					);
					assert.strictEqual(
						res.status,
						200,
						`account_session_revoke_all RPC failed (status=${res.status})`
					);
					const closed = await sse.wait_for_close(2000);
					assert.ok(closed, 'stream did not close within 2s after session_revoke_all');
				} finally {
					await sse.close();
				}
			}
		);

		// Single `session_revoke` of the subscriber's OWN session → the
		// session-hash-scoped close (the Rust registry's `close_for_session`, the
		// TS registry's `close_by_identity(session_hash)`). The keeper holds
		// exactly one session, so revoking it by its blake3 hash drops the stream
		// opened under it. This is the close-on-revoke path the account-wide case
		// above doesn't exercise; the remaining account-wide events
		// (`token_revoke_all` / `logout` / `password_change` / `account_purge`)
		// share the close the `session_revoke_all` and account-delete cases cover,
		// and `token_revoke`'s token-scoped and `role_grant_revoke`'s role-matched
		// closes are covered by `fuz_realtime`'s SSE registry unit tests.
		test_if(
			capabilities.sse && rpc_path !== undefined,
			'stream closes on a single session_revoke of the subscriber session',
			async () => {
				const fixture = await setup_test();
				const sse = await create_sse_transport({
					base_url,
					sse_path,
					cookies: fixture.transport.cookies(),
					origin
				});
				try {
					const first = await sse.read_frame();
					assert.strictEqual(
						first + '\n\n',
						SSE_CONNECTED_COMMENT,
						'first frame must be the connected comment'
					);
					const list_res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_list_action_spec.method)
					);
					assert.strictEqual(
						list_res.status,
						200,
						`account_session_list RPC failed (status=${list_res.status})`
					);
					const list_body = (await list_res.json()) as {
						result?: { sessions?: ReadonlyArray<{ id?: unknown }> };
					};
					const session_id = list_body.result?.sessions?.[0]?.id;
					assert.ok(
						typeof session_id === 'string' && session_id.length > 0,
						'expected the subscriber session id (blake3 hash) to revoke'
					);
					const revoke_res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_session_revoke_action_spec.method, { session_id })
					);
					assert.strictEqual(
						revoke_res.status,
						200,
						`account_session_revoke RPC failed (status=${revoke_res.status})`
					);
					const closed = await sse.wait_for_close(2000);
					assert.ok(closed, 'stream did not close within 2s after session_revoke');
				} finally {
					await sse.close();
				}
			}
		);

		// A soft-deleted account's credentials stop authenticating, and a stream
		// never rechecks its own — so the delete must close it. The keeper
		// deletes a second admin whose stream is open; the keeper's own admin
		// grant keeps the delete clear of the last-admin guard.
		test_if(
			capabilities.sse && capabilities.account_lifecycle && rpc_path !== undefined,
			'stream closes when the subscriber account is deleted',
			async () => {
				const fixture = await setup_test();
				const target = await fixture.create_account({
					username: 'sse_delete_target',
					roles: [ROLE_ADMIN]
				});
				const cookie = target.create_session_headers().cookie;
				assert.ok(cookie, 'expected a session cookie for the target account');
				const sse = await create_sse_transport({ base_url, sse_path, cookies: [cookie], origin });
				try {
					const first = await sse.read_frame();
					assert.strictEqual(
						first + '\n\n',
						SSE_CONNECTED_COMMENT,
						'first frame must be the connected comment'
					);
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(account_delete_action_spec.method, {
							account_id: target.account.id
						})
					);
					assert.strictEqual(res.status, 200, `account_delete RPC failed (status=${res.status})`);
					const closed = await sse.wait_for_close(2000);
					assert.ok(closed, 'stream did not close within 2s after account_delete');
				} finally {
					await sse.close();
				}
			}
		);

		// One stream past the cap on one session → the oldest closes, the newest
		// stays open. Opened in sequence, each awaited to its connect comment, so
		// the server registered them in order and "oldest" is stream 0 on both
		// spines. The evicted stream ends with no final frame, so a browser
		// `EventSource` would reconnect — this asserts the server side only.
		test_if(
			capabilities.sse && max_per_scope !== null,
			'one stream past the per-session cap closes the oldest',
			async () => {
				const fixture = await setup_test();
				const cookies = fixture.transport.cookies();
				const streams: Array<SseTransport> = [];
				try {
					for (let i = 0; i <= max_per_scope!; i++) {
						const sse = await create_sse_transport({ base_url, sse_path, cookies, origin });
						streams.push(sse);
						const first = await sse.read_frame();
						assert.strictEqual(
							first + '\n\n',
							SSE_CONNECTED_COMMENT,
							`stream ${i}: first frame must be the connected comment`
						);
					}
					const [oldest, ...survivors] = streams;
					const closed = await oldest!.wait_for_close(2000);
					assert.ok(closed, 'the oldest stream did not close within 2s of the cap overflow');
					// only the oldest — every later stream on the session stays open
					const survivors_closed = await Promise.all(
						survivors.map((sse) => sse.wait_for_close(200))
					);
					assert.deepStrictEqual(
						survivors_closed,
						survivors.map(() => false),
						'only the oldest stream may close; the rest of the session stays open'
					);
				} finally {
					await Promise.all(streams.map((sse) => sse.close()));
				}
			}
		);
	});
};
