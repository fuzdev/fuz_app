/**
 * Tests for surface.ts - App surface generation.
 *
 * Tests the surface generation functions directly:
 * `generate_app_surface`, `create_app_surface_spec` (and the route error map it carries),
 * `env_schema_to_surface`, `events_to_surface`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	loose_object,
	message,
	min_length,
	nullable,
	number,
	object,
	optional,
	pipe,
	string,
	strip_object,
	transform,
	union,
	with_default,
	with_default_fn
} from '@fuzdev/fuz_schema/schema.ts';
import { z } from 'zod';

import {
	generate_app_surface,
	create_app_surface_spec,
	env_schema_to_surface,
	type AppSurfaceDiagnostic,
	events_to_surface
} from '#lib/http/surface.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import type { EventSpec } from '#lib/realtime/sse.ts';
import type { WsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';

const noop_handler = async (c: any) => c.json({ ok: true });
const noop_middleware = async (_c: any, next: any) => next();

const create_route = (overrides: Partial<RouteSpec> = {}): RouteSpec => ({
	method: 'GET',
	path: '/test',
	auth: { account: 'none', actor: 'none' },
	description: 'Test route',
	input: z.null(),
	output: z.strictObject({ ok: z.boolean() }),
	handler: noop_handler,
	...overrides
});

const create_middleware = (overrides: Partial<MiddlewareSpec> = {}): MiddlewareSpec => ({
	name: 'test_mw',
	path: '/*',
	handler: noop_middleware,
	...overrides
});

describe('generate_app_surface', () => {
	test('generates surface with routes and middleware', () => {
		const route = create_route();
		const mw = create_middleware();

		const surface = generate_app_surface({
			route_specs: [route],
			middleware_specs: [mw]
		});

		assert.strictEqual(surface.routes.length, 1);
		assert.strictEqual(surface.middleware.length, 1);
		assert.strictEqual(surface.routes[0]!.method, 'GET');
		assert.strictEqual(surface.routes[0]!.path, '/test');
		assert.strictEqual(surface.middleware[0]!.name, 'test_mw');
	});

	test('marks GET as non-mutation and POST as mutation', () => {
		const routes = [
			create_route({ method: 'GET', path: '/read' }),
			create_route({ method: 'POST', path: '/write' }),
			create_route({ method: 'DELETE', path: '/remove' })
		];

		const surface = generate_app_surface({ route_specs: routes, middleware_specs: [] });

		assert.strictEqual(surface.routes[0]!.is_mutation, false);
		assert.strictEqual(surface.routes[1]!.is_mutation, true);
		assert.strictEqual(surface.routes[2]!.is_mutation, true);
	});

	test('surfaces raw_body — defaults false, true when the spec marks it', () => {
		const routes = [
			create_route({ path: '/json' }),
			create_route({ path: '/binary', raw_body: true })
		];

		const surface = generate_app_surface({ route_specs: routes, middleware_specs: [] });

		assert.strictEqual(surface.routes[0]!.raw_body, false);
		assert.strictEqual(surface.routes[1]!.raw_body, true);
	});

	test('computes applicable_middleware for routes', () => {
		const route = create_route({ path: '/api/things' });
		const global_mw = create_middleware({ name: 'global', path: '/*' });
		const api_mw = create_middleware({ name: 'api_only', path: '/api/*' });
		const other_mw = create_middleware({ name: 'admin_only', path: '/admin/*' });

		const surface = generate_app_surface({
			route_specs: [route],
			middleware_specs: [global_mw, api_mw, other_mw]
		});

		const applicable = surface.routes[0]!.applicable_middleware;
		assert.ok(applicable.includes('global'));
		assert.ok(applicable.includes('api_only'));
		assert.ok(!applicable.includes('admin_only'));
	});

	test('preserves auth on surface routes', () => {
		const routes = [
			create_route({ path: '/public', auth: { account: 'none', actor: 'none' } }),
			create_route({ path: '/authed', auth: { account: 'required', actor: 'none' } }),
			create_route({
				path: '/admin',
				auth: { account: 'required', actor: 'required', roles: ['admin'] }
			}),
			create_route({
				path: '/keeper',
				auth: {
					account: 'required',
					actor: 'required',
					roles: ['keeper'],
					credential_types: ['daemon_token']
				}
			})
		];

		const surface = generate_app_surface({ route_specs: routes, middleware_specs: [] });

		assert.deepStrictEqual(surface.routes[0]!.auth, { account: 'none', actor: 'none' });
		assert.deepStrictEqual(surface.routes[1]!.auth, { account: 'required', actor: 'none' });
		assert.deepStrictEqual(surface.routes[2]!.auth, {
			account: 'required',
			actor: 'required',
			roles: ['admin']
		});
		assert.deepStrictEqual(surface.routes[3]!.auth, {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token']
		});
	});

	test('converts input/output schemas to JSON Schema surface representation', () => {
		const route = create_route({
			input: z.strictObject({ name: z.string() }),
			output: z.strictObject({ id: z.string() })
		});

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.ok(surface.routes[0]!.input_schema);
		assert.ok(surface.routes[0]!.output_schema);
	});

	test('null input schema produces null surface representation', () => {
		const route = create_route({ input: z.null() });

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.strictEqual(surface.routes[0]!.input_schema, null);
	});

	test('rate_limit_key is null when not set', () => {
		const route = create_route();

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.strictEqual(surface.routes[0]!.rate_limit_key, null);
	});

	test('rate_limit_key is preserved when set', () => {
		const route = create_route({ rate_limit: 'ip' });

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.strictEqual(surface.routes[0]!.rate_limit_key, 'ip');
	});

	test('params_schema is null when no params', () => {
		const route = create_route();

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.strictEqual(surface.routes[0]!.params_schema, null);
	});

	test('params_schema is set when params defined', () => {
		const route = create_route({ params: z.strictObject({ id: z.string() }) });

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.ok(surface.routes[0]!.params_schema);
	});

	test('query_schema is null when no query', () => {
		const route = create_route();

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.strictEqual(surface.routes[0]!.query_schema, null);
	});

	test('query_schema is set when query defined', () => {
		const route = create_route({ query: z.strictObject({ q: z.string() }) });

		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });

		assert.ok(surface.routes[0]!.query_schema);
	});

	test('includes env when env_schema provided', () => {
		const env_schema = object({
			PORT: with_default(number, 4040)
		});

		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			env_schema
		});

		assert.ok(surface.env);
		assert.strictEqual(surface.env.length, 1);
		assert.strictEqual(surface.env[0]!.name, 'PORT');
	});

	test('defaults env to empty array when no env_schema', () => {
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [] });

		assert.deepStrictEqual(surface.env, []);
	});

	test('includes events when event_specs provided', () => {
		const event_specs: Array<EventSpec> = [
			{
				method: 'thing_created',
				params: z.strictObject({ id: z.string() }),
				description: 'Created',
				channel: 'things'
			}
		];

		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			event_specs
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
			event_specs: []
		});

		assert.deepStrictEqual(surface.events, []);
	});

	test('merges middleware error schemas into route error schemas', () => {
		const mw = create_middleware({
			name: 'auth',
			path: '/api/*',
			errors: [rest_error(401, 'session_expired')]
		});
		const route = create_route({
			path: '/api/things',
			auth: { account: 'required', actor: 'none' }
		});

		const surface = generate_app_surface({
			route_specs: [route],
			middleware_specs: [mw]
		});

		assert.ok(surface.routes[0]!.error_schemas);
		// the derived 401 and the middleware's, a union
		const branches = (surface.routes[0]!.error_schemas['401'] as { anyOf: Array<any> }).anyOf;
		assert.deepStrictEqual(
			branches.map((b) => b.properties.error.const),
			['authentication_required', 'session_expired']
		);
	});

	test('middleware error schemas on surface are serialized, grouped by status', () => {
		const mw = create_middleware({
			name: 'origin',
			path: '/api/*',
			errors: [
				rest_error(403, 'forbidden_origin'),
				rest_error(403, 'blocked'),
				rest_error(413, 'big')
			]
		});

		const surface = generate_app_surface({ route_specs: [], middleware_specs: [mw] });

		const error_schemas = surface.middleware[0]!.error_schemas;
		assert.ok(error_schemas);
		assert.deepStrictEqual(Object.keys(error_schemas), ['403', '413']);
		assert.strictEqual((error_schemas['403'] as { anyOf: Array<unknown> }).anyOf.length, 2);
	});

	test('a middleware declaring an empty list has null error_schemas', () => {
		const mw = create_middleware({ name: 'bearer', errors: [] });
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [mw] });
		assert.strictEqual(surface.middleware[0]!.error_schemas, null);
	});

	test('middleware without errors has null error_schemas', () => {
		const mw = create_middleware({ name: 'logger' });

		const surface = generate_app_surface({ route_specs: [], middleware_specs: [mw] });

		assert.strictEqual(surface.middleware[0]!.error_schemas, null);
	});

	test('ws_endpoints allowed_origins are stringified via RegExp.prototype.toString (flags preserved)', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			ws_endpoints: [
				{
					path: '/api/ws',
					allowed_origins: [/^http:\/\/localhost(:\d+)?$/i, /^https:\/\/[^./:]+\.fuz\.dev$/i],
					actions: []
				}
			]
		});

		assert.deepStrictEqual(surface.ws_endpoints[0]!.allowed_origins, [
			'/^http:\\/\\/localhost(:\\d+)?$/i',
			'/^https:\\/\\/[^./:]+\\.fuz\\.dev$/i'
		]);
	});

	test('ws_endpoints empty allowed_origins surface as an empty array', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			ws_endpoints: [{ path: '/api/ws', allowed_origins: [], actions: [] }]
		});

		assert.deepStrictEqual(surface.ws_endpoints[0]!.allowed_origins, []);
	});

	test('ws_endpoints must be resolved — an origin-less spec is a type error', () => {
		const unresolved: WsEndpointSpec = { path: '/api/ws', actions: [] };
		assert.throws(() =>
			generate_app_surface({
				route_specs: [],
				middleware_specs: [],
				// @ts-expect-error an unresolved spec has no `allowed_origins` to record
				ws_endpoints: [unresolved]
			})
		);
	});
});

describe('create_app_surface_spec', () => {
	test('bundles surface with source specs', () => {
		const route = create_route();
		const mw = create_middleware();

		const spec = create_app_surface_spec({ route_specs: [route], middleware_specs: [mw] });

		assert.ok(spec.surface);
		assert.strictEqual(spec.route_specs.length, 1);
		assert.strictEqual(spec.middleware_specs.length, 1);
		assert.strictEqual(spec.route_specs[0], route);
		assert.strictEqual(spec.middleware_specs[0], mw);
	});

	test('carries each route error map, the one the surface writes', () => {
		const route = create_route({
			path: '/api/things',
			auth: { account: 'required', actor: 'none' }
		});
		const mw = create_middleware({ path: '/api/*', errors: [rest_error(403, 'gate_refused')] });

		const spec = create_app_surface_spec({ route_specs: [route], middleware_specs: [mw] });

		assert.deepStrictEqual([...spec.route_errors.keys()], ['GET /api/things']);
		const errors = spec.route_errors.get('GET /api/things')!;
		assert.deepStrictEqual(
			errors.defs.map((def) => def.code),
			['authentication_required', 'gate_refused']
		);
		assert.deepStrictEqual(Object.keys(spec.surface.routes[0]!.error_schemas!), ['401', '403']);
	});

	test('takes a prebuilt route error map, which the surface writes', () => {
		const route = create_route({ path: '/api/things' });
		const route_errors = new Map([
			['GET /api/things', { defs: [], schemas: { 418: rest_error(418, 'teapot').schema } }]
		]);
		const spec = create_app_surface_spec({
			route_specs: [route],
			middleware_specs: [],
			route_errors
		});
		assert.strictEqual(spec.route_errors, route_errors);
		assert.deepStrictEqual(Object.keys(spec.surface.routes[0]!.error_schemas!), ['418']);
	});
});

describe('env_schema_to_surface', () => {
	test('extracts env entries from schema', () => {
		const schema = object({
			PORT: with_default(number, 4040),
			SECRET: string
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
		assert.strictEqual(secret.optional, false);
	});

	test('detects sensitivity from meta', () => {
		const schema = object({
			API_KEY: meta(string, { sensitivity: 'secret', description: 'The API key' })
		});

		const entries = env_schema_to_surface(schema);

		assert.strictEqual(entries[0]!.sensitivity, 'secret');
		assert.strictEqual(entries[0]!.description, 'The API key');
	});

	test('reads sensitivity and description under wrappers', () => {
		const secret = (description: string) => meta(string, { sensitivity: 'secret', description });
		const schema = object({
			OPTIONAL_KEY: optional(secret('Optional')),
			DEFAULT_KEY: with_default(secret('Default'), 'x'),
			NULLABLE_KEY: nullable(secret('Nullable'))
		});

		for (const entry of env_schema_to_surface(schema)) {
			assert.strictEqual(entry.sensitivity, 'secret', entry.name);
			assert.notStrictEqual(entry.description, '', entry.name);
		}
	});

	test('reads sensitivity in a later pipe step and a union option', () => {
		const schema = object({
			PIPED: pipe(
				string,
				meta(
					transform((v: string) => v),
					{ sensitivity: 'secret' }
				)
			),
			UNION: union([number, meta(string, { sensitivity: 'secret' })])
		});

		for (const entry of env_schema_to_surface(schema)) {
			assert.strictEqual(entry.sensitivity, 'secret', entry.name);
		}
	});

	test('a mark inside or outside a message is read', () => {
		const schema = object({
			INSIDE: message(meta(string, { sensitivity: 'secret' }), 'required'),
			OUTSIDE: meta(message(string, 'required'), { sensitivity: 'secret' })
		});

		const [inside, outside] = env_schema_to_surface(schema);

		assert.strictEqual(inside!.sensitivity, 'secret');
		assert.strictEqual(outside!.sensitivity, 'secret');
	});

	test('optional and has_default are what a parse of undefined does', () => {
		const schema = object({
			REQUIRED: string,
			OPTIONAL: optional(string),
			DEFAULT: with_default(string, 'x'),
			// a default of `undefined` is optional and has no default, as in Zod
			DEFAULT_UNDEFINED: with_default(optional(string), undefined),
			DEFAULT_FN: with_default_fn(string, () => 'made'),
			// an `optional` outside the default answers first
			OPTIONAL_DEFAULT: optional(with_default(string, 'x')),
			NULLABLE: nullable(string)
		});

		const by_name = Object.fromEntries(
			env_schema_to_surface(schema).map((e) => [e.name, [e.optional, e.has_default]])
		);

		assert.deepStrictEqual(by_name, {
			REQUIRED: [false, false],
			OPTIONAL: [true, false],
			DEFAULT: [true, true],
			DEFAULT_UNDEFINED: [true, false],
			DEFAULT_FN: [true, true],
			OPTIONAL_DEFAULT: [true, false],
			NULLABLE: [false, false]
		});
	});

	test('description is empty without meta', () => {
		const entries = env_schema_to_surface(object({ BARE: string }));
		assert.strictEqual(entries[0]!.description, '');
	});

	test('throws on a schema that is not an object schema', () => {
		assert.throws(() => env_schema_to_surface(string), TypeError);
	});

	test('non-sensitive fields default to sensitivity=null', () => {
		const schema = object({
			PORT: with_default(number, 3000)
		});

		const entries = env_schema_to_surface(schema);

		assert.strictEqual(entries[0]!.sensitivity, null);
	});
});

describe('events_to_surface', () => {
	test('converts event specs to surface entries', () => {
		const specs: Array<EventSpec> = [
			{
				method: 'created',
				params: z.strictObject({ id: z.string() }),
				description: 'Created',
				channel: 'things'
			},
			{ method: 'deleted', params: z.strictObject({ id: z.string() }), description: 'Deleted' }
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

describe('generate_app_surface — JSON Schema writing', () => {
	test('describes a route input on its input side, through a transform', () => {
		// the default output side throws on a transform; this route used to
		// read as taking no input
		const route = create_route({
			method: 'POST',
			path: '/named',
			input: z.strictObject({
				name: z
					.string()
					.min(3)
					.transform((s) => s.toLowerCase())
			})
		});
		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });
		const input = surface.routes[0]!.input_schema as Record<string, any>;
		assert.deepStrictEqual(input.properties.name, { type: 'string', minLength: 3 });
		assert.deepStrictEqual(surface.diagnostics, []);
	});

	test('writes an output transform as {} and records an info diagnostic', () => {
		const route = create_route({
			path: '/status',
			output: z.strictObject({ name: z.string().transform((s) => s.toLowerCase()) })
		});
		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });
		const output = surface.routes[0]!.output_schema as Record<string, any>;
		assert.deepStrictEqual(output.properties.name, {});
		assert.strictEqual(surface.diagnostics.length, 1);
		const [diagnostic] = surface.diagnostics;
		assert.strictEqual(diagnostic!.level, 'info');
		assert.strictEqual(diagnostic!.category, 'schema');
		assert.strictEqual(diagnostic!.source, 'GET /status output');
	});

	test('throws naming the route for an output with no JSON Schema form', () => {
		const route = create_route({ path: '/blob', output: z.custom<Blob>((v) => v instanceof Blob) });
		assert.throws(
			() => generate_app_surface({ route_specs: [route], middleware_specs: [] }),
			/^GET \/blob output: has no JSON Schema form/
		);
	});

	test('writes z.void() as null, a parameterless input', () => {
		const route = create_route({ method: 'POST', path: '/ping', input: z.void() });
		const surface = generate_app_surface({ route_specs: [route], middleware_specs: [] });
		assert.strictEqual(surface.routes[0]!.input_schema, null);
	});

	test('writes fuz_schema schemas with their own emitter', () => {
		// `RouteSpec` and `EventSpec` type their schemas as Zod today; the cast
		// stands in for the widening that lets a fuz_schema schema reach here
		const route = create_route({
			method: 'POST',
			path: '/things',
			input: object({ name: pipe(string, min_length(1)), n: with_default(number, 1) }) as never,
			output: object({
				id: string,
				size: pipe(
					string,
					transform((s: string) => s.length)
				)
			}) as never
		});
		const event: EventSpec = {
			method: 'thing_created',
			params: object({ id: string }) as never,
			description: 'Created'
		};
		const surface = generate_app_surface({
			route_specs: [route],
			middleware_specs: [],
			event_specs: [event]
		});
		const [r] = surface.routes;
		assert.deepStrictEqual(r!.input_schema, {
			type: 'object',
			properties: { name: { type: 'string', minLength: 1 }, n: { type: 'number' } },
			required: ['name'],
			additionalProperties: false
		});
		assert.deepStrictEqual(r!.output_schema, {
			type: 'object',
			properties: { id: { type: 'string' }, size: {} },
			required: ['id', 'size'],
			additionalProperties: false
		});
		assert.deepStrictEqual(surface.events[0]!.params_schema, {
			type: 'object',
			properties: { id: { type: 'string' } },
			required: ['id'],
			additionalProperties: false
		});
		assert.deepStrictEqual(
			surface.diagnostics.map((d) => [d.level, d.source]),
			[['info', 'POST /things output']]
		);
	});
});

describe('the non-strict input warning', () => {
	const warnings = (input: RouteSpec['input']) =>
		generate_app_surface({
			route_specs: [create_route({ method: 'POST', input })],
			middleware_specs: []
		}).diagnostics.filter((d) => d.level === 'warning');

	test('names z.strictObject() for a Zod input', () => {
		assert.deepStrictEqual(warnings(z.object({ x: z.string() })), [
			{
				level: 'warning',
				category: 'schema',
				message: 'Input schema is not z.strictObject() — unknown keys will be silently stripped',
				source: 'POST /test input'
			}
		]);
	});

	test('names the strict fuz_schema object for a strip_object or loose_object input', () => {
		const expected: Array<AppSurfaceDiagnostic> = [
			{
				level: 'warning',
				category: 'schema',
				message:
					'Input schema is not a strict object (@fuzdev/fuz_schema `object`) — unknown keys may not be refused',
				source: 'POST /test input'
			}
		];
		assert.deepStrictEqual(warnings(strip_object({ x: string })), expected);
		assert.deepStrictEqual(warnings(loose_object({ x: string })), expected);
	});

	test('is absent for a strict fuz_schema object', () => {
		assert.deepStrictEqual(warnings(object({ x: string })), []);
	});
});

describe('error definitions on the surface', () => {
	test('a route and a middleware definition are written as loose objects of their code', () => {
		const surface = generate_app_surface({
			route_specs: [create_route({ errors: [rest_error(404, 'thing_not_found')] })],
			middleware_specs: [create_middleware({ errors: [rest_error(503, 'down')] })]
		});
		assert.deepStrictEqual(surface.routes[0]!.error_schemas?.['404'], {
			type: 'object',
			properties: { error: { type: 'string', const: 'thing_not_found' } },
			required: ['error'],
			additionalProperties: {}
		});
		assert.deepStrictEqual(surface.middleware[0]!.error_schemas, {
			'503': {
				type: 'object',
				properties: { error: { type: 'string', const: 'down' } },
				required: ['error'],
				additionalProperties: {}
			}
		});
	});
});
