/**
 * Tests for backend_route_spec.ts — introspectable route spec system.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	apply_middleware_specs,
	apply_route_specs,
	prefix_route_specs,
	get_route_query,
	type RouteSpec
} from '$lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '$lib/auth/auth_guard_resolver.ts';
import { ActingActor } from '$lib/http/auth_shape.ts';
import type { MiddlewareSpec } from '$lib/http/middleware_spec.ts';
import { generate_app_surface, events_to_surface } from '$lib/http/surface.ts';
import { middleware_applies, schema_to_surface } from '$lib/http/schema_helpers.ts';
import type { EventSpec } from '$lib/realtime/sse.ts';
import { REQUEST_CONTEXT_KEY } from '$lib/auth/request_context.ts';
import { ACCOUNT_ID_KEY, TEST_CONTEXT_PRESET_KEY } from '$lib/hono_context.ts';
import { create_test_request_context } from '$lib/testing/auth_apps.ts';
import { ApiError, RateLimitError } from '$lib/http/error_schemas.ts';
import { create_stub_db } from '$lib/testing/stubs.ts';
import {
	ThrownJsonrpcError,
	JSONRPC_ERROR_CODES,
	jsonrpc_errors
} from '$lib/http/jsonrpc_errors.ts';

const log = new Logger('test', { level: 'off' });
const db = create_stub_db();

describe('apply_route_specs', () => {
	test('registers a GET route', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ ok: true }),
				description: 'Test route',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('registers a POST route', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/create',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ created: true }),
				description: 'Create route',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/create', { method: 'POST' });
		assert.strictEqual(res.status, 200);
	});

	test('auth none adds no guard', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/public',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ public: true }),
				description: 'Public route',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/public');
		assert.strictEqual(res.status, 200);
	});

	test('auth authenticated returns 401 when unauthenticated', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/protected',
				auth: { account: 'required', actor: 'none' },
				handler: (c) => c.json({ secret: true }),
				description: 'Protected route',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/protected');
		assert.strictEqual(res.status, 401);
	});

	test('auth authenticated passes when authenticated', async () => {
		const app = new Hono();
		// Set request context before the route
		app.use('/*', async (c, next) => {
			const ctx = create_test_request_context();
			(c as any).set(ACCOUNT_ID_KEY, ctx.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, ctx);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/protected',
				auth: { account: 'required', actor: 'none' },
				handler: (c) => c.json({ secret: true }),
				description: 'Protected route',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/protected');
		assert.strictEqual(res.status, 200);
	});

	test('auth role returns 401 when unauthenticated', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/admin',
				auth: { account: 'required', actor: 'required', roles: ['admin'] },
				handler: (c) => c.json({ admin: true }),
				description: 'Admin route',
				query: z.strictObject({ acting: ActingActor }),
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/admin', { method: 'POST' });
		assert.strictEqual(res.status, 401);
	});

	test('auth role returns 403 when wrong role', async () => {
		const app = new Hono();
		app.use('/*', async (c, next) => {
			const ctx = create_test_request_context('viewer');
			(c as any).set(ACCOUNT_ID_KEY, ctx.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, ctx);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/admin',
				auth: { account: 'required', actor: 'required', roles: ['admin'] },
				handler: (c) => c.json({ admin: true }),
				description: 'Admin route',
				query: z.strictObject({ acting: ActingActor }),
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/admin', { method: 'POST' });
		assert.strictEqual(res.status, 403);
	});

	test('auth role passes with correct role', async () => {
		const app = new Hono();
		app.use('/*', async (c, next) => {
			const ctx = create_test_request_context('admin');
			(c as any).set(ACCOUNT_ID_KEY, ctx.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, ctx);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/admin',
				auth: { account: 'required', actor: 'required', roles: ['admin'] },
				handler: (c) => c.json({ admin: true }),
				description: 'Admin route',
				query: z.strictObject({ acting: ActingActor }),
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/admin', { method: 'POST' });
		assert.strictEqual(res.status, 200);
	});
});

describe('query validation', () => {
	test('validates query params and sets validated_query', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/search',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => {
					const q = get_route_query<{ q: string }>(c);
					return c.json({ query: q.q });
				},
				description: 'Search',
				query: z.strictObject({ q: z.string().min(1) }),
				input: z.null(),
				output: z.strictObject({ query: z.string() })
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/search?q=hello');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.query, 'hello');
	});

	test('returns 400 for missing required query param', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/search',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ ok: true }),
				description: 'Search',
				query: z.strictObject({ q: z.string().min(1) }),
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/search');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error, 'invalid_query_params');
	});

	test('returns 400 for extra unknown query param with strictObject', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/search',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ ok: true }),
				description: 'Search',
				query: z.strictObject({ q: z.string() }),
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/search?q=test&extra=bad');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error, 'invalid_query_params');
	});

	test('no query schema skips validation', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ ok: true }),
				description: 'Test',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test?anything=works');
		assert.strictEqual(res.status, 200);
	});
});

describe('apply_middleware_specs', () => {
	test('applies middleware to matching paths', async () => {
		const app = new Hono();
		let middleware_ran = false;
		const specs: Array<MiddlewareSpec> = [
			{
				name: 'test_mw',
				path: '/api/*',
				handler: async (_c, next) => {
					middleware_ran = true;
					await next();
				}
			}
		];
		apply_middleware_specs(app, specs);
		app.get('/api/test', (c) => c.json({ ok: true }));

		await app.request('/api/test');
		assert.strictEqual(middleware_ran, true);
	});
});

describe('prefix_route_specs', () => {
	test('prepends prefix to all paths', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/list',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'List items',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'POST',
				path: '/create',
				auth: { account: 'required', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'Create item',
				input: z.null(),
				output: z.null()
			}
		];

		const prefixed = prefix_route_specs('/api/items', specs);
		assert.strictEqual(prefixed[0]!.path, '/api/items/list');
		assert.strictEqual(prefixed[1]!.path, '/api/items/create');
	});

	test('uses prefix as path for root routes', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'Root route',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'GET',
				path: '/:id',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'Sub route',
				input: z.null(),
				output: z.null()
			}
		];

		const prefixed = prefix_route_specs('/api/items', specs);
		assert.strictEqual(prefixed[0]!.path, '/api/items');
		assert.strictEqual(prefixed[1]!.path, '/api/items/:id');
	});

	test('preserves other spec properties', () => {
		const handler = (c: any) => c.json({});
		const specs: Array<RouteSpec> = [
			{
				method: 'DELETE',
				path: '/:id',
				auth: {
					account: 'required',
					actor: 'required',
					roles: ['keeper'],
					credential_types: ['daemon_token']
				},
				handler,
				description: 'Delete item',
				input: z.null(),
				output: z.null()
			}
		];

		const prefixed = prefix_route_specs('/items', specs);
		assert.strictEqual(prefixed[0]!.method, 'DELETE');
		assert.deepStrictEqual(prefixed[0]!.auth, {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token']
		});
		assert.strictEqual(prefixed[0]!.handler, handler);
		assert.strictEqual(prefixed[0]!.description, 'Delete item');
	});

	test('throws on duplicate method+path', () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/items',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ first: true }),
				description: 'First',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'GET',
				path: '/items',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ second: true }),
				description: 'Second',
				input: z.null(),
				output: z.null()
			}
		];
		assert.throws(
			() => apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db),
			/Duplicate route: GET \/items/
		);
	});

	test('duplicate detection fires before invariant-2 check when both apply', () => {
		// First spec valid (declares `acting?: ActingActor` on query, as
		// keeper db routes do); second spec is its duplicate AND violates
		// invariant 2 (acting slot missing). The duplicate-route error is
		// the actionable signal — the operator registered the same path
		// twice and the second copy drifted. Reporting the biconditional
		// throw first would send them chasing a schema-shape problem in
		// the second spec when the real fix is to drop the duplicate
		// registration. Pins the ordering inside `apply_route_specs`.
		const app = new Hono();
		const keeper_auth = {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token']
		} as const;
		const valid_spec: RouteSpec = {
			method: 'GET',
			path: '/items',
			auth: keeper_auth,
			handler: (c) => c.json({ ok: true }),
			description: 'Valid keeper spec',
			input: z.null(),
			query: z.strictObject({ acting: ActingActor }),
			output: z.null()
		};
		const violating_duplicate: RouteSpec = {
			...valid_spec,
			query: undefined,
			description: 'Duplicate of valid_spec, missing acting'
		};
		assert.throws(
			() =>
				apply_route_specs(app, [valid_spec, violating_duplicate], fuz_auth_guard_resolver, log, db),
			/Duplicate route: GET \/items/
		);
	});

	test('allows same path with different methods', () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/items',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ ok: true }),
				description: 'Get items',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'POST',
				path: '/items',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ ok: true }),
				description: 'Create item',
				input: z.null(),
				output: z.null()
			}
		];
		// should not throw
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	});
});

describe('prefix_route_specs immutability', () => {
	test('does not mutate original specs', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'Test route',
				input: z.null(),
				output: z.null()
			}
		];

		prefix_route_specs('/prefix', specs);
		assert.strictEqual(specs[0]!.path, '/test');
	});
});

describe('middleware_applies', () => {
	test('exact match', () => {
		assert.strictEqual(middleware_applies('/health', '/health'), true);
	});

	test('wildcard matches nested paths', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api/test'), true);
		assert.strictEqual(middleware_applies('/api/*', '/api/deep/nested'), true);
	});

	test('wildcard matches base path', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api'), true);
	});

	test('wildcard does not match unrelated paths', () => {
		assert.strictEqual(middleware_applies('/api/*', '/health'), false);
		assert.strictEqual(middleware_applies('/api/zap/*', '/api/account/login'), false);
	});

	test('non-matching paths', () => {
		assert.strictEqual(middleware_applies('/api', '/health'), false);
	});

	test('bare star matches everything', () => {
		assert.strictEqual(middleware_applies('*', '/anything'), true);
		assert.strictEqual(middleware_applies('*', '/api/deep/path'), true);
	});
});

describe('generate_app_surface', () => {
	test('includes all routes with correct middleware matching', () => {
		const middleware: Array<MiddlewareSpec> = [
			{ name: 'origin', path: '/api/*', handler: async (_c, next) => next() },
			{ name: 'session', path: '/api/*', handler: async (_c, next) => next() }
		];
		const routes: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/health',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'Health check',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'POST',
				path: '/api/login',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'Login',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'GET',
				path: '/api/protected',
				auth: { account: 'required', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'Protected resource',
				input: z.null(),
				output: z.null()
			}
		];

		const surface = generate_app_surface({ middleware_specs: middleware, route_specs: routes });

		assert.strictEqual(surface.middleware.length, 2);
		assert.strictEqual(surface.routes.length, 3);

		// Health route has no middleware
		assert.deepStrictEqual(surface.routes[0]!.applicable_middleware, []);
		assert.strictEqual(surface.routes[0]!.description, 'Health check');

		// API routes have both middleware
		assert.deepStrictEqual(surface.routes[1]!.applicable_middleware, ['origin', 'session']);
		assert.deepStrictEqual(surface.routes[2]!.applicable_middleware, ['origin', 'session']);
	});

	test('is JSON-serializable', () => {
		const middleware: Array<MiddlewareSpec> = [
			{ name: 'test', path: '/*', handler: async (_c, next) => next() }
		];
		const routes: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'required', actor: 'required', roles: ['admin'] },
				handler: (c) => c.json({}),
				description: 'Test route',
				input: z.null(),
				output: z.null()
			}
		];

		const surface = generate_app_surface({ middleware_specs: middleware, route_specs: routes });
		const json = JSON.stringify(surface);
		const parsed = JSON.parse(json);
		assert.deepStrictEqual(parsed, surface);
	});

	test('description is always included in surface', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				{
					method: 'GET',
					path: '/test',
					auth: { account: 'none', actor: 'none' },
					handler: (c) => c.json({}),
					description: 'Test endpoint',
					input: z.null(),
					output: z.null()
				}
			]
		});

		assert.strictEqual(surface.routes[0]!.description, 'Test endpoint');
	});

	test('auth types are preserved', () => {
		const routes: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/a',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'A',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'GET',
				path: '/b',
				auth: { account: 'required', actor: 'none' },
				handler: (c) => c.json({}),
				description: 'B',
				input: z.null(),
				output: z.null()
			},
			{
				method: 'GET',
				path: '/c',
				auth: {
					account: 'required',
					actor: 'required',
					roles: ['keeper'],
					credential_types: ['daemon_token']
				},
				handler: (c) => c.json({}),
				description: 'C',
				input: z.null(),
				output: z.null()
			}
		];

		const surface = generate_app_surface({ middleware_specs: [], route_specs: routes });
		assert.deepStrictEqual(surface.routes[0]!.auth, { account: 'none', actor: 'none' });
		assert.deepStrictEqual(surface.routes[1]!.auth, { account: 'required', actor: 'none' });
		assert.deepStrictEqual(surface.routes[2]!.auth, {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token']
		});
	});

	test('without options defaults env and events to empty arrays', () => {
		const surface = generate_app_surface({ middleware_specs: [], route_specs: [] });
		assert.deepStrictEqual(surface.env, []);
		assert.deepStrictEqual(surface.events, []);
	});

	test('with env_schema includes env in surface', () => {
		const schema = z.strictObject({
			PORT: z.coerce.number().default(4040).meta({ description: 'Port' }),
			SECRET: z.string().meta({ description: 'A secret', sensitivity: 'secret' })
		});
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [],
			env_schema: schema
		});
		assert.ok(surface.env);
		assert.strictEqual(surface.env.length, 2);
		assert.strictEqual(surface.env[0]!.name, 'PORT');
		assert.strictEqual(surface.env[1]!.sensitivity, 'secret');
	});

	test('with event_specs includes events in surface', () => {
		const specs: Array<EventSpec> = [
			{
				method: 'run_created',
				params: z.strictObject({ run_id: z.string() }),
				description: 'A run was created',
				channel: 'runs'
			}
		];
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [],
			event_specs: specs
		});
		assert.ok(surface.events);
		assert.strictEqual(surface.events.length, 1);
		assert.strictEqual(surface.events[0]!.method, 'run_created');
		assert.strictEqual(surface.events[0]!.channel, 'runs');
	});

	test('empty event_specs produces empty events array', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [],
			event_specs: []
		});
		assert.deepStrictEqual(surface.events, []);
	});

	test('extended surface is JSON-serializable', () => {
		const env_schema = z.strictObject({
			PORT: z.coerce.number().default(4040).meta({ description: 'Port' })
		});
		const event_specs: Array<EventSpec> = [
			{
				method: 'test',
				params: z.strictObject({ id: z.string() }),
				description: 'Test event'
			}
		];
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [],
			env_schema,
			event_specs
		});
		const json = JSON.stringify(surface);
		const parsed = JSON.parse(json);
		assert.deepStrictEqual(parsed, surface);
	});

	test('auth none + no input has null error_schemas', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				{
					method: 'GET',
					path: '/health',
					auth: { account: 'none', actor: 'none' },
					handler: (c) => c.json({}),
					description: 'Health',
					input: z.null(),
					output: z.null()
				}
			]
		});
		assert.strictEqual(surface.routes[0]!.error_schemas, null);
	});

	test('authenticated route auto-derives 401 error schema', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				{
					method: 'GET',
					path: '/protected',
					auth: { account: 'required', actor: 'none' },
					handler: (c) => c.json({}),
					description: 'Protected',
					input: z.null(),
					output: z.null()
				}
			]
		});
		const errors = surface.routes[0]!.error_schemas;
		assert.ok(errors);
		assert.ok(errors['401']);
	});

	test('role route auto-derives 401 and 403 error schemas', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				{
					method: 'POST',
					path: '/admin',
					auth: { account: 'required', actor: 'required', roles: ['admin'] },
					handler: (c) => c.json({}),
					description: 'Admin',
					input: z.null(),
					output: z.null()
				}
			]
		});
		const errors = surface.routes[0]!.error_schemas;
		assert.ok(errors);
		assert.ok(errors['401']);
		assert.ok(errors['403']);
	});

	test('route with input auto-derives 400 error schema', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				{
					method: 'POST',
					path: '/create',
					auth: { account: 'none', actor: 'none' },
					handler: (c) => c.json({}),
					description: 'Create',
					input: z.strictObject({ name: z.string() }),
					output: z.null()
				}
			]
		});
		const errors = surface.routes[0]!.error_schemas;
		assert.ok(errors);
		assert.ok(errors['400']);
	});

	test('explicit errors override auto-derived for same status', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				{
					method: 'POST',
					path: '/login',
					auth: { account: 'none', actor: 'none' },
					handler: (c) => c.json({}),
					description: 'Login',
					input: z.strictObject({ username: z.string() }),
					output: z.null(),
					errors: { 401: ApiError, 429: RateLimitError }
				}
			]
		});
		const errors = surface.routes[0]!.error_schemas;
		assert.ok(errors);
		// Has both auto-derived 400 and explicit 401, 429
		assert.ok(errors['400']);
		assert.ok(errors['401']);
		assert.ok(errors['429']);
	});

	test('error_schemas are JSON-serializable', () => {
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [
				{
					method: 'POST',
					path: '/test',
					auth: { account: 'required', actor: 'required', roles: ['admin'] },
					handler: (c) => c.json({}),
					description: 'Test',
					input: z.strictObject({ x: z.number() }),
					output: z.null(),
					errors: { 429: RateLimitError }
				}
			]
		});
		const json = JSON.stringify(surface);
		const parsed = JSON.parse(json);
		assert.deepStrictEqual(parsed, surface);
	});
});

describe('input validation', () => {
	const create_input_app = () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				description: 'content type test',
				input: z.strictObject({ name: z.string() }),
				output: z.strictObject({ ok: z.literal(true) }),
				handler: async (c) => c.json({ ok: true })
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
		return app;
	};

	test('rejects non-JSON content type on input route', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: 'not json'
		});
		assert.ok(res.status === 400 || res.status === 415, `expected 400 or 415, got ${res.status}`);
	});

	test('rejects application/x-www-form-urlencoded', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=test'
		});
		assert.ok(res.status < 500, `expected non-500, got ${res.status}`);
		assert.ok(
			res.status === 400 || res.status === 415,
			`expected 400 or 415 for form-urlencoded, got ${res.status}`
		);
	});

	test('rejects POST with no Content-Type header', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			body: JSON.stringify({ name: 'test' })
		});
		// without Content-Type, json() parsing may fail — should get 400 not 500
		assert.ok(res.status < 500, `expected non-500, got ${res.status}`);
	});

	test('accepts application/json with charset', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({ name: 'test' })
		});
		assert.strictEqual(res.status, 200, 'application/json with charset should be accepted');
	});

	test('rejects multipart/form-data', async () => {
		const app = create_input_app();
		const boundary = '----boundary123';
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ntest\r\n--${
			boundary
		}--`;
		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
			body
		});
		assert.ok(res.status < 500, `expected non-500, got ${res.status}`);
		assert.ok(
			res.status === 400 || res.status === 415,
			`expected 400 or 415 for multipart, got ${res.status}`
		);
	});
});

describe('GET body validation guard', () => {
	test('GET route with non-null input skips body parsing', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/items',
				auth: { account: 'none', actor: 'none' },
				description: 'List items',
				input: z.strictObject({ limit: z.number() }),
				output: z.strictObject({ ok: z.boolean() }),
				handler: (c) => c.json({ ok: true })
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		// GET with no body — should succeed (no body parse attempted)
		const res = await app.request('/items');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('GET route with null input still works', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/health',
				auth: { account: 'none', actor: 'none' },
				description: 'Health',
				input: z.null(),
				output: z.strictObject({ ok: z.boolean() }),
				handler: (c) => c.json({ ok: true })
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/health');
		assert.strictEqual(res.status, 200);
	});

	test('POST route with non-null input still validates body', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/create',
				auth: { account: 'none', actor: 'none' },
				description: 'Create',
				input: z.strictObject({ name: z.string() }),
				output: z.strictObject({ ok: z.boolean() }),
				handler: (c) => c.json({ ok: true })
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		// POST with invalid body — should get 400
		const res = await app.request('/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ wrong: 'field' })
		});
		assert.strictEqual(res.status, 400);
	});

	test('surface shows input_schema for GET route with non-null input', () => {
		const route: RouteSpec = {
			method: 'GET',
			path: '/items',
			auth: { account: 'none', actor: 'none' },
			description: 'List items',
			input: z.strictObject({ limit: z.number() }),
			output: z.strictObject({ ok: z.boolean() }),
			handler: (c: any) => c.json({ ok: true })
		};

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		// input_schema should be populated (not null) — surface reads from r.input directly
		assert.ok(surface.routes[0]!.input_schema);
	});
});

describe('schema_to_surface', () => {
	test('is exported and converts object schemas', () => {
		const result = schema_to_surface(z.strictObject({ name: z.string() }));
		assert.ok(result);
		assert.strictEqual(typeof result, 'object');
	});

	test('returns null for null schemas', () => {
		const result = schema_to_surface(z.null());
		assert.strictEqual(result, null);
	});
});

describe('events_to_surface', () => {
	test('converts specs with JSON Schema params', () => {
		const specs: Array<EventSpec> = [
			{
				method: 'thing_created',
				params: z.strictObject({ id: z.string(), name: z.string() }),
				description: 'A thing was created',
				channel: 'things'
			}
		];
		const result = events_to_surface(specs);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.method, 'thing_created');
		assert.strictEqual(result[0]!.description, 'A thing was created');
		assert.strictEqual(result[0]!.channel, 'things');
		assert.ok(result[0]!.params_schema);
	});

	test('handles empty array', () => {
		const result = events_to_surface([]);
		assert.deepStrictEqual(result, []);
	});

	test('normalizes missing channel to null', () => {
		const specs: Array<EventSpec> = [
			{
				method: 'test',
				params: z.null(),
				description: 'Test'
			}
		];
		const result = events_to_surface(specs);
		assert.strictEqual(result[0]!.channel, null);
	});
});

describe('error catch layer', () => {
	test('handler that throws ThrownJsonrpcError returns correct status and body', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: () => {
					throw jsonrpc_errors.not_found('user');
				},
				description: 'Test',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test');
		assert.strictEqual(res.status, 404);
		const body = await res.json();
		// REST flat shape: `error` is the reason name (from the JSON-RPC code),
		// `message` carries the human message from the throw site.
		assert.strictEqual(body.error, 'not_found');
		assert.strictEqual(body.message, 'user not found');
	});

	test('ThrownJsonrpcError with data flattens data under the response body', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: () => {
					throw new ThrownJsonrpcError(JSONRPC_ERROR_CODES.conflict, 'duplicate', {
						field: 'email'
					});
				},
				description: 'Test',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test', { method: 'POST' });
		assert.strictEqual(res.status, 409);
		const body = await res.json();
		assert.strictEqual(body.error, 'conflict');
		assert.strictEqual(body.message, 'duplicate');
		// Non-`reason` data fields flatten alongside `error` / `message`.
		assert.strictEqual(body.field, 'email');
	});

	test('ThrownJsonrpcError without data omits extras from response', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: () => {
					throw jsonrpc_errors.unauthenticated();
				},
				description: 'Test',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, 'unauthenticated');
		// Default message equals the reason name, so the catch layer
		// suppresses the redundant `message` field for the simple case.
		assert.strictEqual(body.message, undefined);
		// No data → no extras besides `error`.
		assert.deepStrictEqual(Object.keys(body), ['error']);
	});

	test('data.reason overrides the code-derived reason on the REST body', async () => {
		// Consumers that throw with a domain-specific reason
		// (`{reason: ERROR_ROLE_GRANT_OFFER_TERMINAL}` etc.) should see that string
		// land on `body.error` instead of the generic JSON-RPC name.
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: () => {
					throw jsonrpc_errors.conflict('offer already terminal', {
						reason: 'role_grant_offer_terminal',
						offer_id: 'offer-1'
					});
				},
				description: 'Test',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test', { method: 'POST' });
		assert.strictEqual(res.status, 409);
		const body = await res.json();
		assert.strictEqual(body.error, 'role_grant_offer_terminal');
		assert.strictEqual(body.message, 'offer already terminal');
		assert.strictEqual(body.offer_id, 'offer-1');
		// `reason` is consumed into `error` and not duplicated.
		assert.strictEqual(body.reason, undefined);
	});

	test('generic Error maps to internal_error 500 with message in DEV', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: () => {
					throw new Error('something broke');
				},
				description: 'Test',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test');
		assert.strictEqual(res.status, 500);
		const body = await res.json();
		assert.strictEqual(body.error, 'internal_error');
		// DEV is true in test environment — error message is included
		assert.strictEqual(body.message, 'something broke');
	});

	test('handler that returns normally is unaffected by catch layer', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: { account: 'none', actor: 'none' },
				handler: (c) => c.json({ ok: true }),
				description: 'Test',
				input: z.null(),
				output: z.null()
			}
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('maps various error codes to correct HTTP statuses', async () => {
		const cases: Array<{ name: string; error: ThrownJsonrpcError; expected_status: number }> = [
			{ name: 'forbidden', error: jsonrpc_errors.forbidden(), expected_status: 403 },
			{ name: 'rate_limited', error: jsonrpc_errors.rate_limited(), expected_status: 429 },
			{
				name: 'service_unavailable',
				error: jsonrpc_errors.service_unavailable(),
				expected_status: 503
			},
			{ name: 'timeout', error: jsonrpc_errors.timeout(), expected_status: 504 },
			{
				name: 'validation_error',
				error: jsonrpc_errors.validation_error(),
				expected_status: 422
			},
			{
				name: 'invalid_params',
				error: jsonrpc_errors.invalid_params(),
				expected_status: 400
			}
		];

		for (const { name, error, expected_status } of cases) {
			const app = new Hono();
			const specs: Array<RouteSpec> = [
				{
					method: 'GET',
					path: '/test',
					auth: { account: 'none', actor: 'none' },
					handler: () => {
						throw error;
					},
					description: 'Test',
					input: z.null(),
					output: z.null()
				}
			];
			apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

			const res = await app.request('/test');
			assert.strictEqual(res.status, expected_status, `${name} should return ${expected_status}`);
		}
	});
});
