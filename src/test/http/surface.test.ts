/**
 * Tests for surface.ts - App surface generation.
 *
 * Tests the surface generation functions directly:
 * `generate_app_surface`, `create_app_surface_spec`, `collect_middleware_errors`,
 * `env_schema_to_surface`, `events_to_surface`.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {
	generate_app_surface,
	create_app_surface_spec,
	collect_middleware_errors,
	env_schema_to_surface,
	events_to_surface,
} from '$lib/http/surface.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import type {SseEventSpec} from '$lib/realtime/sse.js';

const noop_handler = async (c: any) => c.json({ok: true});
const noop_middleware = async (_c: any, next: any) => next();

const create_route = (overrides: Partial<RouteSpec> = {}): RouteSpec => ({
	method: 'GET',
	path: '/test',
	auth: {type: 'none'},
	description: 'Test route',
	input: z.null(),
	output: z.strictObject({ok: z.boolean()}),
	handler: noop_handler,
	...overrides,
});

const create_middleware = (overrides: Partial<MiddlewareSpec> = {}): MiddlewareSpec => ({
	name: 'test_mw',
	path: '/*',
	handler: noop_middleware,
	...overrides,
});

describe('generate_app_surface', () => {
	test('generates surface with routes and middleware', () => {
		const route = create_route();
		const mw = create_middleware();

		const surface = generate_app_surface({
			route_specs: [route],
			middleware_specs: [mw],
		});

		assert.strictEqual(surface.routes.length, 1);
		assert.strictEqual(surface.middleware.length, 1);
		assert.strictEqual(surface.routes[0]!.method, 'GET');
		assert.strictEqual(surface.routes[0]!.path, '/test');
		assert.strictEqual(surface.middleware[0]!.name, 'test_mw');
	});

	test('marks GET as non-mutation and POST as mutation', () => {
		const routes = [
			create_route({method: 'GET', path: '/read'}),
			create_route({method: 'POST', path: '/write'}),
			create_route({method: 'DELETE', path: '/remove'}),
		];

		const surface = generate_app_surface({route_specs: routes, middleware_specs: []});

		assert.strictEqual(surface.routes[0]!.is_mutation, false);
		assert.strictEqual(surface.routes[1]!.is_mutation, true);
		assert.strictEqual(surface.routes[2]!.is_mutation, true);
	});

	test('computes applicable_middleware for routes', () => {
		const route = create_route({path: '/api/things'});
		const global_mw = create_middleware({name: 'global', path: '/*'});
		const api_mw = create_middleware({name: 'api_only', path: '/api/*'});
		const other_mw = create_middleware({name: 'admin_only', path: '/admin/*'});

		const surface = generate_app_surface({
			route_specs: [route],
			middleware_specs: [global_mw, api_mw, other_mw],
		});

		const applicable = surface.routes[0]!.applicable_middleware;
		assert.ok(applicable.includes('global'));
		assert.ok(applicable.includes('api_only'));
		assert.ok(!applicable.includes('admin_only'));
	});

	test('preserves auth on surface routes', () => {
		const routes = [
			create_route({path: '/public', auth: {type: 'none'}}),
			create_route({path: '/authed', auth: {type: 'authenticated'}}),
			create_route({path: '/admin', auth: {type: 'role', role: 'admin'}}),
			create_route({path: '/keeper', auth: {type: 'keeper'}}),
		];

		const surface = generate_app_surface({route_specs: routes, middleware_specs: []});

		assert.deepStrictEqual(surface.routes[0]!.auth, {type: 'none'});
		assert.deepStrictEqual(surface.routes[1]!.auth, {type: 'authenticated'});
		assert.deepStrictEqual(surface.routes[2]!.auth, {type: 'role', role: 'admin'});
		assert.deepStrictEqual(surface.routes[3]!.auth, {type: 'keeper'});
	});

	test('converts input/output schemas to JSON Schema surface representation', () => {
		const route = create_route({
			input: z.strictObject({name: z.string()}),
			output: z.strictObject({id: z.string()}),
		});

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.ok(surface.routes[0]!.input_schema);
		assert.ok(surface.routes[0]!.output_schema);
	});

	test('null input schema produces null surface representation', () => {
		const route = create_route({input: z.null()});

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.strictEqual(surface.routes[0]!.input_schema, null);
	});

	test('rate_limit_key is null when not set', () => {
		const route = create_route();

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.strictEqual(surface.routes[0]!.rate_limit_key, null);
	});

	test('rate_limit_key is preserved when set', () => {
		const route = create_route({rate_limit: 'ip'});

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.strictEqual(surface.routes[0]!.rate_limit_key, 'ip');
	});

	test('params_schema is null when no params', () => {
		const route = create_route();

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.strictEqual(surface.routes[0]!.params_schema, null);
	});

	test('params_schema is set when params defined', () => {
		const route = create_route({params: z.strictObject({id: z.string()})});

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.ok(surface.routes[0]!.params_schema);
	});

	test('query_schema is null when no query', () => {
		const route = create_route();

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.strictEqual(surface.routes[0]!.query_schema, null);
	});

	test('query_schema is set when query defined', () => {
		const route = create_route({query: z.strictObject({q: z.string()})});

		const surface = generate_app_surface({route_specs: [route], middleware_specs: []});

		assert.ok(surface.routes[0]!.query_schema);
	});

	test('includes env when env_schema provided', () => {
		const env_schema = z.strictObject({
			PORT: z.number().default(4040),
		});

		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			env_schema,
		});

		assert.ok(surface.env);
		assert.strictEqual(surface.env.length, 1);
		assert.strictEqual(surface.env[0]!.name, 'PORT');
	});

	test('defaults env to empty array when no env_schema', () => {
		const surface = generate_app_surface({route_specs: [], middleware_specs: []});

		assert.deepStrictEqual(surface.env, []);
	});

	test('includes events when event_specs provided', () => {
		const event_specs: Array<SseEventSpec> = [
			{
				method: 'thing_created',
				params: z.strictObject({id: z.string()}),
				description: 'Created',
				channel: 'things',
			},
		];

		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			event_specs,
		});

		assert.ok(surface.events);
		assert.strictEqual(surface.events.length, 1);
		assert.strictEqual(surface.events[0]!.method, 'thing_created');
		assert.strictEqual(surface.events[0]!.channel, 'things');
	});

	test('defaults events to empty array when event_specs is empty', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			event_specs: [],
		});

		assert.deepStrictEqual(surface.events, []);
	});

	test('merges middleware error schemas into route error schemas', () => {
		const ApiError = z.strictObject({error: z.string()});
		const mw = create_middleware({
			name: 'auth',
			path: '/api/*',
			errors: {401: ApiError},
		});
		const route = create_route({
			path: '/api/things',
			auth: {type: 'authenticated'},
		});

		const surface = generate_app_surface({
			route_specs: [route],
			middleware_specs: [mw],
		});

		assert.ok(surface.routes[0]!.error_schemas);
		assert.ok(surface.routes[0]!.error_schemas['401']);
	});

	test('middleware error schemas on surface are serialized', () => {
		const ApiError = z.strictObject({error: z.string()});
		const mw = create_middleware({
			name: 'origin',
			path: '/api/*',
			errors: {403: ApiError},
		});

		const surface = generate_app_surface({route_specs: [], middleware_specs: [mw]});

		assert.ok(surface.middleware[0]!.error_schemas);
		assert.ok(surface.middleware[0]!.error_schemas['403']);
	});

	test('middleware without errors has null error_schemas', () => {
		const mw = create_middleware({name: 'logger'});

		const surface = generate_app_surface({route_specs: [], middleware_specs: [mw]});

		assert.strictEqual(surface.middleware[0]!.error_schemas, null);
	});
});

describe('create_app_surface_spec', () => {
	test('bundles surface with source specs', () => {
		const route = create_route();
		const mw = create_middleware();

		const spec = create_app_surface_spec({route_specs: [route], middleware_specs: [mw]});

		assert.ok(spec.surface);
		assert.strictEqual(spec.route_specs.length, 1);
		assert.strictEqual(spec.middleware_specs.length, 1);
		assert.strictEqual(spec.route_specs[0], route);
		assert.strictEqual(spec.middleware_specs[0], mw);
	});
});

describe('collect_middleware_errors', () => {
	test('collects errors from matching middleware', () => {
		const ApiError = z.strictObject({error: z.string()});
		const middleware = [
			create_middleware({name: 'auth', path: '/api/*', errors: {401: ApiError}}),
			create_middleware({name: 'logger', path: '/*'}),
		];

		const errors = collect_middleware_errors(middleware, '/api/things');

		assert.ok(errors);
		assert.ok(errors['401']);
	});

	test('returns null when no middleware has errors', () => {
		const middleware = [create_middleware({name: 'logger', path: '/*'})];

		const errors = collect_middleware_errors(middleware, '/api/things');

		assert.strictEqual(errors, null);
	});

	test('skips middleware that does not apply to path', () => {
		const ApiError = z.strictObject({error: z.string()});
		const middleware = [
			create_middleware({name: 'admin_auth', path: '/admin/*', errors: {401: ApiError}}),
		];

		const errors = collect_middleware_errors(middleware, '/api/things');

		assert.strictEqual(errors, null);
	});

	test('merges errors from multiple matching middleware', () => {
		const AuthError = z.strictObject({error: z.literal('auth')});
		const OriginError = z.strictObject({error: z.literal('origin')});
		const middleware = [
			create_middleware({name: 'auth', path: '/api/*', errors: {401: AuthError}}),
			create_middleware({name: 'origin', path: '/api/*', errors: {403: OriginError}}),
		];

		const errors = collect_middleware_errors(middleware, '/api/things');

		assert.ok(errors);
		assert.ok(errors['401']);
		assert.ok(errors['403']);
	});
});

describe('env_schema_to_surface', () => {
	test('extracts env entries from schema', () => {
		const schema = z.strictObject({
			PORT: z.number().default(4040),
			SECRET: z.string(),
		});

		const entries = env_schema_to_surface(schema);

		assert.strictEqual(entries.length, 2);
		const port = entries.find((e) => e.name === 'PORT')!;
		const secret = entries.find((e) => e.name === 'SECRET')!;
		assert.ok(port);
		assert.ok(secret);
		assert.strictEqual(port.has_default, true);
		assert.strictEqual(port.optional, true);
		assert.strictEqual(secret.has_default, false);
	});

	test('detects sensitivity from meta', () => {
		const schema = z.strictObject({
			API_KEY: z.string().meta({sensitivity: 'secret', description: 'The API key'}),
		});

		const entries = env_schema_to_surface(schema);

		assert.strictEqual(entries[0]!.sensitivity, 'secret');
		assert.strictEqual(entries[0]!.description, 'The API key');
	});

	test('non-sensitive fields default to sensitivity=null', () => {
		const schema = z.strictObject({
			PORT: z.number().default(3000),
		});

		const entries = env_schema_to_surface(schema);

		assert.strictEqual(entries[0]!.sensitivity, null);
	});
});

describe('events_to_surface', () => {
	test('converts event specs to surface entries', () => {
		const specs: Array<SseEventSpec> = [
			{
				method: 'created',
				params: z.strictObject({id: z.string()}),
				description: 'Created',
				channel: 'things',
			},
			{method: 'deleted', params: z.strictObject({id: z.string()}), description: 'Deleted'},
		];

		const events = events_to_surface(specs);

		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0]!.method, 'created');
		assert.strictEqual(events[0]!.channel, 'things');
		assert.strictEqual(events[1]!.method, 'deleted');
		assert.strictEqual(events[1]!.channel, null);
	});

	test('returns empty array for empty specs', () => {
		const events = events_to_surface([]);

		assert.strictEqual(events.length, 0);
	});
});
