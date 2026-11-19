import '../assert_dev_env.ts';

/**
 * One more session for an account, on a jar of its own — for the cross
 * suites that hold several sessions of one account at once (the session cap,
 * a session-scoped revocation).
 *
 * @module
 */

import { assert } from 'vitest';

import type { FetchTransport } from '../transports/fetch_transport.ts';
import type { TestFixture } from './setup.ts';

/** Options for `login_fresh_session`. */
export interface LoginFreshSessionOptions {
	/** REST login route path. */
	readonly login_path: string;
	readonly username: string;
	readonly password: string;
	/** Names the login in a failure message. */
	readonly label: string;
}

/**
 * Log `username` in on a fresh transport: one login, one session, one jar
 * holding exactly that session's cookie, which every call on the transport
 * re-sends. The fixture's own transport carries the keeper's cookie, so a
 * login there would leave the jar holding two.
 *
 * @param fixture - the per-test fixture whose backend the login goes to
 * @param options - the route, the credentials, and a label for failures
 * @returns the transport holding the new session's cookie
 */
export const login_fresh_session = async (
	fixture: TestFixture,
	options: LoginFreshSessionOptions
): Promise<FetchTransport> => {
	const { login_path, username, password, label } = options;
	const transport = fixture.fresh_transport();
	const res = await transport(login_path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username, password })
	});
	assert.strictEqual(res.status, 200, `${label} must succeed (status ${res.status})`);
	assert.ok(transport.cookies().length > 0, `${label} must set a session cookie on its jar`);
	return transport;
};
