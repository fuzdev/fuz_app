/**
 * Integration test verifying the login handler calls the correct password
 * verification branch — behavioral test, not a timing test.
 *
 * - Non-existent username → `verify_dummy` called (timing attack resistance)
 * - Existing username, wrong password → `verify_password` called
 *
 * @module
 */

import {describe, test, assert, beforeAll, afterAll, beforeEach} from 'vitest';

import {create_test_app, stub_password_deps, type TestApp} from '$lib/testing/app_server.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {prefix_route_specs} from '$lib/http/route_spec.js';
import type {PasswordHashDeps} from '$lib/auth/password.js';

const session_options = create_session_config('test_session');

interface TrackingPasswordDeps {
	deps: PasswordHashDeps;
	verify_password_count: number;
	verify_dummy_count: number;
	reset: () => void;
}

const create_tracking_password_deps = (): TrackingPasswordDeps => {
	const state = {verify_password_count: 0, verify_dummy_count: 0};
	const deps: PasswordHashDeps = {
		hash_password: stub_password_deps.hash_password,
		verify_password: async (p, h) => {
			state.verify_password_count++;
			return stub_password_deps.verify_password(p, h);
		},
		verify_dummy: async (p) => {
			state.verify_dummy_count++;
			return stub_password_deps.verify_dummy(p);
		},
	};
	return {
		deps,
		get verify_password_count() {
			return state.verify_password_count;
		},
		get verify_dummy_count() {
			return state.verify_dummy_count;
		},
		reset() {
			state.verify_password_count = 0;
			state.verify_dummy_count = 0;
		},
	};
};

describe('login verify_dummy behavior', () => {
	let test_app: TestApp;
	const tracking = create_tracking_password_deps();

	beforeAll(async () => {
		test_app = await create_test_app({
			session_options,
			password: tracking.deps,
			create_route_specs: (ctx) =>
				prefix_route_specs(
					'/api/account',
					create_account_route_specs(ctx.deps, {
						session_options,
						ip_rate_limiter: ctx.ip_rate_limiter,
						login_account_rate_limiter: ctx.login_account_rate_limiter,
					}),
				),
		});
	});

	afterAll(async () => {
		await test_app.cleanup();
	});

	beforeEach(() => {
		tracking.reset();
	});

	const login_headers = {
		'Content-Type': 'application/json',
		host: 'localhost',
		origin: 'http://localhost:5173',
	};

	test('non-existent username calls verify_dummy, not verify_password', async () => {
		const res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({username: 'nonexistent', password: 'any-password-1234'}),
		});
		assert.strictEqual(res.status, 401);
		assert.strictEqual(tracking.verify_dummy_count, 1, 'verify_dummy should be called once');
		assert.strictEqual(tracking.verify_password_count, 0, 'verify_password should not be called');
	});

	test('existing username with wrong password calls verify_password, not verify_dummy', async () => {
		const res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({username: 'keeper', password: 'wrong-password-1234'}),
		});
		assert.strictEqual(res.status, 401);
		assert.strictEqual(tracking.verify_password_count, 1, 'verify_password should be called once');
		assert.strictEqual(tracking.verify_dummy_count, 0, 'verify_dummy should not be called');
	});
});
