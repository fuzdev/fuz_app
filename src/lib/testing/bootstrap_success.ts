import './assert_dev_env.ts';

/**
 * Bootstrap success-path suite for consumer projects.
 *
 * Exercises `POST /bootstrap` against an empty DB (no pre-keeper, lock
 * unflipped) through the real `bootstrap_account` flow. Asserts on
 * observable state — account exists, `bootstrap_lock.bootstrapped` is
 * true, audit row emitted, response body shape — rather than
 * `on_bootstrap` callback invocation, so the suite stays cross-impl
 * friendly when cross-process testing wires it against a spawned
 * Rust backend.
 *
 * Folded into `describe_standard_tests` with a `bootstrap.mode === 'live'`
 * silent-skip gate; consumers wiring live bootstrap pick up success-path
 * coverage by default.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import type { SessionOptions } from '../auth/session_cookie.ts';
import type { BootstrapLiveOptions } from '../server/app_server.ts';
import type { AppServerContext } from '../server/app_server_context.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import { ERROR_ALREADY_BOOTSTRAPPED, ERROR_INVALID_TOKEN } from '../http/error_schemas.ts';
import { create_test_app_for_bootstrap } from './app_server.ts';
import type { RpcEndpointsSuiteOption } from './rpc_helpers.ts';

const DEFAULT_TEST_TOKEN = 'test-bootstrap-token-value-deterministic';
const TEST_USERNAME = 'keeper';
const TEST_PASSWORD = 'test-password-with-min-12-chars';

/** Options for `describe_bootstrap_success_tests`. */
export interface BootstrapSuccessTestOptions {
	session_options: SessionOptions<string>;
	/** Same factory the consumer's production server uses. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** RPC endpoints — passed through to `create_app_server` for shape parity. */
	rpc_endpoints?: RpcEndpointsSuiteOption;
	/**
	 * Live bootstrap config — the suite drives `POST /bootstrap` against
	 * `bootstrap.token_path`. The suite does NOT assert on `on_bootstrap`
	 * callback invocation (Hono-coupled signature is in-process only);
	 * assertions land on observable DB state.
	 */
	bootstrap: BootstrapLiveOptions;
	/** Override the synthetic token text. Default deterministic. */
	bootstrap_token?: string;
}

/**
 * Run the bootstrap success-path test suite against the consumer's
 * production-shaped wiring.
 */
export const describe_bootstrap_success_tests = (options: BootstrapSuccessTestOptions): void => {
	const token = options.bootstrap_token ?? DEFAULT_TEST_TOKEN;
	const route_prefix = options.bootstrap.route_prefix ?? '/api/account';
	const bootstrap_path = `${route_prefix}/bootstrap`;

	describe('bootstrap success path', () => {
		test('POST /bootstrap with valid token creates the keeper account and flips the lock', async () => {
			const test_app = await create_test_app_for_bootstrap({
				session_options: options.session_options,
				create_route_specs: options.create_route_specs,
				rpc_endpoints: options.rpc_endpoints,
				bootstrap: options.bootstrap,
				bootstrap_token: token
			});
			try {
				const response = await test_app.app.request(bootstrap_path, {
					method: 'POST',
					headers: test_app.create_request_headers({ 'content-type': 'application/json' }),
					body: JSON.stringify({
						token,
						username: TEST_USERNAME,
						password: TEST_PASSWORD
					})
				});

				// Response shape
				assert.strictEqual(response.status, 200);
				const body = (await response.json()) as {
					ok: boolean;
					account: { id: string; username: string };
					actor: { id: string };
				};
				assert.strictEqual(body.ok, true);
				assert.strictEqual(body.account.username, TEST_USERNAME);
				assert.ok(body.account.id);
				assert.ok(body.actor.id);

				// Observable state: account exists in DB
				const account = await test_app.backend.deps.db.query_one<{ username: string }>(
					'SELECT username FROM account WHERE username = $1',
					[TEST_USERNAME]
				);
				assert.ok(account);

				// Observable state: bootstrap_lock flipped to true
				const lock = await test_app.backend.deps.db.query_one<{ bootstrapped: boolean }>(
					'SELECT bootstrapped FROM bootstrap_lock WHERE id = 1'
				);
				assert.ok(lock);
				assert.strictEqual(lock.bootstrapped, true);

				// Observable state: audit row emitted
				const audit_row = await test_app.backend.deps.db.query_one<{
					event_type: string;
					account_id: string;
				}>(
					"SELECT event_type, account_id FROM audit_log WHERE event_type = 'bootstrap' AND outcome = 'success' LIMIT 1"
				);
				assert.ok(audit_row);
				assert.strictEqual(audit_row.account_id, body.account.id);
			} finally {
				await test_app.cleanup();
			}
		});

		test('second POST /bootstrap returns 403 ALREADY_BOOTSTRAPPED', async () => {
			const test_app = await create_test_app_for_bootstrap({
				session_options: options.session_options,
				create_route_specs: options.create_route_specs,
				rpc_endpoints: options.rpc_endpoints,
				bootstrap: options.bootstrap,
				bootstrap_token: token
			});
			try {
				// First bootstrap succeeds
				const first = await test_app.app.request(bootstrap_path, {
					method: 'POST',
					headers: test_app.create_request_headers({ 'content-type': 'application/json' }),
					body: JSON.stringify({
						token,
						username: TEST_USERNAME,
						password: TEST_PASSWORD
					})
				});
				assert.strictEqual(first.status, 200);

				// Second attempt blocked by lock
				const second = await test_app.app.request(bootstrap_path, {
					method: 'POST',
					headers: test_app.create_request_headers({ 'content-type': 'application/json' }),
					body: JSON.stringify({
						token,
						username: 'another_user',
						password: TEST_PASSWORD
					})
				});
				assert.strictEqual(second.status, 403);
				const body = (await second.json()) as { error: string };
				assert.strictEqual(body.error, ERROR_ALREADY_BOOTSTRAPPED);
			} finally {
				await test_app.cleanup();
			}
		});

		test('POST /bootstrap with wrong token returns 401 INVALID_TOKEN', async () => {
			const test_app = await create_test_app_for_bootstrap({
				session_options: options.session_options,
				create_route_specs: options.create_route_specs,
				rpc_endpoints: options.rpc_endpoints,
				bootstrap: options.bootstrap,
				bootstrap_token: token
			});
			try {
				const response = await test_app.app.request(bootstrap_path, {
					method: 'POST',
					headers: test_app.create_request_headers({ 'content-type': 'application/json' }),
					body: JSON.stringify({
						token: 'wrong-token-value-that-does-not-match',
						username: TEST_USERNAME,
						password: TEST_PASSWORD
					})
				});
				assert.strictEqual(response.status, 401);
				const body = (await response.json()) as { error: string };
				assert.strictEqual(body.error, ERROR_INVALID_TOKEN);

				// Observable state: lock NOT flipped (transaction rolled back on auth failure)
				const lock = await test_app.backend.deps.db.query_one<{ bootstrapped: boolean }>(
					'SELECT bootstrapped FROM bootstrap_lock WHERE id = 1'
				);
				assert.ok(lock);
				assert.strictEqual(lock.bootstrapped, false);
			} finally {
				await test_app.cleanup();
			}
		});
	});
};
