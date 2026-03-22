/**
 * Tests for middleware/auth - auth middleware stack factory.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {create_auth_middleware_specs, type AuthMiddlewareOptions} from '$lib/auth/middleware.js';
import {RateLimiter} from '$lib/rate_limiter.js';
import {create_stub_app_deps} from '$lib/testing/stubs.js';

const create_options = (overrides?: Partial<AuthMiddlewareOptions>): AuthMiddlewareOptions => ({
	allowed_origins: [],
	session_options: {
		cookie_name: 'test_session',
		context_key: 'session_identity',
		encode_identity: (id: string) => id,
		decode_identity: (payload: string) => payload,
	},
	bearer_ip_rate_limiter: null,
	...overrides,
});

describe('create_auth_middleware_specs', () => {
	test('returns 4 middleware specs by default', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		assert.strictEqual(specs.length, 4);
	});

	test('middleware names are origin, session, request_context, bearer_auth', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const names = specs.map((s) => s.name);
		assert.deepStrictEqual(names, ['origin', 'session', 'request_context', 'bearer_auth']);
	});

	test('all middleware use default /api/* path', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		for (const spec of specs) {
			assert.strictEqual(spec.path, '/api/*');
		}
	});

	test('custom path is applied to all middleware', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options({path: '/custom/*'}));
		for (const spec of specs) {
			assert.strictEqual(spec.path, '/custom/*');
		}
	});

	test('appends daemon_token middleware when daemon_token_state is provided', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({
				daemon_token_state: {
					current_token: 'tok123',
					previous_token: null,
					rotated_at: new Date(),
					keeper_account_id: null,
				},
			}),
		);
		assert.strictEqual(specs.length, 5);
		assert.strictEqual(specs[4]!.name, 'daemon_token');
	});

	test('origin middleware has 403 error schema', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const origin = specs.find((s) => s.name === 'origin')!;
		assert.ok(origin.errors);
		assert.ok(origin.errors[403]);
	});

	test('bearer_auth middleware has 401, 403, 429 error schemas', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const bearer = specs.find((s) => s.name === 'bearer_auth')!;
		assert.ok(bearer.errors);
		assert.ok(bearer.errors[401]);
		assert.ok(bearer.errors[403]);
		assert.ok(bearer.errors[429]);
	});

	test('session and request_context have no error schemas', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const session = specs.find((s) => s.name === 'session')!;
		const rc = specs.find((s) => s.name === 'request_context')!;
		assert.strictEqual(session.errors, undefined);
		assert.strictEqual(rc.errors, undefined);
	});

	test('daemon_token middleware has 401, 500, 503 error schemas', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({
				daemon_token_state: {
					current_token: 'tok',
					previous_token: null,
					rotated_at: new Date(),
					keeper_account_id: null,
				},
			}),
		);
		const dt = specs.find((s) => s.name === 'daemon_token')!;
		assert.ok(dt.errors);
		assert.ok(dt.errors[401]);
		assert.ok(dt.errors[500]);
		assert.ok(dt.errors[503]);
	});

	test('bearer_ip_rate_limiter null disables rate limiting', async () => {
		const deps = create_stub_app_deps();
		// null = explicit opt-out — should not throw
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({bearer_ip_rate_limiter: null}),
		);
		assert.strictEqual(specs.length, 4);
	});

	test('custom bearer_ip_rate_limiter is accepted', async () => {
		const deps = create_stub_app_deps();
		const custom_limiter = new RateLimiter({
			max_attempts: 100,
			window_ms: 60_000,
			cleanup_interval_ms: 0,
		});
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({bearer_ip_rate_limiter: custom_limiter}),
		);
		assert.strictEqual(specs.length, 4);
	});

	test('all specs have handler functions', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		for (const spec of specs) {
			assert.strictEqual(typeof spec.handler, 'function');
		}
	});
});
