/**
 * `default_in_process_suite_options` builds its `surface_source` from the
 * same inputs it hands the live `create_test_app` — including
 * `app_options.surface_route`, so the surface-derived suites probe
 * `GET /api/surface` exactly when the live app serves it, and the
 * `daemon_token` layer `create_test_app` always mounts.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import { default_in_process_suite_options } from '$lib/testing/cross_backend/in_process_setup.ts';
import { create_spine_surface_spec } from '$lib/testing/cross_backend/default_spine_surface.ts';

const session_options = create_session_config('test_session');

for (const surface_route of [undefined, false, true] as const) {
	test(`surface_source lists GET /api/surface iff the live app mounts it (surface_route: ${surface_route})`, () => {
		const { surface_source } = default_in_process_suite_options({
			session_options,
			create_route_specs: () => [create_health_route_spec()],
			app_options: surface_route === undefined ? undefined : { surface_route }
		});
		assert.strictEqual(
			surface_source.surface.routes.some((r) => r.method === 'GET' && r.path === '/api/surface'),
			surface_route === true
		);
	});
}

test('surface_source lists the daemon_token layer create_test_app mounts', () => {
	const { surface_source } = default_in_process_suite_options({
		session_options,
		create_route_specs: () => [create_health_route_spec()]
	});
	assert.ok(surface_source.surface.middleware.some((m) => m.name === 'daemon_token'));
});

test('the shared spine surface lists the daemon_token layer both spine binaries mount', () => {
	assert.ok(create_spine_surface_spec().surface.middleware.some((m) => m.name === 'daemon_token'));
});
