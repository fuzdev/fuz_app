/**
 * Tests for `http/route_errors.ts` — each route's error map: the derived
 * definitions narrowed to the slots a route has, unioned with every applying
 * middleware layer's and the route's own, and the app's maps keyed
 * `METHOD path`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import { literal, object, parse, string } from '@fuzdev/fuz_schema/schema.ts';

import {
	get_route_error_map,
	resolve_app_route_error_maps,
	resolve_route_error_map,
	type RouteErrorMap,
	type RouteErrorMapSpec
} from '#lib/http/route_errors.ts';
import { format_route_key } from '#lib/http/surface_query.ts';
import {
	REST_AUTHENTICATION_REQUIRED,
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP,
	REST_INVALID_ROUTE_PARAMS,
	rest_error,
	type RestErrorDef
} from '#lib/http/error_schemas.ts';

/** A route's error map as `status code` rows, in order. */
const rows = (errors: RouteErrorMap): Array<string> =>
	errors.defs.map((def) => `${def.status} ${def.code}`);

const NONE = { account: 'none', actor: 'none' } as const;

describe('resolve_route_error_map — narrowing to the slots a route has', () => {
	test('a public GET with no slots answers nothing of its own', () => {
		const errors = resolve_route_error_map({
			method: 'GET',
			path: '/x',
			auth: NONE,
			input: z.null()
		});
		assert.deepStrictEqual(errors.defs, []);
		assert.deepStrictEqual(errors.schemas, {});
	});

	test('a GET with an input declares no body code', () => {
		const errors = resolve_route_error_map({
			method: 'GET',
			path: '/x',
			auth: NONE,
			input: z.strictObject({ name: z.string() })
		});
		assert.deepStrictEqual(rows(errors), []);
	});

	test('a DELETE with a body declares the body codes and no 415', () => {
		const errors = resolve_route_error_map({
			method: 'DELETE',
			path: '/x',
			auth: NONE,
			input: object({ name: string })
		});
		assert.deepStrictEqual(rows(errors), ['400 invalid_request_body', '400 invalid_json_body']);
	});

	test('params alone declare only the route-params code', () => {
		const errors = resolve_route_error_map({
			method: 'GET',
			path: '/x/:id',
			auth: NONE,
			input: literal(null),
			params: object({ id: string })
		});
		assert.deepStrictEqual(rows(errors), ['400 invalid_route_params']);
		assert.strictEqual(errors.schemas[400], REST_INVALID_ROUTE_PARAMS.schema);
	});

	test('a query alone declares only the query code', () => {
		const errors = resolve_route_error_map({
			method: 'GET',
			path: '/x',
			auth: NONE,
			input: z.null(),
			query: z.strictObject({ q: z.string() })
		});
		assert.deepStrictEqual(rows(errors), ['400 invalid_query_params']);
	});

	test('an RPC endpoint, a POST with a null input, declares only the 415', () => {
		const errors = resolve_route_error_map({
			method: 'POST',
			path: '/api/rpc',
			auth: NONE,
			input: z.null()
		});
		assert.deepStrictEqual(rows(errors), ['415 unsupported_content_type']);
	});

	test('the auth axes and the rate limit', () => {
		const errors = resolve_route_error_map({
			method: 'GET',
			path: '/x',
			auth: { account: 'required', actor: 'none', roles: ['admin'] },
			input: z.null(),
			rate_limit: 'ip'
		});
		assert.deepStrictEqual(rows(errors), [
			'401 authentication_required',
			'403 insufficient_permissions',
			'429 rate_limit_exceeded'
		]);
	});
});

describe('resolve_route_error_map — the union of derived, middleware, and explicit', () => {
	const gate_403 = rest_error(403, 'gate_refused');
	const other_403 = rest_error(403, 'other_refused');
	const down = rest_error(503, 'down');
	const spec: RouteErrorMapSpec = {
		method: 'POST',
		path: '/api/things',
		auth: { account: 'required', actor: 'none', roles: ['admin'] },
		input: object({ name: string }),
		errors: [rest_error(400, 'name_taken'), rest_error(403, 'thing_locked')]
	};
	const mw = (
		name: string,
		path: string,
		errors: ReadonlyArray<RestErrorDef>,
		carve_outs?: Array<{ path: string; reason: string }>
	) => ({ name, path, errors, ...(carve_outs && { carve_outs }) });

	test('every layer adds its definitions, in order, replacing none', () => {
		const errors = resolve_route_error_map(spec, [
			mw('a', '*', [gate_403]),
			mw('b', '/api/*', [other_403, down])
		]);
		assert.deepStrictEqual(rows(errors), [
			'400 invalid_request_body',
			'400 invalid_json_body',
			'401 authentication_required',
			'403 insufficient_permissions',
			'415 unsupported_content_type',
			'403 gate_refused',
			'403 other_refused',
			'503 down',
			'400 name_taken',
			'403 thing_locked'
		]);
		const admits = (status: number, error: string): boolean =>
			parse(errors.schemas[status]!, { error, required_roles: ['admin'] }).ok;
		// at one status, each layer's body: derived, both middleware, the route's own
		for (const code of [
			'insufficient_permissions',
			'gate_refused',
			'other_refused',
			'thing_locked'
		]) {
			assert.ok(admits(403, code), code);
		}
		assert.ok(admits(400, 'invalid_request_body'));
		assert.ok(admits(400, 'name_taken'));
		assert.ok(!admits(400, 'invalid_query_params'));
	});

	test('a middleware layer adds to another at the same status, replacing nothing', () => {
		const errors = resolve_route_error_map(
			{ method: 'GET', path: '/api/x', auth: NONE, input: z.null() },
			[mw('a', '*', [gate_403]), mw('b', '*', [other_403])]
		);
		assert.deepStrictEqual(rows(errors), ['403 gate_refused', '403 other_refused']);
		assert.deepStrictEqual(errors.schemas[403]!.def, [gate_403.schema, other_403.schema]);
	});

	test('a definition declared by two layers counts once, at its first place', () => {
		const errors = resolve_route_error_map(
			{
				method: 'GET',
				path: '/api/x',
				auth: { account: 'required', actor: 'none' },
				input: z.null(),
				errors: [REST_AUTHENTICATION_REQUIRED, gate_403, rest_error(403, 'gate_refused')]
			},
			[mw('a', '*', [gate_403]), mw('b', '*', [gate_403])]
		);
		assert.deepStrictEqual(rows(errors), ['401 authentication_required', '403 gate_refused']);
		assert.strictEqual(errors.schemas[401], REST_AUTHENTICATION_REQUIRED.schema);
		assert.strictEqual(errors.schemas[403], gate_403.schema);
	});

	test('two shapes of one code at one status are both kept, a union of their bodies', () => {
		const errors = resolve_route_error_map({
			method: 'GET',
			path: '/api/account/status',
			auth: { account: 'required', actor: 'none' },
			input: z.null(),
			errors: [REST_AUTHENTICATION_REQUIRED_BOOTSTRAP]
		});
		assert.deepStrictEqual(errors.defs, [
			REST_AUTHENTICATION_REQUIRED,
			REST_AUTHENTICATION_REQUIRED_BOOTSTRAP
		]);
		const schema = errors.schemas[401]!;
		assert.deepStrictEqual(schema.def, [
			REST_AUTHENTICATION_REQUIRED.schema,
			REST_AUTHENTICATION_REQUIRED_BOOTSTRAP.schema
		]);
		assert.ok(parse(schema, { error: 'authentication_required' }).ok);
		assert.ok(parse(schema, { error: 'authentication_required', bootstrap_available: true }).ok);
	});

	test('a middleware layer contributes only where it runs: its path, less its carve-outs', () => {
		const layers = [
			mw('api', '/api/*', [gate_403]),
			mw('exact', '/api/one', [other_403]),
			mw('carved', '*', [down], [{ path: '/api/files/*', reason: 'its own cap' }])
		];
		const at = (path: string): Array<string> =>
			rows(resolve_route_error_map({ method: 'GET', path, auth: NONE, input: z.null() }, layers));
		assert.deepStrictEqual(at('/api/one'), ['403 gate_refused', '403 other_refused', '503 down']);
		assert.deepStrictEqual(at('/api'), ['403 gate_refused', '503 down']);
		assert.deepStrictEqual(at('/apiary'), ['503 down']);
		assert.deepStrictEqual(at('/api/files/:name'), ['403 gate_refused']);
		assert.deepStrictEqual(at('/health'), ['503 down']);
	});

	test('no middleware list is the route alone', () => {
		assert.deepStrictEqual(
			resolve_route_error_map(spec, null).defs,
			resolve_route_error_map(spec, []).defs
		);
	});
});

describe('resolve_app_route_error_maps and get_route_error_map', () => {
	const route = (method: 'GET' | 'POST', path: string): RouteErrorMapSpec => ({
		method,
		path,
		auth: NONE,
		input: z.null()
	});
	const layers = [{ path: '*', errors: [rest_error(403, 'gate_refused')] }];

	test('each route keyed METHOD path, resolved against the one middleware list', () => {
		const map = resolve_app_route_error_maps([route('GET', '/a'), route('POST', '/a')], layers);
		assert.deepStrictEqual([...map.keys()], ['GET /a', 'POST /a']);
		assert.deepStrictEqual(rows(map.get('POST /a')!), [
			'415 unsupported_content_type',
			'403 gate_refused'
		]);
		assert.strictEqual(format_route_key(route('GET', '/a')), 'GET /a');
	});

	test('get_route_error_map reads the map, or with no map resolves the route alone', () => {
		const map = resolve_app_route_error_maps([route('GET', '/a')], layers);
		assert.strictEqual(get_route_error_map(map, route('GET', '/a')), map.get('GET /a'));
		assert.deepStrictEqual(rows(get_route_error_map(null, route('GET', '/a'))), []);
		assert.deepStrictEqual(rows(get_route_error_map(undefined, route('GET', '/a'))), []);
	});

	test('get_route_error_map throws, naming the key, for a route the given map lacks', () => {
		const map = resolve_app_route_error_maps([route('GET', '/a')], layers);
		assert.throws(
			() => get_route_error_map(map, route('GET', '/b')),
			/^get_route_error_map: the route error maps have no entry for 'GET \/b'$/
		);
		assert.throws(() => get_route_error_map(new Map(), route('POST', '/a')), /'POST \/a'/);
	});
});
