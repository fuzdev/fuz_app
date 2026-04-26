/**
 * Integration tests for session and token limit enforcement.
 *
 * Verifies that `max_sessions` evicts oldest sessions on login and
 * `max_tokens` evicts oldest tokens on creation, using a real PGlite
 * database via `create_test_app`. Session verification and token creation
 * go through the RPC endpoint; `/login` remains REST.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_account_actions} from '$lib/auth/account_actions.js';
import {
	account_verify_action_spec,
	account_token_create_action_spec,
} from '$lib/auth/account_action_specs.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
} from '$lib/testing/db.js';
import {find_auth_route} from '$lib/testing/integration_helpers.js';
import {rpc_call_for_spec, rpc_call_non_browser} from '$lib/testing/rpc_helpers.js';
import {run_migrations} from '$lib/db/migrate.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';

const session_options = create_session_config('test_session');
const {cookie_name} = session_options;

const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

/**
 * Build a `create_route_specs` factory that passes custom limits
 * to `create_account_route_specs` (for `/login` max_sessions enforcement)
 * and mounts an RPC endpoint with matching `max_tokens`.
 */
const create_route_factory =
	(limits: {max_sessions?: number | null; max_tokens?: number | null}) =>
	(ctx: AppServerContext): Array<RouteSpec> => [
		...prefix_route_specs(
			'/api/account',
			create_account_route_specs(ctx.deps, {
				session_options,
				ip_rate_limiter: ctx.ip_rate_limiter,
				login_account_rate_limiter: ctx.login_account_rate_limiter,
				login_fail_floor_ms: 0,
				...limits,
			}),
		),
		...create_rpc_endpoint({
			path: RPC_PATH,
			actions: create_account_actions(ctx.deps, {max_tokens: limits.max_tokens}),
			log: ctx.deps.log,
		}),
	];

describe_db('session_token_limits', (get_db) => {
	describe('session limit enforcement', () => {
		test('logging in beyond max_sessions evicts oldest session', async () => {
			const max_sessions = 2;
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_route_factory({max_sessions}),
				db: get_db(),
			});
			const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
			assert.ok(login_route, 'Expected POST /api/account/login route');

			const login = async (): Promise<string> => {
				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'test-password-123',
					}),
				});
				assert.strictEqual(res.status, 200);
				const set_cookie = res.headers.get('set-cookie')!;
				const match = new RegExp(`${cookie_name}=([^;]+)`).exec(set_cookie);
				assert.ok(match?.[1], 'Expected session cookie in Set-Cookie header');
				return match[1];
			};

			// Bootstrap already created 1 session. Login twice more (3 total, max is 2).
			const cookie_2 = await login();
			const cookie_3 = await login();

			// Original bootstrap session should be evicted (oldest)
			const oldest_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_verify_action_spec,
				params: undefined,
				headers: {cookie: `${cookie_name}=${test_app.backend.session_cookie}`},
			});
			assert.strictEqual(
				oldest_res.status,
				401,
				'Oldest session should be evicted when limit exceeded',
			);

			// Newest session must work
			const newest_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_verify_action_spec,
				params: undefined,
				headers: {cookie: `${cookie_name}=${cookie_3}`},
			});
			assert.strictEqual(newest_res.status, 200, 'Newest session should survive');

			// Second session should also survive (within limit of 2)
			const second_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_verify_action_spec,
				params: undefined,
				headers: {cookie: `${cookie_name}=${cookie_2}`},
			});
			assert.strictEqual(second_res.status, 200, 'Second newest session should survive');
		});

		test('max_sessions null disables enforcement', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_route_factory({max_sessions: null}),
				db: get_db(),
			});
			const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
			assert.ok(login_route, 'Expected POST /api/account/login route');

			// Login several times — no eviction should happen
			for (let i = 0; i < 5; i++) {
				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: {
						host: 'localhost',
						origin: 'http://localhost:5173',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'test-password-123',
					}),
				});
				assert.strictEqual(res.status, 200);
			}

			// Original bootstrap session should still work (no eviction)
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_verify_action_spec,
				params: undefined,
				headers: {cookie: `${cookie_name}=${test_app.backend.session_cookie}`},
			});
			assert.strictEqual(res.status, 200, 'No sessions should be evicted when limit is null');
		});
	});

	describe('token limit enforcement', () => {
		test('creating tokens beyond max_tokens evicts oldest token', async () => {
			const max_tokens = 2;
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_route_factory({max_tokens}),
				db: get_db(),
			});

			const create_token = async (name: string): Promise<string> => {
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: RPC_PATH,
					spec: account_token_create_action_spec,
					params: {name},
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, `token_create failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
				return res.result.token;
			};

			// Bootstrap already created 1 token. Create 2 more (3 total, max is 2).
			const token_2 = await create_token('token-2');
			const token_3 = await create_token('token-3');

			// Original bootstrap token should be evicted (oldest)
			const oldest_res = await rpc_call_non_browser({
				app: test_app.app,
				path: RPC_PATH,
				method: account_verify_action_spec.method,
				headers: {authorization: `Bearer ${test_app.backend.api_token}`},
			});
			assert.strictEqual(
				oldest_res.status,
				401,
				'Oldest token should be evicted when limit exceeded',
			);

			// Newest token should work
			const newest_res = await rpc_call_non_browser({
				app: test_app.app,
				path: RPC_PATH,
				method: account_verify_action_spec.method,
				headers: {authorization: `Bearer ${token_3}`},
			});
			assert.strictEqual(newest_res.status, 200, 'Newest token should survive');

			// Second token should also survive (within limit of 2)
			const second_res = await rpc_call_non_browser({
				app: test_app.app,
				path: RPC_PATH,
				method: account_verify_action_spec.method,
				headers: {authorization: `Bearer ${token_2}`},
			});
			assert.strictEqual(second_res.status, 200, 'Second newest token should survive');
		});

		test('max_tokens null disables enforcement', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_route_factory({max_tokens: null}),
				db: get_db(),
			});

			// Create several tokens — no eviction should happen
			for (let i = 0; i < 5; i++) {
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: RPC_PATH,
					spec: account_token_create_action_spec,
					params: {name: `token-${i}`},
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, `token_create ${i} failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
			}

			// Original bootstrap token should still work (no eviction)
			const res = await rpc_call_non_browser({
				app: test_app.app,
				path: RPC_PATH,
				method: account_verify_action_spec.method,
				headers: {authorization: `Bearer ${test_app.backend.api_token}`},
			});
			assert.strictEqual(res.status, 200, 'No tokens should be evicted when limit is null');
		});
	});
});
