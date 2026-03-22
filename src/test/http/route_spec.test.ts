/**
 * Tests for backend_route_spec.ts — introspectable route spec system.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {
	apply_middleware_specs,
	apply_route_specs,
	prefix_route_specs,
	get_route_query,
	type RouteSpec,
} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import {generate_app_surface, events_to_surface} from '$lib/http/surface.js';
import {middleware_applies, schema_to_surface} from '$lib/http/schema_helpers.js';
import type {SseEventSpec} from '$lib/realtime/sse.js';
import {REQUEST_CONTEXT_KEY} from '$lib/auth/request_context.js';
import {create_test_request_context} from '$lib/testing/auth_apps.js';
import {ApiError, RateLimitError} from '$lib/http/error_schemas.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});
const db = create_stub_db();

describe('apply_route_specs', () => {
	test('registers a GET route', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: {type: 'none'},
				handler: (c) => c.json({ok: true}),
				description: 'Test route',
				input: z.null(),
				output: z.null(),
			},
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
				auth: {type: 'none'},
				handler: (c) => c.json({created: true}),
				description: 'Create route',
				input: z.null(),
				output: z.null(),
			},
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/create', {method: 'POST'});
		assert.strictEqual(res.status, 200);
	});

	test('auth none adds no guard', async () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/public',
				auth: {type: 'none'},
				handler: (c) => c.json({public: true}),
				description: 'Public route',
				input: z.null(),
				output: z.null(),
			},
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
				auth: {type: 'authenticated'},
				handler: (c) => c.json({secret: true}),
				description: 'Protected route',
				input: z.null(),
				output: z.null(),
			},
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/protected');
		assert.strictEqual(res.status, 401);
	});

	test('auth authenticated passes when authenticated', async () => {
		const app = new Hono();
		// Set request context before the route
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, create_test_request_context());
			await next();
		});
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/protected',
				auth: {type: 'authenticated'},
				handler: (c) => c.json({secret: true}),
				description: 'Protected route',
				input: z.null(),
				output: z.null(),
			},
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
				auth: {type: 'role', role: 'admin'},
				handler: (c) => c.json({admin: true}),
				description: 'Admin route',
				input: z.null(),
				output: z.null(),
			},
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 401);
	});

	test('auth role returns 403 when wrong role', async () => {
		const app = new Hono();
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, create_test_request_context('viewer'));
			await next();
		});
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/admin',
				auth: {type: 'role', role: 'admin'},
				handler: (c) => c.json({admin: true}),
				description: 'Admin route',
				input: z.null(),
				output: z.null(),
			},
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('auth role passes with correct role', async () => {
		const app = new Hono();
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, create_test_request_context('admin'));
			await next();
		});
		const specs: Array<RouteSpec> = [
			{
				method: 'POST',
				path: '/admin',
				auth: {type: 'role', role: 'admin'},
				handler: (c) => c.json({admin: true}),
				description: 'Admin route',
				input: z.null(),
				output: z.null(),
			},
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/admin', {method: 'POST'});
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
				auth: {type: 'none'},
				handler: (c) => {
					const q = get_route_query<{q: string}>(c);
					return c.json({query: q.q});
				},
				description: 'Search',
				query: z.strictObject({q: z.string().min(1)}),
				input: z.null(),
				output: z.strictObject({query: z.string()}),
			},
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
				auth: {type: 'none'},
				handler: (c) => c.json({ok: true}),
				description: 'Search',
				query: z.strictObject({q: z.string().min(1)}),
				input: z.null(),
				output: z.null(),
			},
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
				auth: {type: 'none'},
				handler: (c) => c.json({ok: true}),
				description: 'Search',
				query: z.strictObject({q: z.string()}),
				input: z.null(),
				output: z.null(),
			},
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
				auth: {type: 'none'},
				handler: (c) => c.json({ok: true}),
				description: 'Test',
				input: z.null(),
				output: z.null(),
			},
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
				},
			},
		];
		apply_middleware_specs(app, specs);
		app.get('/api/test', (c) => c.json({ok: true}));

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
				auth: {type: 'none'},
				handler: (c) => c.json({}),
				description: 'List items',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'POST',
				path: '/create',
				auth: {type: 'authenticated'},
				handler: (c) => c.json({}),
				description: 'Create item',
				input: z.null(),
				output: z.null(),
			},
		];

		const prefixed = prefix_route_specs('/api/items', specs);
		assert.strictEqual(prefixed[0]!.path, '/api/items/list');
		assert.strictEqual(prefixed[1]!.path, '/api/items/create');
	});

	test('preserves other spec properties', () => {
		const handler = (c: any) => c.json({});
		const specs: Array<RouteSpec> = [
			{
				method: 'DELETE',
				path: '/:id',
				auth: {type: 'keeper'},
				handler,
				description: 'Delete item',
				input: z.null(),
				output: z.null(),
			},
		];

		const prefixed = prefix_route_specs('/items', specs);
		assert.strictEqual(prefixed[0]!.method, 'DELETE');
		assert.strictEqual(prefixed[0]!.auth.type, 'keeper');
		assert.strictEqual(prefixed[0]!.handler, handler);
		assert.strictEqual(prefixed[0]!.description, 'Delete item');
	});

	test('throws on duplicate method+path', () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/items',
				auth: {type: 'none'},
				handler: (c) => c.json({first: true}),
				description: 'First',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'GET',
				path: '/items',
				auth: {type: 'none'},
				handler: (c) => c.json({second: true}),
				description: 'Second',
				input: z.null(),
				output: z.null(),
			},
		];
		assert.throws(
			() => apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db),
			/Duplicate route: GET \/items/,
		);
	});

	test('allows same path with different methods', () => {
		const app = new Hono();
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/items',
				auth: {type: 'none'},
				handler: (c) => c.json({ok: true}),
				description: 'Get items',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'POST',
				path: '/items',
				auth: {type: 'none'},
				handler: (c) => c.json({ok: true}),
				description: 'Create item',
				input: z.null(),
				output: z.null(),
			},
		];
		// should not throw
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	});
});

describe('prefix_route_specs', () => {
	test('does not mutate original specs', () => {
		const specs: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: {type: 'none'},
				handler: (c) => c.json({}),
				description: 'Test route',
				input: z.null(),
				output: z.null(),
			},
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
		assert.strictEqual(middleware_applies('/api/tx/*', '/api/account/login'), false);
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
			{name: 'origin', path: '/api/*', handler: async (_c, next) => next()},
			{name: 'session', path: '/api/*', handler: async (_c, next) => next()},
		];
		const routes: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/health',
				auth: {type: 'none'},
				handler: (c) => c.json({}),
				description: 'Health check',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'POST',
				path: '/api/login',
				auth: {type: 'none'},
				handler: (c) => c.json({}),
				description: 'Login',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'GET',
				path: '/api/protected',
				auth: {type: 'authenticated'},
				handler: (c) => c.json({}),
				description: 'Protected resource',
				input: z.null(),
				output: z.null(),
			},
		];

		const surface = generate_app_surface({middleware_specs: middleware, route_specs: routes});

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
			{name: 'test', path: '/*', handler: async (_c, next) => next()},
		];
		const routes: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/test',
				auth: {type: 'role', role: 'admin'},
				handler: (c) => c.json({}),
				description: 'Test route',
				input: z.null(),
				output: z.null(),
			},
		];

		const surface = generate_app_surface({middleware_specs: middleware, route_specs: routes});
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
					auth: {type: 'none'},
					handler: (c) => c.json({}),
					description: 'Test endpoint',
					input: z.null(),
					output: z.null(),
				},
			],
		});

		assert.strictEqual(surface.routes[0]!.description, 'Test endpoint');
	});

	test('auth types are preserved', () => {
		const routes: Array<RouteSpec> = [
			{
				method: 'GET',
				path: '/a',
				auth: {type: 'none'},
				handler: (c) => c.json({}),
				description: 'A',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'GET',
				path: '/b',
				auth: {type: 'authenticated'},
				handler: (c) => c.json({}),
				description: 'B',
				input: z.null(),
				output: z.null(),
			},
			{
				method: 'GET',
				path: '/c',
				auth: {type: 'keeper'},
				handler: (c) => c.json({}),
				description: 'C',
				input: z.null(),
				output: z.null(),
			},
		];

		const surface = generate_app_surface({middleware_specs: [], route_specs: routes});
		assert.deepStrictEqual(surface.routes[0]!.auth, {type: 'none'});
		assert.deepStrictEqual(surface.routes[1]!.auth, {type: 'authenticated'});
		assert.deepStrictEqual(surface.routes[2]!.auth, {type: 'keeper'});
	});

	test('without options defaults env and events to empty arrays', () => {
		const surface = generate_app_surface({middleware_specs: [], route_specs: []});
		assert.deepStrictEqual(surface.env, []);
		assert.deepStrictEqual(surface.events, []);
	});

	test('with env_schema includes env in surface', () => {
		const schema = z.strictObject({
			PORT: z.coerce.number().default(4040).meta({description: 'Port'}),
			SECRET: z.string().meta({description: 'A secret', sensitivity: 'secret'}),
		});
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [],
			env_schema: schema,
		});
		assert.ok(surface.env);
		assert.strictEqual(surface.env.length, 2);
		assert.strictEqual(surface.env[0]!.name, 'PORT');
		assert.strictEqual(surface.env[1]!.sensitivity, 'secret');
	});

	test('with event_specs includes events in surface', () => {
		const specs: Array<SseEventSpec> = [
			{
				method: 'run_created',
				params: z.strictObject({run_id: z.string()}),
				description: 'A run was created',
				channel: 'runs',
			},
		];
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [],
			event_specs: specs,
		});
		assert.ok(surface.events);
		assert.strictEqual(surface.events.length, 1);
		assert.strictEqual(surface.events[0]!.method, 'run_created');
		assert.strictEqual(surface.events[0]!.channel, 'runs');
	});

	test('empty event_specs produces empty events array', () => {
		const surface = generate_app_surface({middleware_specs: [], route_specs: [], event_specs: []});
		assert.deepStrictEqual(surface.events, []);
	});

	test('extended surface is JSON-serializable', () => {
		const env_schema = z.strictObject({
			PORT: z.coerce.number().default(4040).meta({description: 'Port'}),
		});
		const event_specs: Array<SseEventSpec> = [
			{
				method: 'test',
				params: z.strictObject({id: z.string()}),
				description: 'Test event',
			},
		];
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs: [],
			env_schema,
			event_specs,
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
					auth: {type: 'none'},
					handler: (c) => c.json({}),
					description: 'Health',
					input: z.null(),
					output: z.null(),
				},
			],
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
					auth: {type: 'authenticated'},
					handler: (c) => c.json({}),
					description: 'Protected',
					input: z.null(),
					output: z.null(),
				},
			],
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
					auth: {type: 'role', role: 'admin'},
					handler: (c) => c.json({}),
					description: 'Admin',
					input: z.null(),
					output: z.null(),
				},
			],
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
					auth: {type: 'none'},
					handler: (c) => c.json({}),
					description: 'Create',
					input: z.strictObject({name: z.string()}),
					output: z.null(),
				},
			],
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
					auth: {type: 'none'},
					handler: (c) => c.json({}),
					description: 'Login',
					input: z.strictObject({username: z.string()}),
					output: z.null(),
					errors: {401: ApiError, 429: RateLimitError},
				},
			],
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
					auth: {type: 'role', role: 'admin'},
					handler: (c) => c.json({}),
					description: 'Test',
					input: z.strictObject({x: z.number()}),
					output: z.null(),
					errors: {429: RateLimitError},
				},
			],
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
				auth: {type: 'none'},
				description: 'content type test',
				input: z.strictObject({name: z.string()}),
				output: z.strictObject({ok: z.literal(true)}),
				handler: async (c) => c.json({ok: true}),
			},
		];
		apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
		return app;
	};

	test('rejects non-JSON content type on input route', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			headers: {'Content-Type': 'text/plain'},
			body: 'not json',
		});
		assert.ok(res.status === 400 || res.status === 415, `expected 400 or 415, got ${res.status}`);
	});

	test('rejects application/x-www-form-urlencoded', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded'},
			body: 'name=test',
		});
		assert.ok(res.status < 500, `expected non-500, got ${res.status}`);
		assert.ok(
			res.status === 400 || res.status === 415,
			`expected 400 or 415 for form-urlencoded, got ${res.status}`,
		);
	});

	test('rejects POST with no Content-Type header', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			body: JSON.stringify({name: 'test'}),
		});
		// without Content-Type, json() parsing may fail — should get 400 not 500
		assert.ok(res.status < 500, `expected non-500, got ${res.status}`);
	});

	test('accepts application/json with charset', async () => {
		const app = create_input_app();
		const res = await app.request('/test', {
			method: 'POST',
			headers: {'Content-Type': 'application/json; charset=utf-8'},
			body: JSON.stringify({name: 'test'}),
		});
		assert.strictEqual(res.status, 200, 'application/json with charset should be accepted');
	});

	test('rejects multipart/form-data', async () => {
		const app = create_input_app();
		const boundary = '----boundary123';
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ntest\r\n--${boundary}--`;
		const res = await app.request('/test', {
			method: 'POST',
			headers: {'Content-Type': `multipart/form-data; boundary=${boundary}`},
			body,
		});
		assert.ok(res.status < 500, `expected non-500, got ${res.status}`);
		assert.ok(
			res.status === 400 || res.status === 415,
			`expected 400 or 415 for multipart, got ${res.status}`,
		);
	});
});

describe('schema_to_surface', () => {
	test('is exported and converts object schemas', () => {
		const result = schema_to_surface(z.strictObject({name: z.string()}));
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
		const specs: Array<SseEventSpec> = [
			{
				method: 'thing_created',
				params: z.strictObject({id: z.string(), name: z.string()}),
				description: 'A thing was created',
				channel: 'things',
			},
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
		const specs: Array<SseEventSpec> = [
			{
				method: 'test',
				params: z.null(),
				description: 'Test',
			},
		];
		const result = events_to_surface(specs);
		assert.strictEqual(result[0]!.channel, null);
	});
});
