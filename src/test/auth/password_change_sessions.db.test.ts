/**
 * Integration test verifying password change revokes all sessions
 * and subsequent auth flows work correctly.
 *
 * Exercises the full pipeline: login 3 times → change password →
 * verify all sessions revoked → login with new password succeeds.
 *
 * @module
 */

import {describe, test, assert, beforeAll, afterAll} from 'vitest';

import {create_test_app, type TestApp} from '$lib/testing/app_server.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {prefix_route_specs} from '$lib/http/route_spec.js';
import {query_session_list_for_account} from '$lib/auth/session_queries.js';

const session_options = create_session_config('test_session');

describe('password change multi-session invalidation', () => {
	let test_app: TestApp;

	beforeAll(async () => {
		test_app = await create_test_app({
			session_options,
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

	test('all sessions are revoked after password change', async () => {
		const login_headers = {
			'Content-Type': 'application/json',
			host: 'localhost',
			origin: 'http://localhost:5173',
		};

		// Log in 3 times to create 3 sessions (capturing each Set-Cookie)
		const session_cookies: Array<string> = [];
		for (let i = 0; i < 3; i++) {
			const res = await test_app.app.request('/api/account/login', {
				method: 'POST',
				headers: login_headers,
				body: JSON.stringify({username: 'keeper', password: 'test-password-123'}),
			});
			assert.strictEqual(res.status, 200, `login ${i + 1} should succeed`);
			const set_cookie = res.headers.get('set-cookie');
			assert.ok(set_cookie, `login ${i + 1} should set a cookie`);
			session_cookies.push(set_cookie.split(';')[0]!);
		}

		// Use the first session to POST /password with correct current + new password
		const change_res = await test_app.app.request('/api/account/password', {
			method: 'POST',
			headers: {
				...login_headers,
				cookie: session_cookies[0]!,
			},
			body: JSON.stringify({
				current_password: 'test-password-123',
				new_password: 'new-password-456789',
			}),
		});
		assert.strictEqual(change_res.status, 200);
		const change_body = await change_res.json();

		// Verify sessions_revoked count (1 bootstrap + 3 logins = 4)
		assert.strictEqual(change_body.ok, true);
		assert.strictEqual(change_body.sessions_revoked, 4);

		// Verify all 3 login session cookies are now invalid
		for (let i = 0; i < 3; i++) {
			const verify_res = await test_app.app.request('/api/account/verify', {
				headers: {
					host: 'localhost',
					origin: 'http://localhost:5173',
					cookie: session_cookies[i]!,
				},
			});
			assert.strictEqual(verify_res.status, 401, `session ${i + 1} should be revoked`);
		}

		// Verify DB state: zero session rows remain (transaction atomicity)
		const remaining_sessions = await query_session_list_for_account(
			{db: test_app.backend.deps.db},
			test_app.backend.account.id,
		);
		assert.strictEqual(
			remaining_sessions.length,
			0,
			'no session rows should remain after password change',
		);

		// Verify login works with the new password
		const new_login_res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({username: 'keeper', password: 'new-password-456789'}),
		});
		assert.strictEqual(new_login_res.status, 200, 'login with new password should succeed');

		// Verify login with old password fails
		const old_login_res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({username: 'keeper', password: 'test-password-123'}),
		});
		assert.strictEqual(old_login_res.status, 401, 'login with old password should fail');
	});
});
