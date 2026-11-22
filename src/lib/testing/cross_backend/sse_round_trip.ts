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
 *    broadcasting a `session_revoke_all` audit event naming the secondary as
 *    one `data:` frame to the subscribed keeper **without** closing its stream
 *    (the event targets the secondary, not the subscriber). The secondary is
 *    minted *before* the stream opens so `create_account`'s own audit events
 *    (invite / signup / login / token) don't land on it.
 * 3. **close-on-revoke, account-wide** (gated on `rpc_path`) — the subscriber's
 *    *own* sessions are revoked (`account_session_revoke_all`), which closes
 *    every stream of the account once the revoke commits (the handler's
 *    close, repeated by the audit guard on the `session_revoke_all` row).
 *    Asserted via `SseTransport.wait_for_close`.
 * 4. **close-on-revoke, session-scoped** (gated on `rpc_path`) — a second
 *    admin holds two sessions with a stream on each; the second session
 *    revokes the first (`account_session_revoke`), which closes only the
 *    stream registered under the named session's hash, while the caller's own
 *    stream stays open and still receives a broadcast — so a backend closing
 *    the whole account, or the caller's streams, on a session revoke fails it.
 * 5. **close on a role revoke** (gated on `rpc_path`) — `role_grant_revoke`
 *    of a second admin's global `admin` grant, the role the stream is gated on,
 *    closes its stream; a revoke of its global grant of a role the stream
 *    isn't gated on (`other_role`, skipped when it is `admin`) leaves the
 *    stream open and still receiving. The stream's gate is global-only
 *    (`admin` can't be scoped), so scope matching is held on the role-gated
 *    WebSocket by `describe_ws_role_gated_cross_tests`.
 * 6. **close on account delete** (gated on `rpc_path` and
 *    `capabilities.account_lifecycle`) — the keeper soft-deletes a second
 *    admin whose stream is open; the delete revokes its credentials and
 *    closes its stream.
 * 7. **close on the shared revocations** (gated on `rpc_path`; purge also
 *    on `capabilities.account_lifecycle`) — `admin_token_revoke_all`,
 *    `POST /password`, and `account_purge` of a second admin each close its
 *    stream, and its `POST /logout` closes the stream of the session it ends
 *    while a second session's stream stays open and still receives a
 *    broadcast — the rows `create_account_revocations` shares with the WS
 *    suite.
 * 8. **per-session cap** — one stream past `max_per_scope` on one session
 *    closes the oldest (evict-oldest, no final frame) and leaves every other
 *    stream open. With `rpc_path`, each stream is proven admitted as it opens
 *    and each survivor proven open after the overflow by a broadcast frame;
 *    without it, by the connect comment and a short silence.
 *
 * Cases 2–7 need `rpc_path` (each drives an RPC method); 1 and 8 run without
 * it. Every close case (3–7, and 8 when `rpc_path` is given) first proves its
 * stream **admitted**: after the connect comment, an admin writes one audit
 * row (`app_settings_update`, `open_signup` set to its reset value) and the
 * stream must deliver its frame. The comment alone proves nothing — a
 * stream closed before admission is still answered `200` with the comment and
 * then ends — so a close observed without it can't tell a working revocation
 * from a broken admission.
 *
 * The close-on-revoke matrix is layered: cases 3–7 exercise the account-wide,
 * session-scoped and role-matched paths cross-process; `token_revoke`
 * (token-scoped — the stock stream admits sessions only) has its bearer close
 * covered on the WebSocket by `describe_cross_process_ws_tests`. A close seen
 * cross-process is the union of the revoking handler's and the audit guard's
 * (`create_revocation_guard`), so a case goes red only when both miss.
 *
 * Gated on `capabilities.sse` — backends without an end-to-end SSE stream
 * skip (the cases still surface as `.skip` in the report). Cross-process
 * only: `create_sse_transport` needs a real bound socket, so wire it from a
 * `*.cross.test.ts` file, never an in-process setup.
 *
 * @module
 */

import { assert, describe } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec
} from '../../auth/account_action_specs.ts';
import {
	account_delete_action_spec,
	admin_session_revoke_all_action_spec,
	app_settings_update_action_spec
} from '../../auth/admin_action_specs.ts';
import type { AuditEventType } from '../../auth/audit_log_schema.ts';
import {
	role_grant_assign_action_spec,
	role_grant_revoke_action_spec
} from '../../auth/role_grant_offer_action_specs.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import {
	AUDIT_LOG_SSE_MAX_PER_SCOPE,
	audit_log_event_specs
} from '../../realtime/audit_log_sse.ts';
import { SSE_CONNECTED_COMMENT } from '../../realtime/sse_constants.ts';
import { create_sse_transport, type SseTransport } from '../transports/sse_transport.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { create_rpc_post_init } from '../rpc_helpers.ts';
import { DEFAULT_TEST_PASSWORD } from '../test_credentials.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import { create_account_revocations } from './revocation_drivers.ts';
import { create_active_role_grant } from './role_grant_cross_helpers.ts';
import { login_fresh_session } from './session_login.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_ACCOUNT_LOGOUT_PATH,
	SPINE_ACCOUNT_PASSWORD_PATH,
	SPINE_PARTICIPANT_ROLE,
	SPINE_SSE_PATH
} from './spine_surface_constants.ts';

/** The audit event a session revoke-all writes, what the data-frame and cap cases read. */
const SESSION_REVOKE_ALL_EVENT: AuditEventType = 'session_revoke_all';

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
	 * RPC endpoint path (e.g. `/api/rpc`). The data-frame case and every
	 * close-on-revoke case drive their revocation over it, and prove their
	 * streams admitted with an `app_settings_update` written over it; they are
	 * skipped without it. The cap case runs either way, proving its streams
	 * by broadcast frames only with it. Every use needs the standard account +
	 * admin actions mounted on the endpoint.
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
	/** REST login route path, for the session-scoped close case's second session. Default `/api/account/login`. */
	readonly login_path?: string;
	/** REST logout route path, for the logout close case. Default `/api/account/logout`. */
	readonly logout_path?: string;
	/** REST password-change route path, for its close case. Default `/api/account/password`. */
	readonly password_path?: string;
	/**
	 * A role the stream is not gated on, which the keep case assigns globally
	 * and revokes, the stream staying open — one the backend's registry holds
	 * with the `admin` grant path. Default `SPINE_PARTICIPANT_ROLE`, the
	 * spine's own; `ROLE_ADMIN`, the stream's own gate, skips that case.
	 */
	readonly other_role?: string;
}

/** A decoded audit `data:` frame: the event type as `method`, the audit row as `params`. */
interface AuditDataFrame {
	readonly method: unknown;
	readonly params: unknown;
}

/** The `data:` payload of a frame, or `null` for a comment frame. */
const parse_data_frame = (frame: string): AuditDataFrame | null => {
	const data_line = frame.split('\n').find((line) => line.startsWith('data: '));
	if (!data_line) return null;
	return JSON.parse(data_line.slice('data: '.length)) as AuditDataFrame;
};

/**
 * Assert a decoded SSE frame is a well-formed audit `{method, params}`
 * payload whose `params` validate against the matching `audit_log_event_specs`
 * entry.
 *
 * @returns the payload
 */
const assert_audit_data_frame = (frame: string): AuditDataFrame => {
	const payload = parse_data_frame(frame);
	assert.ok(payload, `SSE frame has no 'data:' line: ${JSON.stringify(frame)}`);
	assert.strictEqual(typeof payload.method, 'string', 'audit data frame method must be a string');
	const spec = audit_log_event_specs.find((s) => s.method === payload.method);
	assert.ok(spec, `no EventSpec declared for audit method '${String(payload.method)}'`);
	const result = parse(spec.params, payload.params);
	assert.ok(
		result.ok,
		`audit data frame params mismatch for '${String(payload.method)}': ${
			result.ok ? '' : JSON.stringify(result.issues)
		}`
	);
	return payload;
};

/** Read a stream's first frame and assert it is the connect comment. */
const assert_connected_comment = async (sse: SseTransport, label: string): Promise<void> => {
	const first = await sse.read_frame();
	assert.strictEqual(
		first + '\n\n',
		SSE_CONNECTED_COMMENT,
		`${label}: first frame must be the connected comment`
	);
};

/** How long a stream may take to deliver a frame a case triggered. */
const TRIGGERED_FRAME_TIMEOUT_MS = 5000;

/**
 * Read the stream until an audit frame of `method` that `match` accepts
 * arrives, skipping comment frames and other rows' frames (a login, an
 * earlier probe).
 *
 * @returns the matching frame's payload
 * @throws Error naming `label` when none arrives — the stream ended or went
 *   quiet past `TRIGGERED_FRAME_TIMEOUT_MS` — with the read's error as `cause`
 */
const read_audit_frame = async (
	sse: SseTransport,
	method: string,
	label: string,
	match: (params: Record<string, unknown>) => boolean = () => true
): Promise<AuditDataFrame> => {
	const deadline = Date.now() + TRIGGERED_FRAME_TIMEOUT_MS;
	try {
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`none within ${TRIGGERED_FRAME_TIMEOUT_MS}ms`);
			const frame = await sse.read_frame(remaining);
			if (parse_data_frame(frame)?.method !== method) continue;
			const payload = assert_audit_data_frame(frame);
			if (match(payload.params as Record<string, unknown>)) return payload;
		}
	} catch (error) {
		throw new Error(`${label}: no valid ${method} frame reached the stream`, { cause: error });
	}
};

/**
 * Write one audit row through `trigger` (an admin's transport) and read the
 * stream until a frame of its kind arrives. The row is an `app_settings_update`
 * setting `open_signup` to `false`, its value on a fresh reset, audited on
 * every spine whether or not it changes anything. It changes only the
 * settings row's `updated_at` / `updated_by` and adds an audit row — no case
 * reads either, and the per-test reset clears both.
 */
const read_probe_frame = async (
	sse: SseTransport,
	trigger: FetchTransport,
	rpc_path: string,
	label: string
): Promise<void> => {
	const res = await trigger(
		rpc_path,
		create_rpc_post_init(app_settings_update_action_spec.method, { open_signup: false })
	);
	assert.strictEqual(
		res.status,
		200,
		`${label}: app_settings_update failed (status=${res.status})`
	);
	await read_audit_frame(sse, app_settings_update_action_spec.method, label);
};

/**
 * Open an audit stream and prove the backend admitted it before a case
 * revokes anything: the connect comment, then one broadcast row's frame.
 * The comment alone proves nothing — a stream closed before admission is
 * still answered `200` with the comment and then ends — so without the frame
 * a backend whose admission is broken passes every close case.
 */
const open_admitted_stream = async (options: {
	readonly base_url: string;
	readonly sse_path: string;
	readonly origin: string | undefined;
	readonly cookies: ReadonlyArray<string>;
	readonly trigger: FetchTransport;
	readonly rpc_path: string;
	readonly label?: string;
}): Promise<SseTransport> => {
	const { base_url, sse_path, origin, cookies, trigger, rpc_path } = options;
	const label = options.label ?? 'stream';
	const sse = await create_sse_transport({ base_url, sse_path, cookies, origin });
	try {
		await assert_connected_comment(sse, label);
		await read_probe_frame(sse, trigger, rpc_path, label);
	} catch (error) {
		await sse.close();
		throw error;
	}
	return sse;
};

/**
 * Register the cross-process SSE round-trip suite. Its cases run over a
 * real streaming `fetch`: connected-comment, audit data frame, account-wide
 * close-on-revoke, session-scoped close-on-revoke, close on a revoke of the
 * gating role's global grant and not on other role revokes, close on account delete,
 * close on admin token revoke-all, logout, password change and purge, and the
 * per-session cap.
 */
export const describe_cross_process_sse_tests = (options: CrossProcessSseTestOptions): void => {
	const {
		setup_test,
		capabilities,
		base_url,
		rpc_path,
		origin,
		login_path = SPINE_ACCOUNT_LOGIN_PATH,
		logout_path = SPINE_ACCOUNT_LOGOUT_PATH,
		password_path = SPINE_ACCOUNT_PASSWORD_PATH
	} = options;
	const sse_path = options.sse_path ?? SPINE_SSE_PATH;
	const max_per_scope =
		options.max_per_scope === undefined ? AUDIT_LOG_SSE_MAX_PER_SCOPE : options.max_per_scope;
	const other_role = options.other_role ?? SPINE_PARTICIPANT_ROLE;

	/** `open_admitted_stream` on this suite's endpoint, the keeper as the probe's admin. */
	const open_admitted = (
		fixture: TestFixture,
		cookies: ReadonlyArray<string>,
		label?: string
	): Promise<SseTransport> =>
		open_admitted_stream({
			base_url,
			sse_path,
			origin,
			cookies,
			trigger: fixture.transport,
			rpc_path: rpc_path!,
			...(label !== undefined && { label })
		});

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
				await assert_connected_comment(sse, 'stream');
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
					await assert_connected_comment(sse, 'stream');
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
					// the next data frame is the row the revoke wrote, naming the secondary
					const payload = assert_audit_data_frame(await sse.read_frame());
					assert.strictEqual(payload.method, SESSION_REVOKE_ALL_EVENT);
					assert.strictEqual(
						(payload.params as { target_account_id?: unknown }).target_account_id,
						secondary.account.id
					);
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
				const sse = await open_admitted(fixture, fixture.transport.cookies());
				try {
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

		// Single `session_revoke` of one of the subscriber's sessions → the
		// session-hash-scoped close (the Rust registry's
		// `ConnectionCloseTarget::Session` close, the TS registry's
		// `close_by_identity(session_hash)`). The subscriber — a second admin, so
		// the keeper stays free to drive the probes — holds two sessions with a
		// stream on each, and the second revokes the first: the named session's
		// stream must close and the caller's own stay open and receiving, which a
		// backend closing the whole account, or the caller's streams, fails.
		test_if(
			capabilities.sse && rpc_path !== undefined,
			'stream closes on a single session_revoke of the subscriber session',
			async () => {
				const fixture = await setup_test();
				const target = await fixture.create_account({
					username: 'sse_session_revoke',
					password_value: DEFAULT_TEST_PASSWORD,
					roles: [ROLE_ADMIN]
				});
				const first_cookie = target.create_session_headers().cookie;
				assert.ok(first_cookie, 'expected a session cookie for the target account');
				// a second login, a second session of the same account on its own jar
				const second_transport = await login_fresh_session(fixture, {
					login_path,
					username: target.account.username,
					password: DEFAULT_TEST_PASSWORD,
					label: 'the second login'
				});

				const streams: Array<SseTransport> = [];
				try {
					const revoked = await open_admitted(fixture, [first_cookie], 'first session stream');
					streams.push(revoked);
					const survivor = await open_admitted(
						fixture,
						second_transport.cookies(),
						'second session stream'
					);
					streams.push(survivor);
					// the first session's id: the row its own list marks current
					const list_init = create_rpc_post_init(account_session_list_action_spec.method);
					const list_res = await fixture.fresh_transport()(rpc_path!, {
						...list_init,
						headers: target.create_session_headers(list_init.headers as Record<string, string>)
					});
					assert.strictEqual(
						list_res.status,
						200,
						`account_session_list RPC failed (status=${list_res.status})`
					);
					const list_body = (await list_res.json()) as {
						result?: { sessions?: ReadonlyArray<{ id?: unknown; is_current?: unknown }> };
					};
					const sessions = list_body.result?.sessions ?? [];
					assert.ok(sessions.length >= 2, `expected two sessions, got ${sessions.length}`);
					const current = sessions.filter((row) => row.is_current === true);
					assert.strictEqual(current.length, 1, "exactly one session is the caller's own");
					const session_id = current[0]?.id;
					assert.ok(
						typeof session_id === 'string' && session_id.length > 0,
						'expected the first session id (blake3 hash) to revoke'
					);
					// revoked by the second session, so the stream that must close is
					// not the caller's
					const revoke_res = await second_transport(
						rpc_path!,
						create_rpc_post_init(account_session_revoke_action_spec.method, { session_id })
					);
					assert.strictEqual(
						revoke_res.status,
						200,
						`account_session_revoke RPC failed (status=${revoke_res.status})`
					);
					const closed = await revoked.wait_for_close(2000);
					assert.ok(
						closed,
						'the named session stream did not close within 2s after session_revoke'
					);
					// the caller's own stream is still open and still broadcast to
					await read_probe_frame(survivor, fixture.transport, rpc_path!, 'second session stream');
				} finally {
					await Promise.all(streams.map((sse) => sse.close()));
				}
			}
		);

		// The stream is gated on `ROLE_ADMIN` and never rechecks it, so revoking a
		// subscriber's global admin grant must close it — the role-matched close
		// (`{kind: 'role'}`), which reaches only a stream whose gate is the role.
		// The keeper's own admin grant can't be revoked, so the subscriber is a
		// second admin, its grant the one `create_account` gave it.
		test_if(
			capabilities.sse && rpc_path !== undefined,
			'stream closes when a global grant of its gating role is revoked',
			async () => {
				const fixture = await setup_test();
				const target = await fixture.create_account({
					username: 'sse_role_revoke',
					roles: [ROLE_ADMIN]
				});
				// idempotent on the admin grant the account already holds
				const role_grant_id = await create_active_role_grant(fixture, target, { rpc_path });
				const cookie = target.create_session_headers().cookie;
				assert.ok(cookie, 'expected a session cookie for the target account');
				const sse = await open_admitted(fixture, [cookie]);
				try {
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(role_grant_revoke_action_spec.method, {
							actor_id: target.actor.id,
							role_grant_id
						})
					);
					assert.strictEqual(
						res.status,
						200,
						`role_grant_revoke RPC failed (status=${res.status})`
					);
					const closed = await sse.wait_for_close(2000);
					assert.ok(closed, 'stream did not close within 2s after role_grant_revoke');
				} finally {
					await sse.close();
				}
			}
		);

		// Only a grant of the gating role reaches the stream: a global revoke of
		// a role the stream isn't gated on closes nothing, and the stream stays
		// open and still receives a broadcast. Scope matching can't be held here
		// (`admin` is global-only); `describe_ws_role_gated_cross_tests` holds it.
		test_if(
			capabilities.sse && rpc_path !== undefined && other_role !== ROLE_ADMIN,
			'a revoke of a global grant of another role leaves the stream open',
			async () => {
				const fixture = await setup_test();
				const target = await fixture.create_account({
					username: 'sse_role_keep',
					roles: [ROLE_ADMIN]
				});
				const assigned = await fixture.transport(
					rpc_path!,
					create_rpc_post_init(role_grant_assign_action_spec.method, {
						to_account_id: target.account.id,
						role: other_role
					})
				);
				const body = (await assigned.json()) as { result?: { role_grant_id?: unknown } };
				assert.strictEqual(
					assigned.status,
					200,
					`role_grant_assign failed: ${JSON.stringify(body)}`
				);
				const role_grant_id = body.result?.role_grant_id;
				assert.ok(typeof role_grant_id === 'string', JSON.stringify(body));
				const cookie = target.create_session_headers().cookie;
				assert.ok(cookie, 'expected a session cookie for the target account');
				const sse = await open_admitted(fixture, [cookie]);
				try {
					const res = await fixture.transport(
						rpc_path!,
						create_rpc_post_init(role_grant_revoke_action_spec.method, {
							actor_id: target.actor.id,
							role_grant_id
						})
					);
					assert.strictEqual(
						res.status,
						200,
						`role_grant_revoke of ${other_role} failed (status=${res.status})`
					);
					// still open, and still broadcast to
					await read_probe_frame(sse, fixture.transport, rpc_path!, 'the kept stream');
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
				const sse = await open_admitted(fixture, [cookie]);
				try {
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

		// The revocations of `revocation_drivers.ts`, shared with the WS suite,
		// each close the target admin's stream on the session they were sent on.
		// A session-scoped one (logout) leaves a second session's stream open and
		// receiving, so a backend closing the whole account on it fails. Without
		// `rpc_path` the rows still register, as skipped cases, and never run —
		// so the empty path is never sent.
		const revocations = create_account_revocations({
			capabilities,
			rpc_path: rpc_path ?? '',
			logout_path,
			password_path
		});
		for (const { label, slug, gate, closes, revoke } of revocations) {
			test_if(
				capabilities.sse && gate && rpc_path !== undefined,
				closes === 'session'
					? `stream closes on ${label} of its session, and the account's other session's stays`
					: `stream closes on ${label} of the subscriber account`,
				async () => {
					const fixture = await setup_test();
					const target = await fixture.create_account({
						username: `sse_revoke_${slug}`,
						password_value: DEFAULT_TEST_PASSWORD,
						roles: [ROLE_ADMIN]
					});
					const cookie = target.create_session_headers().cookie;
					assert.ok(cookie, 'expected a session cookie for the target account');
					const streams: Array<SseTransport> = [];
					try {
						const sse = await open_admitted(fixture, [cookie]);
						streams.push(sse);
						let survivor: SseTransport | null = null;
						if (closes === 'session') {
							// a second login, a second session of the same account on its own jar
							const second_transport = await login_fresh_session(fixture, {
								login_path,
								username: target.account.username,
								password: DEFAULT_TEST_PASSWORD,
								label: 'the second login'
							});
							survivor = await open_admitted(
								fixture,
								second_transport.cookies(),
								'second session stream'
							);
							streams.push(survivor);
						}
						await revoke(fixture, target);
						const closed = await sse.wait_for_close(2000);
						assert.ok(closed, `stream did not close within 2s after ${label}`);
						if (survivor !== null) {
							// still open, and still broadcast to
							await read_probe_frame(
								survivor,
								fixture.transport,
								rpc_path!,
								'second session stream'
							);
						}
					} finally {
						await Promise.all(streams.map((stream) => stream.close()));
					}
				}
			);
		}

		// One stream past the cap on one session → the oldest closes, the newest
		// stays open. Opened in sequence, each admitted before the next opens (a
		// broadcast row's frame read on it, given `rpc_path`; else its connect
		// comment), so the server registered them in order and "oldest" is
		// stream 0 on both spines. Given `rpc_path`, every survivor then reads
		// the frame of a row written after the overflow — a `session_revoke_all`
		// naming an account minted for it, a kind no admission probe writes, so
		// a frame buffered before the overflow can't stand in; without it, a
		// short silence is the only check. The evicted stream ends with no final
		// frame, so a browser `EventSource` would reconnect — this asserts the
		// server side only.
		test_if(
			capabilities.sse && max_per_scope !== null,
			'one stream past the per-session cap closes the oldest',
			async () => {
				const fixture = await setup_test();
				// minted before any stream opens, so its own audit rows land on none
				const marker =
					rpc_path === undefined
						? null
						: await fixture.create_account({ username: 'sse_cap_marker', roles: [] });
				const cookies = fixture.transport.cookies();
				const streams: Array<SseTransport> = [];
				try {
					for (let i = 0; i <= max_per_scope!; i++) {
						if (rpc_path !== undefined) {
							streams.push(await open_admitted(fixture, cookies, `stream ${i}`));
							continue;
						}
						const sse = await create_sse_transport({ base_url, sse_path, cookies, origin });
						streams.push(sse);
						await assert_connected_comment(sse, `stream ${i}`);
					}
					const [oldest, ...survivors] = streams;
					const closed = await oldest!.wait_for_close(2000);
					assert.ok(closed, 'the oldest stream did not close within 2s of the cap overflow');
					// only the oldest — every later stream on the session stays open
					if (marker !== null) {
						const res = await fixture.transport(
							rpc_path!,
							create_rpc_post_init(admin_session_revoke_all_action_spec.method, {
								account_id: marker.account.id
							})
						);
						assert.strictEqual(
							res.status,
							200,
							`admin_session_revoke_all RPC failed (status=${res.status})`
						);
						await Promise.all(
							survivors.map((sse, i) =>
								read_audit_frame(
									sse,
									SESSION_REVOKE_ALL_EVENT,
									`stream ${i + 1} (only the oldest may close)`,
									(params) => params.target_account_id === marker.account.id
								)
							)
						);
					} else {
						const survivors_closed = await Promise.all(
							survivors.map((sse) => sse.wait_for_close(200))
						);
						assert.deepStrictEqual(
							survivors_closed,
							survivors.map(() => false),
							'only the oldest stream may close; the rest of the session stays open'
						);
					}
				} finally {
					await Promise.all(streams.map((sse) => sse.close()));
				}
			}
		);
	});
};
