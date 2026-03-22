/**
 * Tests for integration test infrastructure.
 *
 * Uses fuz_app's own routes to exercise `create_test_app`,
 * `assert_response_matches_spec`, and `describe_standard_integration_tests`.
 *
 * @module
 */

import {test, assert, describe, beforeAll, beforeEach, afterAll} from 'vitest';

import {fuz_session_config} from '$lib/auth/session_cookie.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {
	find_route_spec,
	find_auth_route,
	assert_response_matches_spec,
} from '$lib/testing/integration_helpers.js';
import {describe_standard_integration_tests} from '$lib/testing/integration.js';
import {AUTH_INTEGRATION_TRUNCATE_TABLES} from '$lib/testing/db.js';

import {pglite_factory} from '../db_fixture.js';

/** Route factory using fuz_app's own account routes. */
const test_route_factory = (ctx: AppServerContext): Array<RouteSpec> => [
	create_health_route_spec(),
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options: fuz_session_config,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
		}),
	),
];

// --- Run the standard integration test suite ---

describe_standard_integration_tests({
	session_options: fuz_session_config,
	create_route_specs: test_route_factory,
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
		});

		const res = await test_app.app.request('/api/account/verify', {
			headers: test_app.create_session_headers(),
		});
		assert.strictEqual(res.status, 200);
	});

	test('create_bearer_headers produces working auth headers', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		const res = await test_app.app.request('/api/account/verify', {
			headers: test_app.create_bearer_headers(),
		});
		assert.strictEqual(res.status, 200);
	});

	test('create_account returns working credentials', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		const account = await test_app.create_account({username: 'new_user'});
		assert.strictEqual(account.account.username, 'new_user');
		assert.ok(account.session_cookie.length > 0);
		assert.ok(account.api_token.length > 0);

		// Session cookie works
		const res = await test_app.app.request('/api/account/verify', {
			headers: {
				host: 'localhost',
				origin: 'http://localhost:5173',
				cookie: `fuz_session=${account.session_cookie}`,
			},
		});
		assert.strictEqual(res.status, 200);

		// Bearer token works
		const bearer_res = await test_app.app.request('/api/account/verify', {
			headers: {
				host: 'localhost',
				authorization: `Bearer ${account.api_token}`,
			},
		});
		assert.strictEqual(bearer_res.status, 200);
	});

	test('route_specs include consumer and factory-managed routes', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		assert.ok(test_app.route_specs.length > 0);
		// health + 10 account routes + factory-managed (surface route)
		assert.ok(test_app.route_specs.length >= 12);
	});
});

describe('find_route_spec', () => {
	const specs: Array<RouteSpec> = [
		...prefix_route_specs('/api/account', [
			{
				method: 'GET',
				path: '/verify',
				auth: {type: 'authenticated'},
				handler: () => new Response(),
				description: 'test',
				input: {safeParse: () => ({success: true})} as never,
				output: {safeParse: () => ({success: true})} as never,
			},
			{
				method: 'POST',
				path: '/tokens/:id/revoke',
				auth: {type: 'authenticated'},
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
			auth: {type: 'none'},
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

		const res = await test_app.app.request('/api/account/verify', {
			headers: test_app.create_session_headers(),
		});
		assert.strictEqual(res.status, 200);

		// Should not throw
		await assert_response_matches_spec(test_app.route_specs, 'GET', '/api/account/verify', res);
	});

	test('validates correct 401 response', async () => {
		const test_app = await create_test_app({
			session_options: fuz_session_config,
			create_route_specs: test_route_factory,
			db,
		});

		const res = await test_app.app.request('/api/account/verify', {
			headers: {host: 'localhost'},
		});
		assert.strictEqual(res.status, 401);

		// Should not throw
		await assert_response_matches_spec(test_app.route_specs, 'GET', '/api/account/verify', res);
	});

	test('throws for missing route spec', async () => {
		const res = new Response('{}', {status: 200});
		try {
			await assert_response_matches_spec([], 'GET', '/nonexistent', res);
			assert.fail('expected error');
		} catch (error) {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes('No route spec found'));
		}
	});
});
