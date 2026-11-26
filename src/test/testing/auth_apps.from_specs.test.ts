/**
 * Tests for `create_test_app_from_specs`.
 *
 * @module
 */

import { route_ok } from '#lib/http/route_result.ts';
import { describe, assert, test } from 'vitest';
import { literal, object } from '@fuzdev/fuz_schema/schema.ts';
import { create_test_app_from_specs } from '#lib/testing/auth_apps.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import { ActingActor } from '#lib/primitive_schemas.ts';

/** The content type every non-`raw_body` POST route requires. */
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('create_test_app_from_specs', () => {
	const test_specs: Array<RouteSpec> = [
		define_route({
			method: 'GET',
			path: '/public',
			auth: { account: 'none', actor: 'none' },
			handler: () => route_ok({ ok: true }),
			description: 'Public route',
			input: literal(null),
			output: object({ ok: literal(true) })
		}),
		define_route({
			method: 'GET',
			path: '/protected',
			auth: { account: 'required', actor: 'none' },
			handler: () => route_ok({ secret: true }),
			description: 'Protected route',
			input: literal(null),
			output: object({ secret: literal(true) })
		}),
		define_route({
			method: 'POST',
			path: '/admin',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			handler: () => route_ok({ admin: true }),
			description: 'Admin route',
			query: object({ acting: ActingActor }),
			input: literal(null),
			output: object({ admin: literal(true) })
		})
	];

	test('creates app without auth context', async () => {
		const app = create_test_app_from_specs(test_specs);
		const res = await app.request('/public');
		assert.strictEqual(res.status, 200);
	});

	test('unauthenticated app returns 401 for protected routes', async () => {
		const app = create_test_app_from_specs(test_specs);
		const res = await app.request('/protected');
		assert.strictEqual(res.status, 401);
	});

	test('authenticated app passes auth guard', async () => {
		const ctx = create_test_context();
		const app = create_test_app_from_specs(test_specs, ctx);
		const res = await app.request('/protected');
		assert.strictEqual(res.status, 200);
	});

	test('role app passes role guard', async () => {
		const ctx = create_test_context([{ role: 'admin' }]);
		const app = create_test_app_from_specs(test_specs, ctx);
		const res = await app.request('/admin', { method: 'POST', headers: JSON_HEADERS });
		assert.strictEqual(res.status, 200);
	});
});
