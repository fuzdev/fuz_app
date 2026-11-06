/**
 * `assert_response_matches_spec` over a route whose output is
 * `@fuzdev/fuz_schema` and whose error is a definition: a matching body
 * passes, a mismatch throws with the fuz_schema issues, and the error map
 * read is the one given, middleware included, or the route's own.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { object, string } from '@fuzdev/fuz_schema/schema.ts';

import type { RouteSpec } from '#lib/http/route_spec.ts';
import { assert_response_matches_spec, find_route_spec } from '#lib/testing/integration_helpers.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { resolve_app_route_error_maps } from '#lib/http/route_errors.ts';

const spec: RouteSpec = {
	method: 'POST',
	path: '/api/things',
	auth: { account: 'none', actor: 'none' },
	description: 'Creates a thing.',
	input: object({ name: string }),
	output: object({ id: string }),
	errors: [rest_error(409, 'thing_taken')],
	handler: (c) => c.json({ id: 'x' })
};

const ENVELOPE = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } };

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

describe('assert_response_matches_spec on a fuz_schema route', () => {
	test('passes a matching output and error body', async () => {
		await assert_response_matches_spec([spec], 'POST', '/api/things', json({ id: 'x' }, 200));
		await assert_response_matches_spec(
			[spec],
			'POST',
			'/api/things',
			json({ error: 'thing_taken' }, 409)
		);
	});

	test('throws on an output mismatch', async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec([spec], 'POST', '/api/things', json({ id: 5 }, 200));
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(
			err.message,
			/^Output schema mismatch for POST \/api\/things \(200\): \[\{"kind":"string"/
		);
	});

	test('throws on an error-body mismatch with the fuz_schema issues', async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec(
				[spec],
				'POST',
				'/api/things',
				json({ error: 'other' }, 409)
			);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(
			err.message,
			/^Error schema mismatch \(409\): POST \/api\/things: \[\{"kind":"literal"/
		);
	});
});

describe('assert_response_matches_spec reads the route error map it is given', () => {
	const route_error_maps = resolve_app_route_error_maps(
		[spec],
		[{ path: '/api/*', errors: [rest_error(409, 'gate_conflict')] }]
	);
	const gate_conflict = () => json({ error: 'gate_conflict' }, 409);

	test("a middleware's definition passes with the map", async () => {
		await assert_response_matches_spec(
			[spec],
			'POST',
			'/api/things',
			gate_conflict(),
			route_error_maps
		);
		await assert_response_matches_spec(
			[spec],
			'POST',
			'/api/things',
			json({ error: 'thing_taken' }, 409),
			route_error_maps
		);
	});

	test('on a jsonrpc route a JSON-RPC error envelope is no REST error body, so it is not checked', async () => {
		const rpc_spec: RouteSpec = { ...spec, jsonrpc: true };
		await assert_response_matches_spec(
			[rpc_spec],
			'POST',
			'/api/things',
			json(ENVELOPE, 409),
			resolve_app_route_error_maps([rpc_spec], [])
		);
	});

	test('on a REST route an envelope-shaped body is checked like any error body', async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec(
				[spec],
				'POST',
				'/api/things',
				json(ENVELOPE, 409),
				route_error_maps
			);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Error schema mismatch \(409\): POST \/api\/things: /);
	});

	test("without the map it is the route's own, the middleware's code refused", async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec([spec], 'POST', '/api/things', gate_conflict());
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Error schema mismatch \(409\): POST \/api\/things: /);
	});

	test('a GET-style narrowing holds: a body code is off a route with no body', async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec(
				[{ ...spec, method: 'GET' }],
				'GET',
				'/api/things',
				json({ error: 'invalid_request_body' }, 400)
			);
		} catch (e) {
			err = e;
		}
		// a GET with no slots declares no 400 at all, so the status is undeclared
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Undeclared error status \(400\): GET \/api\/things: /);
		let post_err: unknown;
		try {
			await assert_response_matches_spec(
				[spec],
				'POST',
				'/api/things',
				json({ error: 'invalid_query_params' }, 400)
			);
		} catch (e) {
			post_err = e;
		}
		assert.ok(post_err instanceof Error, 'a POST with no query declares no query code');
	});
});

describe('assert_response_matches_spec fails an undeclared status', () => {
	const fails = async (response: Response, route: RouteSpec = spec): Promise<Error | null> => {
		try {
			await assert_response_matches_spec([route], route.method, route.path, response);
		} catch (e) {
			assert.ok(e instanceof Error);
			return e;
		}
		return null;
	};

	test('a JSON error at a status the map lacks throws, naming it', async () => {
		const err = await fails(json({ error: 'teapot' }, 418));
		assert.ok(err);
		assert.strictEqual(
			err.message,
			'Undeclared error status (418): POST /api/things: {"error":"teapot"}'
		);
	});

	test('a 500 internal_error and a 503 service_unavailable are always accepted', async () => {
		assert.isNull(await fails(json({ error: 'internal_error', message: 'boom' }, 500)));
		assert.isNull(await fails(json({ error: 'service_unavailable' }, 503)));
		// any other body at those statuses is undeclared
		assert.ok(await fails(json({ error: 'boom' }, 500)));
		assert.ok(await fails(json({ error: 'internal_error' }, 503)));
	});

	test('a non-JSON error at an undeclared status passes', async () => {
		assert.isNull(await fails(new Response('Internal Server Error', { status: 500 })));
		assert.isNull(await fails(new Response('404 Not Found', { status: 404 })));
	});

	test('on a jsonrpc route an envelope at any status passes; a REST body does not', async () => {
		const rpc: RouteSpec = { ...spec, jsonrpc: true };
		assert.isNull(await fails(json(ENVELOPE, 418), rpc));
		assert.ok(await fails(json({ error: 'teapot' }, 418), rpc));
		// off a jsonrpc route, an envelope is a REST body like any other
		assert.ok(await fails(json(ENVELOPE, 418)));
	});

	test('a JSON-looking text body is not checked: the Content-Type is the gate', async () => {
		assert.isNull(
			await fails(
				new Response('{"error":"x"}', { status: 418, headers: { 'content-type': 'text/plain' } })
			)
		);
	});

	test('a 3xx is not an error status', async () => {
		assert.isNull(await fails(json({ moved: true }, 301)));
	});
});

describe('find_route_spec takes the route Hono dispatches to', () => {
	const route = (method: RouteSpec['method'], path: string): RouteSpec => ({
		...spec,
		method,
		path,
		input: object({}),
		errors: []
	});
	const param = route('GET', '/a/:id');
	const me = route('GET', '/a/me');
	const specs = [param, me, route('GET', '/f/:name{[0-9]+}')];

	test('the first matching in mount order, not an exact path first', () => {
		assert.strictEqual(find_route_spec(specs, 'GET', '/a/me'), param);
		assert.strictEqual(find_route_spec([me, param], 'GET', '/a/me'), me);
		assert.strictEqual(find_route_spec(specs, 'GET', '/a/x'), param);
		assert.strictEqual(find_route_spec(specs, 'GET', '/a/x/y'), undefined);
	});

	test('HEAD reads as GET', () => {
		assert.strictEqual(find_route_spec(specs, 'HEAD', '/a/me'), param);
	});

	test('a template passed as the path finds its own spec', () => {
		assert.strictEqual(find_route_spec(specs, 'GET', '/a/:id'), param);
		assert.strictEqual(find_route_spec(specs, 'GET', '/f/:name{[0-9]+}'), specs[2]);
		assert.strictEqual(find_route_spec(specs, 'GET', '/f/12'), specs[2]);
	});

	test('a `:` inside a segment is no template: mount order still rules', () => {
		const id = route('GET', '/v1/:id');
		const upload = route('GET', '/v1/files:upload');
		assert.strictEqual(find_route_spec([id, upload], 'GET', '/v1/files:upload'), id);
		const api_id = route('GET', '/api/:id');
		const xy = route('GET', '/api/x:y');
		assert.strictEqual(find_route_spec([api_id, xy], 'GET', '/api/x:y'), api_id);
	});

	test('the path is read as Hono reads it', () => {
		const cafe = route('GET', '/a/café');
		const digits = route('GET', '/a/:id{[0-9]+}');
		const ab = route('GET', '/a/b');
		const things = route('GET', '/things');
		const root = route('GET', '/');
		const all = [cafe, digits, ab, things, root];
		assert.strictEqual(find_route_spec(all, 'GET', '/a/caf%C3%A9'), cafe);
		assert.strictEqual(find_route_spec(all, 'GET', '/a/%31'), digits);
		assert.strictEqual(find_route_spec(all, 'GET', '/a/./b'), ab);
		assert.strictEqual(find_route_spec(all, 'GET', '/things?x=1'), things);
		assert.strictEqual(find_route_spec(all, 'GET', ''), root);
		// a malformed escape is matched raw
		assert.strictEqual(find_route_spec(all, 'GET', '/a/%E0%A4%A'), undefined);
	});

	test("the helper checks the dispatched route's map", async () => {
		// `/a/me` declares a 409 its param sibling doesn't; Hono dispatches to the sibling
		const shadowed = { ...me, errors: [rest_error(409, 'me_taken')] };
		let err: unknown;
		try {
			await assert_response_matches_spec(
				[param, shadowed],
				'GET',
				'/a/me',
				json({ error: 'me_taken' }, 409)
			);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Undeclared error status \(409\): GET \/a\/me: /);
	});
});
