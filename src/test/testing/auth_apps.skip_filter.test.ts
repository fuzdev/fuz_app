/**
 * Tests for `create_route_skip_filter`, the adversarial suites' skip predicate.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_route_skip_filter } from '#lib/testing/auth_apps.ts';

const routes = [
	{ method: 'GET', path: '/:slug_with_git{.+\\.git}/info/refs' },
	{ method: 'DELETE', path: '/api/files/:filename{.+}' },
	{ method: 'GET', path: '/api/kept' }
];

describe('create_route_skip_filter', () => {
	test('skips the named routes, regex params included', () => {
		const is_skipped = create_route_skip_filter(
			'suite',
			['GET /:slug_with_git{.+\\.git}/info/refs', 'DELETE /api/files/:filename{.+}'],
			routes
		);
		assert.deepEqual(
			routes.map((r) => is_skipped(r)),
			[true, true, false]
		);
	});

	test('skips nothing for no list', () => {
		const is_skipped = create_route_skip_filter('suite', undefined, routes);
		assert.isFalse(routes.some((r) => is_skipped(r)));
	});

	test('throws on an entry naming no route, naming the suite', () => {
		assert.throws(
			() => create_route_skip_filter('describe_adversarial_auth', ['GET /api/gone'], routes),
			"describe_adversarial_auth: skip_routes names 'GET /api/gone', which is not a route on the surface"
		);
	});
});
