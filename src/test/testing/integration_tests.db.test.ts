/**
 * Tests for integration test infrastructure.
 *
 * Uses fuz_app's own routes to exercise `create_test_app`,
 * `assert_response_matches_spec`, and `describe_standard_integration_tests`.
 *
 * @module
 */

import {test, assert, describe, beforeAll, beforeEach, afterAll} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {fuz_session_config} from '$lib/auth/session_cookie.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_account_actions} from '$lib/auth/account_actions.js';
import {account_verify_action_spec} from '$lib/auth/account_action_specs.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RpcEndpointSpec} from '$lib/http/surface.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {
	find_route_spec,
	find_auth_route,
	assert_response_matches_spec,
} from '$lib/testing/integration_helpers.js';
import {rpc_call, rpc_call_non_browser} from '$lib/testing/rpc_helpers.js';

/** Duck-type of `Hono.request`; matches `RpcCallArgs.app`. */
interface TestApp {
	request: (input: string, init: RequestInit) => Promise<Response> | Response;
}
import {describe_standard_integration_tests} from '$lib/testing/integration.js';
import {AUTH_INTEGRATION_TRUNCATE_TABLES} from '$lib/testing/db.js';

import {pglite_factory} from '../db_fixture.js';

const RPC_PATH = '/api/rpc';
const rpc_log = new Logger('integration-tests-rpc', {level: 'off'});

/** Route factory using fuz_app's own account routes. */
const test_route_factory = (ctx: AppServerContext): Array<RouteSpec> => [
	create_health_route_spec(),
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options: fuz_session_config,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			login_fail_floor_ms: 0,
		}),
	),
];

/** RPC endpoint factory — ctx-bound so the actions' bound `audit` emitter matches each test's real backend. */
const test_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: RPC_PATH,
		actions: create_account_actions({
			log: rpc_log,
			audit: ctx.deps.audit,
		}),
	},
];

/** Hit `account_verify` via RPC and return the HTTP status. */
const rpc_verify_status = async (
	app: TestApp,
	headers: Record<string, string>,
): Promise<number> => {
	const res = await rpc_call({
		app,
		path: RPC_PATH,
		method: account_verify_action_spec.method,
		headers,
	});
	return res.status;
};

/**
 * Hit `account_verify` via RPC without the default `origin` header so bearer
 * auth is not discarded as browser context.
 */
const rpc_verify_status_no_origin = async (
	app: TestApp,
	headers: Record<string, string>,
): Promise<number> => {
	const res = await rpc_call_non_browser({
		app,
		path: RPC_PATH,
		method: account_verify_action_spec.method,
		headers,
	});
	return res.status;
};

// --- Run the standard integration test suite ---

describe_standard_integration_tests({
	session_options: fuz_session_config,
	create_route_specs: test_route_factory,
	rpc_endpoints: test_rpc_endpoints,
});

// --- Standalone tests for the helpers ---

describe('create_test_app', () => {
	let db: Awaited<ReturnType<typeof pglite_factory.create>>;

	beforeAll(async () => {
		db = await pglite_factory.create();
	});

	beforeEach(async () => {
		for (const table of AUTH_INTEGRATION_TRUNCATE_TABLES) {
			await db.query(`TRUNCATE ${table} CASCADE`);
		}
	});

	afterAll(async () => {
		await pglite_factory.close(db);
	});

	test('health route returns 200', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		const res = await test_app.app.request('/health');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.status, 'ok');
	});

	test('create_session_headers produces working auth headers', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
			app_options: {rpc_endpoints: test_rpc_endpoints},
		});

		assert.strictEqual(
			await rpc_verify_status(test_app.app, test_app.create_session_headers()),
			200,
		);
	});

	test('create_bearer_headers produces working auth headers', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
			app_options: {rpc_endpoints: test_rpc_endpoints},
		});

		assert.strictEqual(
			await rpc_verify_status_no_origin(test_app.app, test_app.create_bearer_headers()),
			200,
		);
	});

	test('create_account returns working credentials', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
			app_options: {rpc_endpoints: test_rpc_endpoints},
		});

		const account = await test_app.create_account({username: 'new_user'});
		assert.strictEqual(account.account.username, 'new_user');
		assert.ok(account.session_cookie.length > 0);
		assert.ok(account.api_token.length > 0);

		// Session cookie works
		assert.strictEqual(
			await rpc_verify_status(test_app.app, {cookie: `fuz_session=${account.session_cookie}`}),
			200,
		);

		// Bearer token works
		assert.strictEqual(
			await rpc_verify_status_no_origin(test_app.app, {
				authorization: `Bearer ${account.api_token}`,
			}),
			200,
		);
	});

	test('route_specs include consumer and factory-managed routes', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
			app_options: {rpc_endpoints: test_rpc_endpoints},
		});

		assert.ok(test_app.route_specs.length > 0);
		// health + 4 account REST (login/logout/password/verify) + 2 RPC (GET + POST) +
		// factory-managed routes (surface + server status etc.) = plenty
		assert.ok(test_app.route_specs.length >= 7);
	});

	test('REST GET /api/account/verify returns 200 with empty body for authenticated session', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		const res = await test_app.app.request('/api/account/verify', {
			method: 'GET',
			headers: test_app.create_session_headers(),
		});
		assert.strictEqual(res.status, 200);
		// nginx `auth_request` reads status only; body must be empty so the subrequest
		// does not carry any payload back to the outer location.
		const body = await res.text();
		assert.strictEqual(body, '');
	});

	test('REST GET /api/account/verify returns 401 without credentials', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		const res = await test_app.app.request('/api/account/verify', {
			method: 'GET',
			headers: {host: 'localhost', origin: 'http://localhost:5173'},
		});
		assert.strictEqual(res.status, 401);
	});
});

describe('find_route_spec', () => {
	const specs: Array<RouteSpec> = [
		...prefix_route_specs('/api/account', [
			{
				method: 'GET',
				path: '/verify',
				auth: {account: 'required', actor: 'none'},
				handler: () => new Response(),
				description: 'test',
				input: {safeParse: () => ({success: true})} as never,
				output: {safeParse: () => ({success: true})} as never,
			},
			{
				method: 'POST',
				path: '/tokens/:id/revoke',
				auth: {account: 'required', actor: 'none'},
				handler: () => new Response(),
				description: 'test',
				input: {safeParse: () => ({success: true})} as never,
				output: {safeParse: () => ({success: true})} as never,
			},
		]),
	];

	test('exact match', () => {
		const result = find_route_spec(specs, 'GET', '/api/account/verify');
		assert.ok(result);
		assert.strictEqual(result.method, 'GET');
	});

	test('parameterized match', () => {
		const result = find_route_spec(specs, 'POST', '/api/account/tokens/tok_abc123/revoke');
		assert.ok(result);
		assert.strictEqual(result.path, '/api/account/tokens/:id/revoke');
	});

	test('returns undefined for no match', () => {
		const result = find_route_spec(specs, 'GET', '/nonexistent');
		assert.strictEqual(result, undefined);
	});
});

describe('find_auth_route', () => {
	const specs: Array<RouteSpec> = prefix_route_specs('/api/account', [
		{
			method: 'POST',
			path: '/login',
			auth: {account: 'none', actor: 'none'},
			handler: () => new Response(),
			description: 'test',
			input: {safeParse: () => ({success: true})} as never,
			output: {safeParse: () => ({success: true})} as never,
		},
	]);

	test('finds by suffix and method', () => {
		const result = find_auth_route(specs, '/login', 'POST');
		assert.ok(result);
		assert.strictEqual(result.path, '/api/account/login');
	});

	test('returns undefined for wrong method', () => {
		const result = find_auth_route(specs, '/login', 'GET');
		assert.strictEqual(result, undefined);
	});
});

describe('assert_response_matches_spec', () => {
	let db: Awaited<ReturnType<typeof pglite_factory.create>>;

	beforeAll(async () => {
		db = await pglite_factory.create();
	});

	beforeEach(async () => {
		for (const table of AUTH_INTEGRATION_TRUNCATE_TABLES) {
			await db.query(`TRUNCATE ${table} CASCADE`);
		}
	});

	afterAll(async () => {
		await pglite_factory.close(db);
	});

	test('validates correct 200 response', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		// `/api/account/logout` is a session-authenticated POST that still lives on REST.
		const res = await test_app.app.request('/api/account/logout', {
			method: 'POST',
			headers: test_app.create_session_headers({'content-type': 'application/json'}),
			body: JSON.stringify({}),
		});
		assert.strictEqual(res.status, 200);

		// Should not throw
		await assert_response_matches_spec(test_app.route_specs, 'POST', '/api/account/logout', res);
	});

	test('validates correct 401 response', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		const res = await test_app.app.request('/api/account/logout', {
			method: 'POST',
			headers: {
				host: 'localhost',
				origin: 'http://localhost:5173',
				'content-type': 'application/json',
			},
			body: JSON.stringify({}),
		});
		assert.strictEqual(res.status, 401);

		// Should not throw
		await assert_response_matches_spec(test_app.route_specs, 'POST', '/api/account/logout', res);
	});

	test('throws for missing route spec', async () => {
		const res = new Response('{}', {status: 200});
		await assert_rejects(
			() => assert_response_matches_spec([], 'GET', '/nonexistent', res),
			/No route spec found/,
		);
	});
});
