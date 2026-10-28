/**
 * Tests for the DEV-only output + error validation `apply_route_specs` wraps
 * around every REST handler: 2xx JSON against `output`, non-2xx JSON against
 * the merged error schema for its status — returned or built by the error
 * catch from a thrown error — and non-JSON responses skipped. Mismatches log
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
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { jsonrpc_errors } from '#lib/http/jsonrpc_errors.ts';
import { ActingActor } from '#lib/http/auth_shape.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

const db = create_stub_db();

const Output = z.strictObject({ ok: z.literal(true) });
const ConflictError = z.object({ error: z.literal('slug_taken') });

/**
 * Mount one route (a GET by default) and return its response plus the
 * `log.error` calls it made.
 */
const request = async (
	handler: RouteSpec['handler'],
	overrides?: Partial<RouteSpec>
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
		errors: { 409: ConflictError },
		...overrides
	};
	apply_route_specs(app, [spec], fuz_auth_guard_resolver, log, db);
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
