/**
 * The bare-hash fact route's defense-in-depth admin re-check: reached without
 * a global admin grant (an auth-shape regression), the handler answers a
 * masked 404 and logs at error.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_serve_fact_route_spec } from '#lib/server/serve_fact_route.ts';
import type { RouteContext } from '#lib/http/route_spec.ts';

describe('create_serve_fact_route_spec handler re-check', () => {
	test('no admin context → 404, logged at error', async () => {
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const spec = create_serve_fact_route_spec({ facts_dir: '/tmp/facts', log });
		// mount the bare handler, as a regression that skipped the auth gate would
		const app = new Hono();
		app.get(spec.path, (c) => {
			c.set('validated_params', { hash: `blake3:${'0'.repeat(64)}` });
			return spec.handler(c, {} as RouteContext);
		});

		const res = await app.request('/api/facts/x');

		assert.strictEqual(res.status, 404);
		assert.strictEqual(errors.length, 1);
	});
});
