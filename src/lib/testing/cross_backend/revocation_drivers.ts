import '../assert_dev_env.ts';

/**
 * The account-wide revocations the cross-process WS and SSE round-trip suites
 * both close a live connection on — one table, so a revocation added here is
 * covered on both transports.
 *
 * Each row drives one revocation of a target account's credentials and asserts
 * it succeeded; the suite opens the target's connections first and asserts
 * their close after. `describe_cross_process_ws_tests` and
 * `describe_cross_process_sse_tests` iterate `create_account_revocations`. The
 * revocations whose close is narrower than the account (one session, one
 * token, a cap eviction) or that a suite drives differently (session
 * revoke-all, account delete) stay in their suites.
 *
 * The drivers are exported on their own for a consumer suite that closes a
 * transport of its own on the same revocations.
 *
 * @module
 */

import { assert } from 'vitest';

import {
	account_purge_action_spec,
	admin_token_revoke_all_action_spec
} from '../../auth/admin_action_specs.ts';
import { DEFAULT_TEST_PASSWORD } from '../test_credentials.ts';
import type { BackendCapabilities } from './capabilities.ts';
import { cross_rpc_call } from './cell_cross_helpers.ts';
import type { TestAccount } from '../app_server.ts';
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

/** One account-wide revocation, as a row both transport suites iterate. */
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
 * The account-wide revocations that close every connection of the target
 * account: `admin_token_revoke_all`, `POST /logout`, `POST /password`, and
 * `account_purge` (gated on `capabilities.account_lifecycle`).
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
			revoke: (fixture, target) =>
				cross_admin_token_revoke_all(fixture, rpc_path, target.account.id)
		},
		{
			label: 'POST /logout',
			slug: 'logout',
			gate: true,
			revoke: (fixture, target) => cross_post_as(fixture, target, logout_path, {})
		},
		{
			label: 'POST /password',
			slug: 'password',
			gate: true,
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
			revoke: (fixture, target) => cross_account_purge(fixture, rpc_path, target.account.id)
		}
	];
};
