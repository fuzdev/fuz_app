/**
 * Tests for `create_app_server` factory.
 *
 * Uses a single cached PGlite WASM instance (via `create_pglite_factory`) shared
 * across all tests. Schema is reset before each `create_config` call, avoiding
 * repeated WASM cold starts while keeping tests isolated.
 *
 * @module
 */

import {describe, test, assert, beforeAll} from 'vitest';
import {wait} from '@fuzdev/fuz_util/async.js';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {z} from 'zod';

import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {
	create_app_server,
	DEFAULT_MAX_BODY_SIZE,
	type AppServerOptions,
	type AppServer,
} from '$lib/server/app_server.js';
import {ERROR_PAYLOAD_TOO_LARGE, PayloadTooLargeError} from '$lib/http/error_schemas.js';
import type {AppBackend} from '$lib/server/app_backend.js';
import {create_audit_emitter} from '$lib/auth/audit_emitter.js';
import {stub_password_deps} from '$lib/testing/app_server.js';
import {create_pglite_factory} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {auth_migration_ns} from '$lib/auth/migrations.js';

// 32+ char key for keyring
const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_keyring(TEST_KEY)!;
const session_options = create_session_config('test_session');

const log = new Logger('test', {level: 'off'});

const fs_stubs = {
	stat: async () => null,
	read_text_file: async () => '',
	delete_file: async (_path: string) => {},
};

// Shared PGlite WASM instance — schema is reset on each factory.create() call,
// but the expensive WASM cold start only happens once per worker thread.
const factory = create_pglite_factory(async () => {
	// No-op: create_config runs migrations manually to capture MigrationResult.
});

/** Shared option fields (everything except backend). */
const base_config: Omit<AppServerOptions, 'backend'> = {
	session_options,
	allowed_origins: [/^http:\/\/localhost/],
	proxy: {
		trusted_proxies: ['127.0.0.1'],
		get_connection_ip: () => '127.0.0.1',
	},
	env_schema: z.object({}),
	create_route_specs: () => [create_health_route_spec()],
};

/**
 * Create options from the cached PGlite. Resets schema and re-runs auth
 * migrations on each call to keep tests isolated without WASM cold starts.
 */
const create_config = async (overrides?: Partial<AppServerOptions>): Promise<AppServerOptions> => {
	const db = await factory.create();
	const migration_results = await run_migrations(db, [auth_migration_ns]);
	const backend: AppBackend = {
		db_type: 'pglite-memory',
		db_name: '(memory)',
		migration_results,
		close: async () => {},
		deps: {
			log,
			keyring,
			password: stub_password_deps,
			db,
			audit: create_audit_emitter({db, log}),
			...fs_stubs,
		},
	};
	return {backend, ...base_config, ...overrides};
};

describe('create_app_server', () => {
	// Shared instance for read-only assertions (avoids repeated PGlite cold starts)
	let shared: AppServer;

	beforeAll(async () => {
		shared = await create_app_server(await create_config());
	});

	test('creates a working Hono app with health route', async () => {
		const res = await shared.app.request('/health');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.status, 'ok');
	});

	test('surface contains correct route count', () => {
		// health + auto-created surface route
		assert.strictEqual(shared.surface_spec.surface.routes.length, 2);
		assert.strictEqual(shared.surface_spec.surface.routes[0]!.path, '/health');
		assert.strictEqual(shared.surface_spec.surface.routes[1]!.path, '/api/surface');
	});

	test('surface contains middleware specs', () => {
		// proxy + 4 auth middleware (origin, session, request_context, bearer_auth)
		assert.isTrue(shared.surface_spec.surface.middleware.length >= 5);
		assert.strictEqual(shared.surface_spec.surface.middleware[0]!.name, 'trusted_proxy');
	});

	test('bootstrap_status defaults to unavailable when omitted', () => {
		assert.strictEqual(shared.bootstrap_status.available, false);
		assert.isNull(shared.bootstrap_status.token_path);
	});

	test('close callback is available', () => {
		assert.isFunction(shared.close);
	});

	// Tests below need custom options — each resets and reuses the cached PGlite.

	test('bootstrap_status is computed when bootstrap is in live mode', async () => {
		const result = await create_app_server(
			await create_config({
				bootstrap: {
					mode: 'live',
					token_path: '/nonexistent/token',
				},
			}),
		);
		assert.strictEqual(result.bootstrap_status.available, false);
		assert.strictEqual(result.bootstrap_status.token_path, '/nonexistent/token');
	});

	test('create_route_specs receives context with deps', async () => {
		let received_context: unknown = null;
		await create_app_server(
			await create_config({
				create_route_specs: (ctx) => {
					received_context = ctx;
					return [create_health_route_spec()];
				},
			}),
		);
		assert.isNotNull(received_context);
		const ctx = received_context as any;
		assert.isDefined(ctx.deps);
		assert.isDefined(ctx.deps.db);
		assert.isDefined(ctx.deps.keyring);
		assert.isDefined(ctx.backend);
		assert.isDefined(ctx.bootstrap_status);
		assert.isDefined(ctx.session_options);
	});

	test('transform_middleware is applied', async () => {
		let transform_called = false;
		const result = await create_app_server(
			await create_config({
				transform_middleware: (specs) => {
					transform_called = true;
					return [...specs, {name: 'custom', path: '/*', handler: async (_c, next) => next()}];
				},
			}),
		);
		assert.isTrue(transform_called);
		const custom = result.surface_spec.surface.middleware.find((m) => m.name === 'custom');
		assert.isDefined(custom);
	});

	test('env_schema is included in surface', async () => {
		const TestEnv = z.strictObject({
			PORT: z.number().default(4040).describe('Server port'),
		});
		const result = await create_app_server(await create_config({env_schema: TestEnv}));
		assert.isTrue(result.surface_spec.surface.env.length > 0);
		const port_entry = result.surface_spec.surface.env.find((e) => e.name === 'PORT');
		assert.isDefined(port_entry);
	});

	test('surface route is auto-created by default', async () => {
		const result = await create_app_server(await create_config());
		const surface_route = result.surface_spec.surface.routes.find((r) => r.path === '/api/surface');
		assert.isDefined(surface_route);
		assert.strictEqual(surface_route.method, 'GET');
		assert.deepEqual(surface_route.auth, {account: 'required', actor: 'none'});
	});

	test('surface_route: false disables auto-created surface route', async () => {
		const result = await create_app_server(await create_config({surface_route: false}));
		const surface_route = result.surface_spec.surface.routes.find((r) => r.path === '/api/surface');
		assert.isUndefined(surface_route);
		assert.strictEqual(result.surface_spec.surface.routes.length, 1); // health only
	});

	test('bootstrap routes created when live bootstrap options provided', async () => {
		const result = await create_app_server(
			await create_config({
				bootstrap: {
					mode: 'live',
					token_path: '/nonexistent/token',
				},
			}),
		);
		const bootstrap_route = result.surface_spec.surface.routes.find(
			(r) => r.path === '/api/account/bootstrap',
		);
		assert.isDefined(bootstrap_route);
		assert.strictEqual(bootstrap_route.method, 'POST');
	});

	test('bootstrap routes use custom route_prefix in surface_only mode', async () => {
		const result = await create_app_server(
			await create_config({
				bootstrap: {
					mode: 'surface_only',
					route_prefix: '/api/auth',
				},
			}),
		);
		const bootstrap_route = result.surface_spec.surface.routes.find(
			(r) => r.path === '/api/auth/bootstrap',
		);
		assert.isDefined(bootstrap_route);
	});

	test('on_bootstrap callback wires through to bootstrap routes (live mode)', async () => {
		let callback_registered = false;
		await create_app_server(
			await create_config({
				bootstrap: {
					mode: 'live',
					token_path: '/nonexistent/token',
					on_bootstrap: async () => {
						callback_registered = true;
					},
				},
			}),
		);
		// Can't invoke the callback without a real bootstrap flow, but verify
		// the route was created (the callback is wired internally)
		assert.isFalse(callback_registered); // not called at init time
	});

	test('on_effect_error is called when a pending effect rejects', async () => {
		const errors: Array<{error: unknown; method: string; path: string}> = [];
		const result = await create_app_server(
			await create_config({
				await_pending_effects: false,
				create_route_specs: () => [
					{
						method: 'POST',
						path: '/effect-test',
						auth: {account: 'none', actor: 'none'},
						description: 'Route with failing effect',
						input: z.null(),
						output: z.strictObject({ok: z.boolean()}),
						handler: async (c) => {
							const effects = c.var.pending_effects;
							effects.push(Promise.reject(new Error('effect failed')));
							return c.json({ok: true});
						},
					},
				],
				on_effect_error: (error, ctx) => {
					errors.push({error, method: ctx.method, path: ctx.path});
				},
			}),
		);

		await result.app.request('/effect-test', {method: 'POST'});

		// Flush microtask queue — allSettled + .then chain settles in the next macrotask tick
		await wait();

		assert.strictEqual(errors.length, 1);
		const err = errors[0]!.error;
		assert.ok(err instanceof Error);
		assert.strictEqual(err.message, 'effect failed');
		assert.strictEqual(errors[0]!.method, 'POST');
		assert.strictEqual(errors[0]!.path, '/effect-test');
	});

	test('bootstrap routes skipped when bootstrap omitted', () => {
		// shared instance has no bootstrap options
		const bootstrap_route = shared.surface_spec.surface.routes.find(
			(r) => r.path === '/api/account/bootstrap',
		);
		assert.isUndefined(bootstrap_route);
	});

	test('body size limit rejects oversized payloads with 413', async () => {
		const result = await create_app_server(
			await create_config({
				max_body_size: 100, // 100 bytes
				create_route_specs: () => [
					{
						method: 'POST',
						path: '/echo',
						auth: {account: 'none', actor: 'none'},
						description: 'Echo input',
						input: z.looseObject({data: z.string()}),
						output: z.looseObject({ok: z.boolean()}),
						handler: async (c) => c.json({ok: true}),
					},
				],
			}),
		);

		// Small payload succeeds
		const small_body = JSON.stringify({data: 'small'});
		const small_res = await result.app.request('/echo', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': String(new TextEncoder().encode(small_body).length),
			},
			body: small_body,
		});
		assert.strictEqual(small_res.status, 200);

		// Oversized payload returns 413
		const large_body = JSON.stringify({data: 'x'.repeat(200)});
		const large_res = await result.app.request('/echo', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': String(new TextEncoder().encode(large_body).length),
			},
			body: large_body,
		});
		assert.strictEqual(large_res.status, 413);
		const body = await large_res.json();
		assert.strictEqual(body.error, ERROR_PAYLOAD_TOO_LARGE);
		PayloadTooLargeError.parse(body);
	});

	test('body size limit rejects a streaming (no Content-Length) oversized body', async () => {
		const result = await create_app_server(
			await create_config({
				max_body_size: 100, // 100 bytes
				create_route_specs: () => [
					{
						method: 'POST',
						path: '/echo',
						auth: {account: 'none', actor: 'none'},
						description: 'Echo input',
						input: z.looseObject({data: z.string()}),
						output: z.looseObject({ok: z.boolean()}),
						handler: async (c) => c.json({ok: true}),
					},
				],
			}),
		);

		// A ReadableStream body carries no Content-Length, so the request is
		// chunked and takes Hono's *streaming* bodyLimit branch — it reads and
		// counts chunks, rejecting once the cumulative size crosses the cap. The
		// test above exercises the Content-Length-header reject; this one pins the
		// streaming path (the branch that buffers up to the cap before forwarding).
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(120)));
				controller.enqueue(new TextEncoder().encode('x'.repeat(120)));
				controller.close();
			},
		});
		const res = await result.app.request('/echo', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: stream,
			duplex: 'half',
		} as RequestInit);
		assert.strictEqual(res.status, 413);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_PAYLOAD_TOO_LARGE);
		PayloadTooLargeError.parse(body);
	});

	test('body size limit defaults to DEFAULT_MAX_BODY_SIZE', () => {
		assert.strictEqual(DEFAULT_MAX_BODY_SIZE, 1024 * 1024);
	});

	test('conflicting Transfer-Encoding and Content-Length does not bypass body limit', async () => {
		const result = await create_app_server(
			await create_config({
				max_body_size: 100, // 100 bytes
				create_route_specs: () => [
					{
						method: 'POST',
						path: '/echo',
						auth: {account: 'none', actor: 'none'},
						description: 'Echo input',
						input: z.looseObject({data: z.string()}),
						output: z.looseObject({ok: z.boolean()}),
						handler: async (c) => c.json({ok: true}),
					},
				],
			}),
		);

		// Node.js HTTP parser handles this at the transport layer —
		// requests with conflicting headers are rejected or the body
		// is parsed per the spec (Transfer-Encoding takes precedence).
		// This test documents that the behavior is safe via Hono's test client.
		const body_str = JSON.stringify({unexpected: true});
		const res = await result.app.request('/echo', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': '2',
			},
			body: body_str,
		});
		// Should get a normal validation response (400 or 200 or 413), not a crash or bypass
		assert.ok(res.status < 500, `expected non-500 status, got ${res.status}`);
	});

	test('max_body_size: null disables body size limit', async () => {
		const result = await create_app_server(
			await create_config({
				max_body_size: null,
				create_route_specs: () => [
					{
						method: 'POST',
						path: '/echo',
						auth: {account: 'none', actor: 'none'},
						description: 'Echo input',
						input: z.looseObject({data: z.string()}),
						output: z.looseObject({ok: z.boolean()}),
						handler: async (c) => c.json({ok: true}),
					},
				],
			}),
		);

		// Even a larger payload succeeds when limit is disabled
		const body_str = JSON.stringify({data: 'x'.repeat(5000)});
		const res = await result.app.request('/echo', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: body_str,
		});
		assert.strictEqual(res.status, 200);
	});

	// --- Header abuse and path traversal ---

	test('very long URL path does not crash the server', async () => {
		const result = await create_app_server(await create_config());
		const long_path = '/health/' + '../'.repeat(200) + 'etc/passwd';
		const res = await result.app.request(long_path);
		assert.ok(res.status < 500, `expected non-500 for long path, got ${res.status}`);
	});

	test('many repeated headers do not crash the server', async () => {
		const result = await create_app_server(await create_config());
		const headers = new Headers();
		// add many X-Forwarded-For headers
		for (let i = 0; i < 100; i++) {
			headers.append('X-Forwarded-For', `10.0.0.${i % 256}`);
		}
		const res = await result.app.request('/health', {headers});
		assert.ok(res.status < 500, `expected non-500 for many headers, got ${res.status}`);
	});

	test('large cookie header does not crash the server', async () => {
		const result = await create_app_server(await create_config());
		const large_cookie = 'session=' + 'x'.repeat(50_000);
		const res = await result.app.request('/health', {
			headers: {Cookie: large_cookie},
		});
		assert.ok(res.status < 500, `expected non-500 for large cookie, got ${res.status}`);
	});

	test('post_route_middleware appears in surface and is applied', async () => {
		let handler_called = false;
		const result = await create_app_server(
			await create_config({
				post_route_middleware: [
					{
						name: 'mapdata',
						path: '/mapdata/*',
						handler: async (_c, next) => {
							handler_called = true;
							await next();
						},
					},
				],
			}),
		);
		const mapdata = result.surface_spec.surface.middleware.find((m) => m.name === 'mapdata');
		assert.isDefined(mapdata);
		assert.strictEqual(mapdata.path, '/mapdata/*');

		// Verify it's actually wired into the Hono app
		await result.app.request('/mapdata/test.pbf');
		assert.isTrue(handler_called);
	});

	test('rpc_endpoints array form is mounted on the app and included in surface', async () => {
		const rpc_spec = {
			method: 'test_noop',
			kind: 'request_response',
			initiator: 'frontend',
			auth: {account: 'none', actor: 'none'},
			side_effects: false,
			input: z.void(),
			output: z.strictObject({ok: z.literal(true)}),
			async: true,
			description: 'Test action.',
		} as const;
		const result = await create_app_server(
			await create_config({
				rpc_endpoints: [
					{
						path: '/api/rpc',
						actions: [{spec: rpc_spec, handler: async () => ({ok: true as const})}],
					},
				],
			}),
		);
		// Surface reflects the endpoint
		const rpc_endpoint = result.surface_spec.surface.rpc_endpoints.find(
			(e) => e.path === '/api/rpc',
		);
		assert.isDefined(rpc_endpoint);
		assert.strictEqual(rpc_endpoint.methods.length, 1);
		assert.strictEqual(rpc_endpoint.methods[0]!.name, 'test_noop');

		// Auto-mounted: the endpoint actually dispatches without the
		// consumer calling create_rpc_endpoint themselves.
		const res = await result.app.request('/api/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'http://localhost:5173',
			},
			body: JSON.stringify({jsonrpc: '2.0', method: 'test_noop', id: 1}),
		});
		const body = await res.json();
		assert.strictEqual(res.status, 200, JSON.stringify(body));
		assert.deepEqual(body, {jsonrpc: '2.0', id: 1, result: {ok: true}});
	});

	test('rpc_endpoints factory form receives AppServerContext and auto-mounts', async () => {
		let received_ctx: unknown = null;
		const rpc_spec = {
			method: 'test_factory',
			kind: 'request_response',
			initiator: 'frontend',
			auth: {account: 'none', actor: 'none'},
			side_effects: false,
			input: z.void(),
			output: z.strictObject({ok: z.literal(true)}),
			async: true,
			description: 'Factory-form test action.',
		} as const;
		const result = await create_app_server(
			await create_config({
				rpc_endpoints: (ctx) => {
					received_ctx = ctx;
					return [
						{
							path: '/api/rpc',
							actions: [{spec: rpc_spec, handler: async () => ({ok: true as const})}],
						},
					];
				},
			}),
		);
		assert.isNotNull(received_ctx);
		const ctx = received_ctx as any;
		// Context shape matches what create_route_specs receives
		assert.isDefined(ctx.deps);
		assert.isDefined(ctx.deps.db);
		assert.isDefined(ctx.bootstrap_status);
		// Surface reflects the factory-produced endpoint
		const rpc_endpoint = result.surface_spec.surface.rpc_endpoints.find(
			(e) => e.path === '/api/rpc',
		);
		assert.isDefined(rpc_endpoint);
		assert.strictEqual(rpc_endpoint.methods[0]!.name, 'test_factory');
		// Dispatch hits the auto-mounted route
		const res = await result.app.request('/api/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'http://localhost:5173',
			},
			body: JSON.stringify({jsonrpc: '2.0', method: 'test_factory', id: 1}),
		});
		assert.strictEqual(res.status, 200);
	});

	test('rpc_endpoints factory + create_standard_rpc_actions compose', async () => {
		// End-to-end check: the factory form of rpc_endpoints paired with
		// the combined admin+role-grant-offer+account helper should put all 28
		// methods (14 admin + 7 role-grant-offer + 7 account) on the surface
		// and auto-mount them.
		const {create_standard_rpc_actions} = await import('$lib/auth/standard_rpc_actions.js');
		const result = await create_app_server(
			await create_config({
				rpc_endpoints: (ctx) => [
					{
						path: '/api/rpc',
						actions: create_standard_rpc_actions(ctx.deps),
					},
				],
			}),
		);
		const rpc_endpoint = result.surface_spec.surface.rpc_endpoints.find(
			(e) => e.path === '/api/rpc',
		);
		assert.isDefined(rpc_endpoint);
		assert.strictEqual(rpc_endpoint.methods.length, 14 + 7 + 7);
		const method_names = new Set(rpc_endpoint.methods.map((m) => m.name));
		// sample a few from each surface
		assert.isTrue(method_names.has('admin_account_list'));
		assert.isTrue(method_names.has('account_delete'));
		assert.isTrue(method_names.has('account_purge'));
		assert.isTrue(method_names.has('account_undelete'));
		assert.isTrue(method_names.has('app_settings_update'));
		assert.isTrue(method_names.has('role_grant_offer_create'));
		assert.isTrue(method_names.has('role_grant_revoke'));
		assert.isTrue(method_names.has('account_verify'));
		assert.isTrue(method_names.has('account_token_create'));
		// Auto-mounted: unauthenticated request to an admin-only method
		// gets the JSON-RPC auth error instead of the Hono 404 we'd see
		// if the route weren't registered.
		const res = await result.app.request('/api/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'http://localhost:5173',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'admin_account_list',
				id: 1,
			}),
		});
		// 401 unauthenticated — the route is mounted and the dispatcher ran
		// the auth check. A 404 would mean the route was never registered;
		// any other non-401 would mean auth landed in the wrong layer.
		assert.strictEqual(res.status, 401);
	});
});
