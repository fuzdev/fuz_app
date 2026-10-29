import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **per-account concurrent-session cap**
 * over real HTTP.
 *
 * Both spines cap concurrent sessions per account (the TS
 * `query_session_enforce_limit` / `DEFAULT_MAX_SESSIONS`, the Rust
 * `create_capped_session`). Each spine's own tests pin its half in-process;
 * nothing in them crosses the wire, so a spine that lost the cap would fail
 * no shared test. This suite is the pin that runs on *both*. It pins:
 *
 * - **the cap bounds concurrent sessions, by eviction not refusal** — logging in
 *   `max_sessions + 1` times succeeds every time (a login is never denied for
 *   being the one over the line), and the newest cookie resolves afterward.
 * - **the evicted session is the oldest** — the first login's cookie no longer
 *   authenticates once the cap is exceeded. A spine with no cap authenticates it
 *   fine, which is exactly the defect this catches.
 * - **the session list marks the caller's own session `is_current`** — each
 *   login's `account_session_list` marks exactly one row, its own, over HTTP
 *   and (when `ws` mounts the account actions) over a socket the login
 *   opened, and a bearer or daemon-token caller's list marks none (no session
 *   authenticated it), even when a session cookie rides beside the daemon
 *   token. Computed per request, so two logins see different current rows.
 * - **an evicted session's socket is closed** (when `ws` is supplied) — the cap
 *   deletes the session row, and a WebSocket never re-reads its session, so
 *   the login that evicts it must close the socket it opened
 *   (`WS_CLOSE_SESSION_REVOKED`), once the eviction has committed. A spine
 *   that only deletes the row leaves the socket running on a dead session.
 *
 * **Why `max_sessions + 1` logins and not `max_sessions`.** The starting session
 * count isn't zero and isn't guaranteed equal across impls — `create_account`
 * seeds its own session on the Rust cradle. Overshooting by one guarantees at
 * least one eviction whatever the baseline is, and the *oldest* login is the
 * first to go either way. Asserting on the first and last sessions rather than
 * on a row count keeps the case wire-observable (no DB channel) and
 * baseline-independent.
 *
 * Both surfaces are flat REST (`POST /api/account/login`, `GET /api/account/status`)
 * on every spine, so this is an imperative suite (not a `conformance_table` row)
 * — the sibling of `cookie_attributes.ts` / `origin.ts` / `login_security.ts`.
 * **Cross-process only**, and load-bearingly so: each login is held on its own
 * `fresh_transport` and identified by that transport's cookie jar, which
 * in-process is a jar-less passthrough. That also keeps the suite free of a
 * fourth `Set-Cookie` parser — reading the raw header is `cookie_attributes.ts`'s
 * job, and this case only needs "does this login still authenticate".
 *
 * What it does **not** pin: concurrent creators. Two simultaneous logins can
 * each evict against a stale count under Read Committed and both commit above
 * the cap — see `query_session_enforce_limit`'s race note. That needs a
 * barrier-based test against one backend, not a parity case.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { heartbeat_action_spec } from '../../actions/heartbeat.ts';
import { WS_CLOSE_SESSION_REVOKED } from '../../actions/transports.ts';
import { DEFAULT_MAX_SESSIONS } from '../../auth/account_route_schema.ts';
import { SessionListOutput } from '../../auth/account_action_specs.ts';
import { DEFAULT_TEST_PASSWORD } from '../test_credentials.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { create_ws_transport } from '../transports/ws_transport.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, expect_output } from './cross_rpc.ts';
import type { SetupTest } from './setup.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_ACCOUNT_STATUS_PATH,
	SPINE_RPC_PATH
} from './spine_surface_constants.ts';
import type { WsEndpointTarget } from './ws_endpoint.ts';

/** Options for the session-cap parity suite. */
export interface SessionCapCrossTestOptions {
	/** Per-test fixture producer (cross-process only — see the module doc). */
	readonly setup_test: SetupTest;
	/**
	 * The cap both spines enforce. Defaults to `DEFAULT_MAX_SESSIONS` — the TS
	 * route default and the Rust `const`. A consumer that overrides
	 * `max_sessions` on the TS side passes its value here.
	 */
	readonly max_sessions?: number;
	/** REST login route path. Default `/api/account/login`. */
	readonly login_path?: string;
	/** REST account-status route path. Default `/api/account/status`. */
	readonly status_path?: string;
	/** JSON-RPC endpoint path, for the session-list case. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
	/**
	 * Where the backend's WebSocket endpoint is, for the case that an evicted
	 * session's socket is closed. Pass it when the backend has a WS transport
	 * (`capabilities.ws`); omitted, that case is skipped.
	 */
	readonly ws?: WsEndpointTarget;
	/**
	 * Whether the `ws` endpoint mounts the self-service account actions
	 * (`capabilities.ws_account_actions`), so the session-list case also lists
	 * over a socket. Default `false`.
	 */
	readonly ws_account_actions?: boolean;
	/**
	 * The roles the account whose socket the `ws` case watches is created with, for a
	 * backend whose WS upgrade requires a role (an admin-gated `/api/ws`
	 * refuses a roleless account's upgrade). Each must be admin-grantable — the
	 * fixture offers it. Default none.
	 */
	readonly ws_account_roles?: ReadonlyArray<string>;
}

export const describe_session_cap_cross_tests = (options: SessionCapCrossTestOptions): void => {
	const { setup_test, ws, ws_account_actions = false, ws_account_roles = [] } = options;
	const max_sessions = options.max_sessions ?? DEFAULT_MAX_SESSIONS;
	const login_path = options.login_path ?? SPINE_ACCOUNT_LOGIN_PATH;
	const status_path = options.status_path ?? SPINE_ACCOUNT_STATUS_PATH;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	// Fresh-keeper-per-test wipes the DB between tests, so a literal username
	// never collides (see `setup.ts`).
	const username = 'session_cap_user';

	/** Log `username` in on a fresh transport — one login, one session, one jar. */
	const login = async (
		fixture: Awaited<ReturnType<SetupTest>>,
		label: string
	): Promise<FetchTransport> => {
		const transport = fixture.fresh_transport();
		const res = await transport(login_path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username, password: DEFAULT_TEST_PASSWORD })
		});
		assert.strictEqual(res.status, 200, `${label} must succeed — the cap evicts, it never refuses`);
		assert.ok(transport.cookies().length > 0, `${label} must set a session cookie on its jar`);
		return transport;
	};

	describe('per-account session cap parity', () => {
		test(`logging in ${
			max_sessions + 1
		} times evicts the oldest session (newest cookie resolves, first does not)`, async () => {
			const fixture = await setup_test();
			await fixture.create_account({ username, password_value: DEFAULT_TEST_PASSWORD });

			// One transport per login, each with its own empty jar, so each ends up
			// holding exactly that login's session cookie and re-sends it on any
			// later request. That's why this suite is cross-process only: in-process
			// `fresh_transport` is a jar-less passthrough and every session would
			// look alike. Held oldest-first.
			const sessions: Array<FetchTransport> = [];
			for (let i = 0; i < max_sessions + 1; i++) {
				sessions.push(await login(fixture, `login ${i + 1}/${max_sessions + 1}`));
			}

			/** `GET /status` on one login's transport: 200 authenticated, 401 not. */
			const status_on = async (transport: FetchTransport): Promise<number> => {
				const res = await transport(status_path, { method: 'GET' });
				await res.text();
				return res.status;
			};

			assert.strictEqual(
				await status_on(sessions[sessions.length - 1]!),
				200,
				'the newest session must still resolve — the cap must evict, not refuse'
			);
			assert.strictEqual(
				await status_on(sessions[0]!),
				401,
				`the oldest session must be evicted once the account exceeds ${max_sessions} sessions ` +
					'(a spine with no cap authenticates this cookie)'
			);
		});

		test("the session list marks the caller's own session current, and none for a bearer or daemon token", async () => {
			const fixture = await setup_test();
			const account = await fixture.create_account({
				username,
				password_value: DEFAULT_TEST_PASSWORD,
				roles: [...ws_account_roles]
			});
			const first = await login(fixture, 'the first login');
			const second = await login(fixture, 'the second login');

			/** `account_session_list` on a transport: the listed ids, and those marked current. */
			const list_on = async (
				transport: FetchTransport,
				headers: Record<string, string>,
				label: string
			): Promise<{ ids: Array<string>; current: Array<string> }> => {
				const { sessions } = expect_output(
					await cross_rpc_call(transport, rpc_path, 'account_session_list', undefined, headers),
					SessionListOutput
				);
				assert.ok(sessions.length > 0, `${label}: the account lists its sessions`);
				return {
					ids: sessions.map((s) => s.id).sort(),
					current: sessions.filter((s) => s.is_current).map((s) => s.id)
				};
			};

			const on_first = await list_on(first, {}, 'the first login');
			const on_second = await list_on(second, {}, 'the second login');
			assert.strictEqual(
				on_first.current.length,
				1,
				'the first login sees exactly one current session'
			);
			assert.strictEqual(
				on_second.current.length,
				1,
				'the second login sees exactly one current session'
			);
			assert.notStrictEqual(
				on_first.current[0],
				on_second.current[0],
				'each login sees its own session as current — computed per request, not the newest row'
			);
			assert.deepStrictEqual(on_second.ids, on_first.ids);

			const on_bearer = await list_on(
				fixture.fresh_transport({ origin: null }),
				account.create_bearer_headers(),
				'a bearer caller'
			);
			assert.deepStrictEqual(on_bearer.current, [], 'no session authenticated a bearer caller');
			assert.deepStrictEqual(on_bearer.ids, on_first.ids);

			const on_daemon = await list_on(
				fixture.fresh_transport({ origin: null }),
				fixture.create_daemon_token_headers(),
				'a daemon-token caller'
			);
			assert.deepStrictEqual(on_daemon.current, [], 'no session authenticated a daemon token');

			// the daemon token wins over a session cookie sent beside it, so the
			// cookie's session — the keeper's own, listed here — isn't current
			const on_keeper = await list_on(
				fixture.fresh_transport({ origin: null }),
				fixture.create_session_headers(),
				"the keeper's session"
			);
			assert.strictEqual(on_keeper.current.length, 1, "the keeper's cookie lists its session");
			const on_daemon_with_cookie = await list_on(
				fixture.fresh_transport({ origin: null }),
				fixture.create_daemon_token_headers(fixture.create_session_headers()),
				'a daemon-token caller sending a session cookie'
			);
			assert.deepStrictEqual(on_daemon_with_cookie.ids, on_keeper.ids);
			assert.deepStrictEqual(
				on_daemon_with_cookie.current,
				[],
				'a daemon token authenticated the request, not the cookie beside it'
			);

			if (ws === undefined || !ws_account_actions) return;
			const client = await create_ws_transport({
				base_url: ws.base_url,
				ws_path: ws.ws_path,
				cookies: first.cookies(),
				origin: ws.origin
			});
			try {
				const result = await client.request(1, 'account_session_list', undefined);
				const parsed = SessionListOutput.safeParse(result);
				assert.ok(
					parsed.success,
					`the socket's session list parses (got ${JSON.stringify(result)})`
				);
				const current = parsed.data.sessions.filter((s) => s.is_current).map((s) => s.id);
				assert.deepStrictEqual(
					current,
					on_first.current,
					"the first login's socket sees exactly its own session as current"
				);
			} finally {
				await client.close();
			}
		});

		// `max_sessions` further logins leave the watched session outside the
		// newest `max_sessions`, so it is evicted whatever sessions the account
		// held before it (`create_account` seeds one on some cradles).
		test_if(ws !== undefined, 'a session the cap evicts has its open socket closed', async () => {
			const fixture = await setup_test();
			await fixture.create_account({
				username,
				password_value: DEFAULT_TEST_PASSWORD,
				roles: [...ws_account_roles]
			});
			const victim = await login(fixture, 'the login whose socket is watched');
			const client = await create_ws_transport({
				base_url: ws!.base_url,
				ws_path: ws!.ws_path,
				cookies: victim.cookies(),
				origin: ws!.origin
			});
			try {
				// admitted and dispatching before the evicting logins
				await client.request(1, heartbeat_action_spec.method, {});
				for (let i = 0; i < max_sessions; i++) {
					await login(fixture, `evicting login ${i + 1}/${max_sessions}`);
				}
				const closed = await client.wait_for_close(2000);
				assert.ok(
					closed,
					`the socket of a session evicted past ${max_sessions} sessions did not close within 2s`
				);
				assert.strictEqual(client.close_code, WS_CLOSE_SESSION_REVOKED);
			} finally {
				await client.close();
			}
		});
	});
};
