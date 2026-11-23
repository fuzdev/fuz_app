/**
 * `create_test_app_from_specs` — each request's effects are flushed before
 * its response returns, as the server's pending-effects layer flushes them.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';

import { create_test_app_from_specs } from '#lib/testing/auth_apps.ts';
import { define_route } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import { emit_after_commit } from '#lib/http/pending_effects.ts';

test("a handler's deferred and eager effects have run when its response returns", async () => {
	const ran: Array<string> = [];
	const app = create_test_app_from_specs([
		define_route({
			method: 'GET',
			path: '/effects',
			auth: { account: 'none', actor: 'none' },
			description: 'Queues one effect of each kind.',
			input: literal(null),
			output: loose_object({}),
			handler: (route) => {
				emit_after_commit(route, () => {
					ran.push('deferred');
				});
				route.pending_effects.push(
					new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
						ran.push('eager');
					})
				);
				return route_ok({});
			}
		})
	]);
	const res = await app.request('/effects');
	assert.strictEqual(res.status, 200);
	assert.deepStrictEqual(ran, ['deferred', 'eager']);
});
