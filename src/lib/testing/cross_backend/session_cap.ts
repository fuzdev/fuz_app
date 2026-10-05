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
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { heartbeat_action_spec } from '../../actions/heartbeat.ts';
import { WS_CLOSE_SESSION_REVOKED } from '../../actions/transports.ts';
import { DEFAULT_MAX_SESSIONS } from '../../auth/account_route_schema.ts';
import { DEFAULT_TEST_PASSWORD } from '../test_credentials.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { create_ws_transport } from '../transports/ws_transport.ts';
import { test_if } from './capabilities.ts';
import type { SetupTest } from './setup.ts';

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
	/**
	 * Where the backend's WebSocket endpoint is, for the case that an evicted
	 * session's socket is closed. Pass it when the backend has a WS transport
	 * (`capabilities.ws`); omitted, that case is skipped.
	 */
	readonly ws?: {
		/** Base URL the backend is reachable at (e.g. `http://localhost:1178`). */
		readonly base_url: string;
		/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
		readonly ws_path: string;
		/** Origin for the upgrade. Defaults to `base_url`. */
		readonly origin?: string;
	};
}

export const describe_session_cap_cross_tests = (options: SessionCapCrossTestOptions): void => {
	const { setup_test, ws } = options;
	const max_sessions = options.max_sessions ?? DEFAULT_MAX_SESSIONS;
	const login_path = options.login_path ?? '/api/account/login';
	const status_path = options.status_path ?? '/api/account/status';
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

		// `max_sessions` further logins leave the watched session outside the
		// newest `max_sessions`, so it is evicted whatever sessions the account
		// held before it (`create_account` seeds one on some cradles).
		test_if(ws !== undefined, 'a session the cap evicts has its open socket closed', async () => {
			const fixture = await setup_test();
			await fixture.create_account({ username, password_value: DEFAULT_TEST_PASSWORD });
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
