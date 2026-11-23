import '../assert_dev_env.ts';

/**
 * The revocations sent on a target account's own session or by an admin that
 * the cross-process WS and SSE round-trip suites both close a live connection
 * on — one table, so a revocation added here is covered on both transports.
 *
 * Each row drives one revocation of a target account's credentials and asserts
 * it succeeded; the suite opens the target's connections first and asserts
 * their close after. Each row says what it closes (`AccountRevocation.closes`):
 * the whole account, or only the session the revocation was sent on
 * (`POST /logout`, `account_session_revoke` of the current session), which
 * leaves the account's other credentials' connections open.
 * `describe_cross_process_ws_tests` and `describe_cross_process_sse_tests`
 * iterate `create_account_revocations`. The revocations that name another
 * credential in their input (a sibling session, one token), a cap eviction,
 * and those a suite drives differently (session revoke-all, account delete)
 * stay in their suites.
 *
 * The drivers are exported on their own for a consumer suite that closes a
 * transport of its own on the same revocations.
 *
 * @module
 */

import { assert } from 'vitest';

import {
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	SessionListOutput,
	SessionRevokeOutput
} from '../../auth/account_action_specs.ts';
import {
	account_purge_action_spec,
	admin_token_revoke_all_action_spec
} from '../../auth/admin_action_specs.ts';
import { DEFAULT_TEST_PASSWORD } from '../test_credentials.ts';
import type { BackendCapabilities } from './capabilities.ts';
import { cross_rpc_call, expect_output } from './cross_rpc.ts';
import type { TestAccount } from '../test_app.ts';
import type { TestFixture } from './setup.ts';

/**
 * POST a JSON body to a REST route on `account`'s session, asserting `200`.
 *
 * @param fixture - the per-test fixture whose fresh transport carries the request
 * @param account - the account whose session cookie authenticates it
 * @param path - the REST route path
 * @param body - the JSON request body
 */
export const cross_post_as = async (
	fixture: TestFixture,
	account: TestAccount,
	path: string,
	body: unknown
): Promise<void> => {
	const res = await fixture.fresh_transport()(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...account.create_session_headers() },
		body: JSON.stringify(body)
	});
	assert.strictEqual(res.status, 200, `POST ${path}: ${await res.text()}`);
};

/**
 * Revoke the session `account`'s requests are sent on (`account_session_revoke`
 * on that session), asserting it was revoked: the session list, read on the
 * same session, names it as the current one, so the id revoked is the one the
 * caller holds rather than a sibling's.
 *
 * @param fixture - the per-test fixture whose fresh transport carries the requests
 * @param rpc_path - the RPC endpoint path
 * @param account - the account whose session cookie authenticates both calls
 */
export const cross_session_revoke_current = async (
	fixture: TestFixture,
	rpc_path: string,
	account: TestAccount
): Promise<void> => {
	const headers = account.create_session_headers();
	const { sessions } = expect_output(
		await cross_rpc_call(
			fixture.fresh_transport(),
			rpc_path,
			account_session_list_action_spec.method,
			undefined,
			headers
		),
		SessionListOutput
	);
	const current = sessions.filter((session) => session.is_current);
	assert.strictEqual(current.length, 1, `exactly one current session: ${JSON.stringify(sessions)}`);
	const output = expect_output(
		await cross_rpc_call(
			fixture.fresh_transport(),
			rpc_path,
			account_session_revoke_action_spec.method,
			{ session_id: current[0]!.id },
			headers
		),
		SessionRevokeOutput
	);
	assert.strictEqual(output.revoked, true, 'account_session_revoke revoked the current session');
};

/**
 * Revoke every API token of `account_id` over the keeper's admin session
 * (`admin_token_revoke_all`), asserting success.
 *
 * @param fixture - the per-test fixture; its keeper holds the admin role
 * @param rpc_path - the RPC endpoint path
 * @param account_id - the account whose tokens to revoke
 */
export const cross_admin_token_revoke_all = async (
	fixture: TestFixture,
	rpc_path: string,
	account_id: string
): Promise<void> => {
	const res = await cross_rpc_call(
		fixture.transport,
		rpc_path,
		admin_token_revoke_all_action_spec.method,
		{ account_id },
		fixture.create_session_headers()
	);
	assert.ok(res.ok, `admin_token_revoke_all failed: ${JSON.stringify(res.error)}`);
};

/**
 * Purge `account_id` over the keeper's daemon token (`account_purge`),
 * asserting success. The request carries no `Origin`, as a daemon-token
 * caller's wouldn't.
 *
 * @param fixture - the per-test fixture
 * @param rpc_path - the RPC endpoint path
 * @param account_id - the account to purge
 */
export const cross_account_purge = async (
	fixture: TestFixture,
	rpc_path: string,
	account_id: string
): Promise<void> => {
	const res = await cross_rpc_call(
		fixture.fresh_transport({ origin: null }),
		rpc_path,
		account_purge_action_spec.method,
		{ account_id, confirm: true },
		fixture.create_daemon_token_headers()
	);
	assert.ok(res.ok, `account_purge failed: ${JSON.stringify(res.error)}`);
};

/**
 * What a revocation row closes:
 *
 * - `account` — every connection of the target account, whatever credential
 *   opened it
 * - `session` — only the connections of the session the revocation was sent on
 *   or names (`TestAccount.create_session_headers`'s); the account's other sessions, its
 *   API tokens, and the daemon token stay valid, and their connections open
 */
export type AccountRevocationCloses = 'account' | 'session';

/** One revocation of a target account's credentials, as a row both transport suites iterate. */
export interface AccountRevocation {
	/** Names the revocation in a case name and a failure message. */
	readonly label: string;
	/**
	 * Distinguishes the target account's username — unique in the table, and
	 * short enough that a suite's prefix keeps the username within `Username`.
	 */
	readonly slug: string;
	/** Whether the backend serves the revocation (beyond `rpc_path`, which every row needs). */
	readonly gate: boolean;
	/** Which of the target's connections the revocation closes. */
	readonly closes: AccountRevocationCloses;
	/**
	 * Revoke `target`'s credentials and assert the revocation succeeded.
	 * `target` must have been created with `DEFAULT_TEST_PASSWORD`, which the
	 * password-change row presents.
	 */
	readonly revoke: (fixture: TestFixture, target: TestAccount) => Promise<void>;
}

/** Configuration for `create_account_revocations`. */
export interface AccountRevocationsOptions {
	/** Backend capability flags; `account_purge` gates on `account_lifecycle`. */
	readonly capabilities: BackendCapabilities;
	/** RPC endpoint path the admin and keeper revocations are sent to. */
	readonly rpc_path: string;
	/** REST logout route path. */
	readonly logout_path: string;
	/** REST password-change route path. */
	readonly password_path: string;
}

/**
 * The revocations of a target account's credentials both transport suites
 * drive: `admin_token_revoke_all`, `POST /password`, and `account_purge`
 * (gated on `capabilities.account_lifecycle`) close every connection of the
 * account; `POST /logout` and `account_session_revoke` of the caller's own
 * session close only the connections of the session they end.
 *
 * @param options - the backend's capabilities and route paths
 * @returns the revocation rows, in a stable order
 */
export const create_account_revocations = (
	options: AccountRevocationsOptions
): ReadonlyArray<AccountRevocation> => {
	const { capabilities, rpc_path, logout_path, password_path } = options;
	return [
		{
			label: 'admin_token_revoke_all',
			slug: 'token_revoke_all',
			gate: true,
			closes: 'account',
			revoke: (fixture, target) =>
				cross_admin_token_revoke_all(fixture, rpc_path, target.account.id)
		},
		{
			label: 'POST /logout',
			slug: 'logout',
			gate: true,
			closes: 'session',
			revoke: (fixture, target) => cross_post_as(fixture, target, logout_path, {})
		},
		{
			label: 'account_session_revoke',
			slug: 'session_revoke',
			gate: true,
			closes: 'session',
			revoke: (fixture, target) => cross_session_revoke_current(fixture, rpc_path, target)
		},
		{
			label: 'POST /password',
			slug: 'password',
			gate: true,
			closes: 'account',
			revoke: (fixture, target) =>
				cross_post_as(fixture, target, password_path, {
					current_password: DEFAULT_TEST_PASSWORD,
					new_password: 'revoked-new-password-456'
				})
		},
		{
			label: 'account_purge',
			slug: 'purge',
			gate: capabilities.account_lifecycle,
			closes: 'account',
			revoke: (fixture, target) => cross_account_purge(fixture, rpc_path, target.account.id)
		}
	];
};
