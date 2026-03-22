/**
 * Tests for `create_auth_middleware_specs` — auth middleware stack factory.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_auth_middleware_specs} from '$lib/auth/middleware.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {stub_app_deps} from '$lib/testing/stubs.js';

const session_options = create_session_config('test_session');

const base_config = {
	allowed_origins: [/^http:\/\/localhost/],
	session_options,
	bearer_ip_rate_limiter: null,
};

describe('create_auth_middleware_specs', () => {
	test('returns 4 middleware specs by default', async () => {
		const specs = await create_auth_middleware_specs(stub_app_deps, base_config);
		assert.equal(specs.length, 4);
		const names = specs.map((s) => s.name);
		assert.deepEqual(names, ['origin', 'session', 'request_context', 'bearer_auth']);
	});

	test('all specs use default path /api/*', async () => {
		const specs = await create_auth_middleware_specs(stub_app_deps, base_config);
		for (const spec of specs) {
			assert.equal(spec.path, '/api/*');
		}
	});

	test('custom path is applied to all specs', async () => {
		const specs = await create_auth_middleware_specs(stub_app_deps, {
			...base_config,
			path: '/custom/*',
		});
		for (const spec of specs) {
			assert.equal(spec.path, '/custom/*');
		}
	});

	test('appends daemon_token middleware when daemon_token_state is provided', async () => {
		const specs = await create_auth_middleware_specs(stub_app_deps, {
			...base_config,
			daemon_token_state: {
				current_token: 'test-token',
				previous_token: null,
			} as any,
		});
		assert.equal(specs.length, 5);
		const names = specs.map((s) => s.name);
		assert.deepEqual(names, [
			'origin',
			'session',
			'request_context',
			'bearer_auth',
			'daemon_token',
		]);
	});

	test('daemon_token middleware uses custom path', async () => {
		const specs = await create_auth_middleware_specs(stub_app_deps, {
			...base_config,
			path: '/custom/*',
			daemon_token_state: {
				current_token: 'test-token',
				previous_token: null,
			} as any,
		});
		const daemon = specs.find((s) => s.name === 'daemon_token');
		assert.ok(daemon);
		assert.equal(daemon.path, '/custom/*');
	});

	test('all specs have handler functions', async () => {
		const specs = await create_auth_middleware_specs(stub_app_deps, base_config);
		for (const spec of specs) {
			assert.equal(typeof spec.handler, 'function');
		}
	});

	test('bearer_ip_rate_limiter null disables rate limiting', async () => {
		// Should not throw — null is a valid opt-out
		const specs = await create_auth_middleware_specs(stub_app_deps, {
			...base_config,
			bearer_ip_rate_limiter: null,
		});
		assert.equal(specs.length, 4);
		const bearer = specs.find((s) => s.name === 'bearer_auth');
		assert.ok(bearer);
	});
});
