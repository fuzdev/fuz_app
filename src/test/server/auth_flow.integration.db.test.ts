/**
 * Integration tests for the full auth pipeline end-to-end.
 *
 * Exercises: HTTP request → proxy → origin → session cookie →
 * request context → permit check → handler → correct response.
 *
 * Uses a single `create_test_app_server` instance shared across
 * all read-only tests to avoid repeated PGlite cold starts.
 *
 * @module
 */

import {describe, test, assert, beforeAll, afterAll} from 'vitest';
import {z} from 'zod';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {require_request_context} from '$lib/auth/request_context.js';
import {create_app_server, type AppServerOptions, type AppServer} from '$lib/server/app_server.js';
import {create_test_app_server, type TestAppServer} from '$lib/testing/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import {ROLE_KEEPER, ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '$lib/http/error_schemas.js';

const session_options = create_session_config('test_session');

/** Route that requires any authenticated user. */
const create_authenticated_route_spec = (): RouteSpec => ({
	method: 'GET',
	path: '/api/me',
	auth: {type: 'authenticated'},
	description: 'Return current account info',
	input: z.null(),
	output: z.looseObject({username: z.string(), actor_id: z.string()}),
	handler: (c) => {
		const ctx = require_request_context(c);
		return c.json({username: ctx.account.username, actor_id: ctx.actor.id});
	},
});

/** Route that requires the keeper role. */
const create_keeper_route_spec = (): RouteSpec => ({
	method: 'GET',
	path: '/api/keeper-only',
	auth: {type: 'role', role: ROLE_KEEPER},
	description: 'Keeper-only endpoint',
	input: z.null(),
	output: z.looseObject({ok: z.literal(true)}),
	handler: (c) => c.json({ok: true as const}),
});

/** Route that requires the admin role. */
const create_admin_route_spec = (): RouteSpec => ({
	method: 'GET',
	path: '/api/admin-only',
	auth: {type: 'role', role: ROLE_ADMIN},
	description: 'Admin-only endpoint',
	input: z.null(),
	output: z.looseObject({ok: z.literal(true)}),
	handler: (c) => c.json({ok: true as const}),
});

describe('auth flow integration', () => {
	let test_server: TestAppServer;
	let result: AppServer;

	beforeAll(async () => {
		// Bootstrap a test server with keeper + admin roles
		test_server = await create_test_app_server({
			session_options,
			roles: [ROLE_KEEPER, ROLE_ADMIN],
		});

		const base_config = {
			session_options,
			allowed_origins: [/^http:\/\/localhost/],
			proxy: {
				trusted_proxies: ['127.0.0.1'],
				get_connection_ip: () => '127.0.0.1',
			},
			create_route_specs: () => [
				create_health_route_spec(),
				create_authenticated_route_spec(),
				create_keeper_route_spec(),
				create_admin_route_spec(),
			],
		};

		const options: AppServerOptions = {
			backend: test_server,
			...base_config,
			env_schema: z.object({}),
		};

		result = await create_app_server(options);
	});

	afterAll(async () => {
		await test_server.cleanup();
	});

	// --- (a) Public route returns 200 without auth ---

	test('public health route returns 200 without any auth', async () => {
		const res = await result.app.request('/health');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.status, 'ok');
	});

	// --- (b) Authenticated route with valid session cookie returns 200 ---

	test('authenticated route with valid session cookie returns 200 with correct context', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Cookie: `test_session=${test_server.session_cookie}`,
			},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.username, test_server.account.username);
		assert.strictEqual(body.actor_id, test_server.actor.id);
	});

	// --- (c) Authenticated route without session cookie returns 401 ---

	test('authenticated route without session cookie returns 401', async () => {
		const res = await result.app.request('/api/me');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	// --- (d) Role-guarded route with correct role returns 200 ---

	test('keeper route with keeper role returns 200', async () => {
		const res = await result.app.request('/api/keeper-only', {
			headers: {
				Cookie: `test_session=${test_server.session_cookie}`,
			},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('admin route with admin role returns 200', async () => {
		const res = await result.app.request('/api/admin-only', {
			headers: {
				Cookie: `test_session=${test_server.session_cookie}`,
			},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	// --- (e) Role-guarded route with wrong role returns 403 ---

	describe('role-guarded route with wrong role', () => {
		let non_keeper_server: TestAppServer;
		let non_keeper_result: AppServer;

		beforeAll(async () => {
			// Create a second account with only the admin role (no keeper)
			non_keeper_server = await create_test_app_server({
				session_options,
				db: test_server.deps.db,
				username: 'admin_only_user',
				roles: [ROLE_ADMIN],
			});

			const options: AppServerOptions = {
				backend: non_keeper_server,
				session_options,
				allowed_origins: [/^http:\/\/localhost/],
				proxy: {
					trusted_proxies: ['127.0.0.1'],
					get_connection_ip: () => '127.0.0.1',
				},
				env_schema: z.object({}),
				create_route_specs: () => [
					create_health_route_spec(),
					create_authenticated_route_spec(),
					create_keeper_route_spec(),
					create_admin_route_spec(),
				],
			};

			non_keeper_result = await create_app_server(options);
		});

		afterAll(async () => {
			await non_keeper_server.cleanup();
		});

		test('keeper route without keeper role returns 403', async () => {
			const res = await non_keeper_result.app.request('/api/keeper-only', {
				headers: {
					Cookie: `test_session=${non_keeper_server.session_cookie}`,
				},
			});
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
			assert.strictEqual(body.required_role, ROLE_KEEPER);
		});

		test('admin route with admin role still returns 200', async () => {
			const res = await non_keeper_result.app.request('/api/admin-only', {
				headers: {
					Cookie: `test_session=${non_keeper_server.session_cookie}`,
				},
			});
			assert.strictEqual(res.status, 200);
		});
	});

	// --- (f) Bearer token auth works for authenticated routes ---

	test('authenticated route with valid bearer token returns 200', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Authorization: `Bearer ${test_server.api_token}`,
			},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.username, test_server.account.username);
		assert.strictEqual(body.actor_id, test_server.actor.id);
	});

	test('authenticated route with invalid bearer token returns 401', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Authorization: 'Bearer secret_fuz_token_invalid',
			},
		});
		assert.strictEqual(res.status, 401);
	});

	test('invalid session cookie returns 401', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Cookie: 'test_session=invalid-cookie-value',
			},
		});
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('role-guarded route without any auth returns 401 not 403', async () => {
		const res = await result.app.request('/api/keeper-only');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	// --- (g) Malformed Authorization headers return 401 ---

	test('Authorization: Bearer with no token value returns 401', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Authorization: 'Bearer ',
			},
		});
		assert.strictEqual(res.status, 401);
	});

	test('Authorization: Basic scheme returns 401', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Authorization: 'Basic abc123',
			},
		});
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('Authorization without Bearer prefix returns 401', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Authorization: 'secret_fuz_token_abc',
			},
		});
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	// --- (h) Simultaneous cookie + bearer: cookie takes precedence ---

	test('simultaneous valid cookie and valid bearer uses cookie auth', async () => {
		const res = await result.app.request('/api/me', {
			headers: {
				Cookie: `test_session=${test_server.session_cookie}`,
				Authorization: `Bearer ${test_server.api_token}`,
			},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.username, test_server.account.username);
		assert.strictEqual(body.actor_id, test_server.actor.id);
	});

	// --- (i) Error response information leakage ---

	test('401 response does not leak stack traces or internal paths', async () => {
		const res = await result.app.request('/api/me', {
			headers: {Authorization: 'Bearer invalid_token_value'},
		});
		assert.strictEqual(res.status, 401);
		const text = await res.text();
		assert.ok(!text.includes('node_modules'), 'error should not contain node_modules paths');
		assert.ok(!text.includes('at '), 'error should not contain stack trace lines');
		assert.ok(!text.includes('.ts:'), 'error should not contain TypeScript file references');
	});
});
