/**
 * The bare-hash fact route's defense-in-depth admin re-check: reached with an
 * acting actor but no global admin grant (an auth-shape regression that
 * dropped the role gate), the handler answers a masked 404 and logs at error.
 * Reached with no request context at all, the spec's handler throws before
 * it runs (`define_route`), which the error catch answers 500.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_serve_fact_route_spec } from '#lib/server/serve_fact_route.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import {
	emit_route_response,
	prepare_route_response,
	type RouteContext
} from '#lib/http/route_spec.ts';

describe('create_serve_fact_route_spec handler re-check', () => {
	test('an actor without a global admin grant → 404, logged at error', async () => {
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const spec = create_serve_fact_route_spec({ facts_dir: '/tmp/facts', log });
		// mount the bare handler, as a regression that skipped the auth gate would
		const app = new Hono();
		app.get(spec.path, async (c) => {
			const result = await spec.handler({
				params: { hash: `blake3:${'0'.repeat(64)}` },
				auth: create_test_context()
			} as unknown as RouteContext);
			return emit_route_response(
				c,
				prepare_route_response(result, { label: 'GET', opened_sse: new Map() })
			);
		});

		const res = await app.request('/api/facts/x');

		assert.strictEqual(res.status, 404);
		assert.strictEqual(errors.length, 1);
	});

	test('no request context → the handler throws before it runs', async () => {
		const spec = create_serve_fact_route_spec({
			facts_dir: '/tmp/facts',
			log: new Logger('test', { level: 'off' })
		});
		let threw: unknown;
		try {
			await spec.handler({ params: {}, auth: null } as unknown as RouteContext);
		} catch (error) {
			threw = error;
		}
		assert.ok(threw instanceof Error);
		assert.include(threw.message, 'no request context');
	});
});
