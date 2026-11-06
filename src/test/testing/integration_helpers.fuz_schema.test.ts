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
import { assert_response_matches_spec } from '#lib/testing/integration_helpers.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { resolve_app_route_errors } from '#lib/http/schema_helpers.ts';

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
			/^Error schema mismatch for POST \/api\/things \(409\): \[\{"kind":"literal"/
		);
	});
});

describe('assert_response_matches_spec reads the route error map it is given', () => {
	const route_errors = resolve_app_route_errors(
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
			route_errors
		);
		await assert_response_matches_spec(
			[spec],
			'POST',
			'/api/things',
			json({ error: 'thing_taken' }, 409),
			route_errors
		);
	});

	test('on a jsonrpc route a JSON-RPC error envelope is no REST error body, so it is not checked', async () => {
		const rpc_spec: RouteSpec = { ...spec, jsonrpc: true };
		await assert_response_matches_spec(
			[rpc_spec],
			'POST',
			'/api/things',
			json(ENVELOPE, 409),
			resolve_app_route_errors([rpc_spec], [])
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
				route_errors
			);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Error schema mismatch for POST \/api\/things \(409\)/);
	});

	test("without the map it is the route's own, the middleware's code refused", async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec([spec], 'POST', '/api/things', gate_conflict());
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(err.message, /^Error schema mismatch for POST \/api\/things \(409\)/);
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
		// a GET with no slots declares no 400 at all, so the status is unchecked
		assert.strictEqual(err, undefined);
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
