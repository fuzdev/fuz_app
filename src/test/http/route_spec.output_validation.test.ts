/**
 * Tests for the DEV-only output validation `apply_route_specs` wraps around
 * every REST handler: 2xx JSON against `output`, non-JSON responses skipped,
 * and error responses left to the DEV error check
 * (`dev_route_error_check.test.ts`). Mismatches log and pass the response
 * through unchanged.
 *
 * @module
 */

import { describe, assert, test, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { DEV } from 'esm-env';

import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { jsonrpc_errors } from '#lib/http/jsonrpc_errors.ts';
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
		errors: [REST_SLUG_TAKEN],
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

describe('DEV output validation', () => {
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

	test('an error response is left to the DEV error check', async () => {
		const got = await request((c) => c.json({ error: 'other_reason' }, 409));
		assert.strictEqual(got.status, 409);
		assert.deepStrictEqual(got.errors, []);
		const thrown = await request(() => {
			throw jsonrpc_errors.conflict();
		});
		assert.strictEqual(thrown.status, 409);
		assert.deepStrictEqual(JSON.parse(thrown.body), { error: 'conflict' });
		assert.deepStrictEqual(thrown.errors, []);
	});

	test('a JSON-looking 2xx body that is not JSON by its Content-Type is not checked', async () => {
		const got = await request((c) => c.text('{"ok":"yes"}'));
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.errors, []);
	});

	test('a non-JSON response is skipped', async () => {
		const got = await request((c) => c.text('not json'));
		assert.strictEqual(got.status, 200);
		assert.deepStrictEqual(got.errors, []);
	});
});
