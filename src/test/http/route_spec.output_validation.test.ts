/**
 * Tests for the DEV-only output + error validation `apply_route_specs` wraps
 * around every REST handler: 2xx JSON against `output`, non-2xx JSON against
 * the route's error map at its status (`resolve_route_errors`) — returned or
 * built by the error catch from a thrown error — and non-JSON responses
 * skipped. Mismatches log
 * and pass the response through unchanged.
 *
 * @module
 */

import { describe, assert, test, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { DEV } from 'esm-env';

import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { resolve_app_route_errors } from '#lib/http/schema_helpers.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { jsonrpc_errors } from '#lib/http/jsonrpc_errors.ts';
import { ActingActor } from '#lib/http/auth_shape.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

const db = create_stub_db();

const Output = z.strictObject({ ok: z.literal(true) });
const REST_SLUG_TAKEN = rest_error(409, 'slug_taken');

/**
 * Mount one route (a GET by default) and return its response plus the
 * `log.error` calls it made.
 */
const request = async (
	handler: RouteSpec['handler'],
	overrides?: Partial<RouteSpec>,
	middleware_specs?: Array<MiddlewareSpec>
): Promise<{ status: number; body: string; errors: Array<string> }> => {
	const log = new Logger('test', { level: 'off' });
	const error_spy = vi.spyOn(log, 'error');
	const app = new Hono();
	const spec: RouteSpec = {
		method: 'GET',
		path: '/v',
		auth: { account: 'none', actor: 'none' },
		handler,
		description: 'validation probe',
		input: z.null(),
		output: Output,
		errors: [REST_SLUG_TAKEN],
		...overrides
	};
	apply_route_specs(
		app,
		[spec],
		fuz_auth_guard_resolver,
		log,
		db,
		undefined,
		middleware_specs && resolve_app_route_errors([spec], middleware_specs)
	);
	const res = await app.request(
		'/v',
		spec.method === 'GET'
			? undefined
			: { method: spec.method, body: '{}', headers: { 'Content-Type': 'application/json' } }
	);
	return {
		status: res.status,
		body: await res.text(),
		errors: error_spy.mock.calls.map((call) => String(call[0]))
	};
};

describe('DEV output + error validation', () => {
	test('runs in the test environment', () => {
		assert.isTrue(DEV);
	});

	test('a 2xx body matching the output schema logs nothing', async () => {
		const got = await request((c) => c.json({ ok: true }));
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.errors, []);
	});

	test('a 2xx body off the output schema logs and passes through', async () => {
		const got = await request((c) => c.json({ ok: 'yes' }));
		assert.strictEqual(got.status, 200);
		assert.strictEqual(got.body, '{"ok":"yes"}');
		assert.deepStrictEqual(got.errors, ['Output schema mismatch: GET /v']);
	});

	test('a returned error body off its status schema logs', async () => {
		const got = await request((c) => c.json({ error: 'other_reason' }, 409));
		assert.strictEqual(got.status, 409);
		assert.deepStrictEqual(got.errors, ['Error schema mismatch (409): GET /v']);
	});

	test('a thrown error whose REST body is off its status schema logs', async () => {
		const got = await request(() => {
			throw jsonrpc_errors.conflict();
		});
		assert.strictEqual(got.status, 409);
		assert.deepStrictEqual(JSON.parse(got.body), { error: 'conflict' });
		assert.deepStrictEqual(got.errors, ['Error schema mismatch (409): GET /v']);
	});

	test('a thrown error whose REST body matches its status schema logs nothing', async () => {
		const got = await request(() => {
			throw jsonrpc_errors.conflict('slug taken', { reason: 'slug_taken' });
		});
		assert.strictEqual(got.status, 409);
		assert.deepStrictEqual(got.errors, []);
	});

	test('a generic throw on an actor-grain route logs only the unhandled error', async () => {
		// an actor-grain route's derived 500 schema lists only the authorization
		// phase's reasons, never the catch layer's `internal_error`
		const got = await request(
			() => {
				throw new Error('boom');
			},
			{
				method: 'POST',
				auth: { account: 'optional', actor: 'optional' },
				input: z.strictObject({ acting: ActingActor })
			}
		);
		assert.strictEqual(got.status, 500);
		assert.strictEqual(JSON.parse(got.body).error, 'internal_error');
		assert.deepStrictEqual(got.errors, ['Unhandled handler error']);
	});

	test('a definition at a derived status adds a branch, replacing none', async () => {
		const overrides: Partial<RouteSpec> = {
			method: 'POST',
			input: z.strictObject({}),
			errors: [rest_error(400, 'name_taken')]
		};
		const derived = await request((c) => c.json({ error: 'invalid_request_body' }, 400), overrides);
		assert.strictEqual(derived.status, 400);
		assert.deepStrictEqual(derived.errors, []);
		const own = await request((c) => c.json({ error: 'name_taken' }, 400), overrides);
		assert.deepStrictEqual(own.errors, []);
		const neither = await request((c) => c.json({ error: 'other' }, 400), overrides);
		assert.deepStrictEqual(neither.errors, ['Error schema mismatch (400): POST /v']);
	});

	test('on a jsonrpc route, a JSON-RPC error envelope at a declared status is not checked', async () => {
		const envelope = {
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'Invalid Request' }
		};
		const got = await request((c) => c.json(envelope, 409), { jsonrpc: true });
		assert.strictEqual(got.status, 409);
		assert.deepStrictEqual(got.errors, []);
		// a REST body there still is
		const rest = await request((c) => c.json({ error: { code: -32600 } }, 409), { jsonrpc: true });
		assert.deepStrictEqual(rest.errors, ['Error schema mismatch (409): GET /v']);
	});

	test('on a REST route, an envelope-shaped body is checked like any error body', async () => {
		const envelope = {
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'Invalid Request' }
		};
		const got = await request((c) => c.json(envelope, 409));
		assert.strictEqual(got.status, 409);
		assert.deepStrictEqual(got.errors, ['Error schema mismatch (409): GET /v']);
	});

	test('a GET declares no body code: its 400 is only what its slots derive', async () => {
		const got = await request((c) => c.json({ error: 'invalid_request_body' }, 400), {
			method: 'GET',
			input: z.strictObject({}),
			query: z.strictObject({})
		});
		assert.deepStrictEqual(got.errors, ['Error schema mismatch (400): GET /v']);
		const query = await request((c) => c.json({ error: 'invalid_query_params' }, 400), {
			query: z.strictObject({})
		});
		assert.deepStrictEqual(query.errors, []);
	});

	test('the error map apply_route_specs is given carries the middleware definitions', async () => {
		const mw: MiddlewareSpec = {
			name: 'gate',
			path: '*',
			handler: async (_c, next) => next(),
			errors: [rest_error(409, 'gate_conflict')]
		};
		const handler: RouteSpec['handler'] = (c) => c.json({ error: 'gate_conflict' }, 409);
		assert.deepStrictEqual((await request(handler, {}, [mw])).errors, []);
		// without the map, the route's own: the middleware's code is off it
		assert.deepStrictEqual((await request(handler)).errors, [
			'Error schema mismatch (409): GET /v'
		]);
	});

	test('an error status with no declared schema is not validated', async () => {
		const got = await request((c) => c.json({ anything: 1 }, 418));
		assert.strictEqual(got.status, 418);
		assert.deepStrictEqual(got.errors, []);
	});

	test('a non-JSON response is skipped', async () => {
		const got = await request((c) => c.text('not json'));
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.errors, []);
	});
});
