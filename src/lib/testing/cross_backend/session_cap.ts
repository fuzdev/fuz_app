import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **per-account concurrent-session cap**
 * over real HTTP.
 *
 * The cap is a shipped control on the TS spine (`query_session_enforce_limit`,
 * `DEFAULT_MAX_SESSIONS`) that the Rust spine went without — its session INSERT
 * carried no eviction, so every Rust-backed deployment served unlimited
 * concurrent sessions per account. That divergence survived because nothing crossed the
 * wire on it — the TS half is pinned by in-process tests
 * (`session_middleware.lifecycle.db.test.ts`, `session_token_limits.integration.db.test.ts`)
 * whose Rust counterparts simply didn't exist to fail. This suite is the pin
 * that runs on *both*, so the next spine to lose the cap fails here rather than
 * in production. Two properties:
 *
 * - **the cap bounds concurrent sessions, by eviction not refusal** — logging in
 *   `max_sessions + 1` times succeeds every time (a login is never denied for
 *   being the one over the line), and the newest cookie resolves afterward.
 * - **the evicted session is the oldest** — the first login's cookie no longer
 *   authenticates once the cap is exceeded. A spine with no cap authenticates it
 *   fine, which is exactly the defect this catches.
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

import { DEFAULT_MAX_SESSIONS } from '../../auth/account_route_schema.ts';
import { DEFAULT_TEST_PASSWORD } from '../test_credentials.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
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
}

export const describe_session_cap_cross_tests = (options: SessionCapCrossTestOptions): void => {
	const { setup_test } = options;
	const max_sessions = options.max_sessions ?? DEFAULT_MAX_SESSIONS;
	const login_path = options.login_path ?? '/api/account/login';
	const status_path = options.status_path ?? '/api/account/status';
	// Fresh-keeper-per-test wipes the DB between tests, so a literal username
	// never collides (see `setup.ts`).
	const username = 'session_cap_user';

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
				const transport = fixture.fresh_transport();
				const res = await transport(login_path, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ username, password: DEFAULT_TEST_PASSWORD })
				});
				assert.strictEqual(
					res.status,
					200,
					`login ${i + 1}/${max_sessions + 1} must succeed — the cap evicts, it never refuses`
				);
				assert.ok(
					transport.cookies().length > 0,
					`login ${i + 1} must set a session cookie on its jar`
				);
				sessions.push(transport);
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
	});
};
