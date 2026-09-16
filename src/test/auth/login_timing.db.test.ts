/**
 * Login timing-hardening tests.
 *
 * Two aspects, both guarding against username-enumeration timing oracles:
 *
 * - **Branch behavior** (`login verify_dummy behavior`) — the login handler
 *   calls the correct password verification branch:
 *   - Non-existent username → `verify_dummy` called (Argon2id timing equalized)
 *   - Existing username, wrong password → `verify_password` called
 * - **Wall-clock floor** (`login denial timing floor`) — every 401 elapses at
 *   least the configured `login_fail_floor_ms`, so the cheap not-found path and
 *   the expensive found-wrong-password path converge in observed time. This is
 *   the login twin of the signup floor asserted in
 *   `invite_signup.integration.db.test.ts`, and pins the floor mechanism that
 *   `docs/security.md` §"Login timing" advertises.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll, beforeEach } from 'vitest';

import { create_test_app, stub_password_deps, type TestApp } from '$lib/testing/app_server.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { prefix_route_specs, type RouteSpec } from '$lib/http/route_spec.ts';
import type { PasswordHashDeps } from '$lib/auth/password.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';

const session_options = create_session_config('test_session');

const login_headers = {
	'Content-Type': 'application/json',
	host: 'localhost',
	origin: 'http://localhost:5173'
};

interface TrackingPasswordDeps {
	deps: PasswordHashDeps;
	verify_password_count: number;
	verify_dummy_count: number;
	reset: () => void;
}

const create_tracking_password_deps = (): TrackingPasswordDeps => {
	const state = { verify_password_count: 0, verify_dummy_count: 0 };
	const deps: PasswordHashDeps = {
		hash_password: stub_password_deps.hash_password,
		verify_password: async (p, h) => {
			state.verify_password_count++;
			return stub_password_deps.verify_password(p, h);
		},
		verify_dummy: async (p) => {
			state.verify_dummy_count++;
			return stub_password_deps.verify_dummy(p);
		}
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
		}
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
						// these tests assert the verify-branch, not timing — skip the
						// ~250ms denial floor so they stay fast (the floor has its own
						// describe block below)
						login_fail_floor_ms: 0
					})
				)
		});
	});

	afterAll(async () => {
		await test_app.cleanup();
	});

	beforeEach(() => {
		tracking.reset();
	});

	test('non-existent username calls verify_dummy, not verify_password', async () => {
		const res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({ username: 'nonexistent', password: 'any-password-1234' })
		});
		assert.strictEqual(res.status, 401);
		assert.strictEqual(tracking.verify_dummy_count, 1, 'verify_dummy should be called once');
		assert.strictEqual(tracking.verify_password_count, 0, 'verify_password should not be called');
	});

	test('existing username with wrong password calls verify_password, not verify_dummy', async () => {
		const res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({ username: 'keeper', password: 'wrong-password-1234' })
		});
		assert.strictEqual(res.status, 401);
		assert.strictEqual(tracking.verify_password_count, 1, 'verify_password should be called once');
		assert.strictEqual(tracking.verify_dummy_count, 0, 'verify_dummy should not be called');
	});
});

// --- Denial timing floor ---
//
// Without a floor, an attacker distinguishes the cheap not-found path from the
// expensive found-wrong-password path (Argon2id + DB) by response time and uses
// the gap as a username-enumeration oracle. The handler races failure work
// against `setTimeout(floor + jitter)`, so observed time is `max(work, delay)`.
// The default stub password deps make the work fast, so elapsed ≈ the floor.
// Mirrors `invite_signup.integration.db.test.ts` §"signup denial timing floor".
describe('login denial timing floor', () => {
	const FLOOR_MS = 80;
	// Dedicated factory with a non-zero floor and no jitter (determinism); the
	// behavioral suite above disables the floor so it stays fast.
	const create_route_specs_floored = (ctx: AppServerContext): Array<RouteSpec> =>
		prefix_route_specs(
			'/api/account',
			create_account_route_specs(ctx.deps, {
				session_options,
				ip_rate_limiter: ctx.ip_rate_limiter,
				login_account_rate_limiter: ctx.login_account_rate_limiter,
				login_fail_floor_ms: FLOOR_MS,
				login_fail_jitter_ms: 0
			})
		);

	test('non-existent username (401) takes at least the floor', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_route_specs_floored
		});
		const t0 = performance.now();
		const res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({ username: 'nonexistent-floor', password: 'any-password-1234' })
		});
		const elapsed = performance.now() - t0;
		await test_app.cleanup();
		assert.strictEqual(res.status, 401);
		// Generous lower bound — setTimeout granularity is ~1-15ms across
		// platforms and `performance.now()` is bucketed.
		assert.ok(
			elapsed >= FLOOR_MS - 10,
			`expected elapsed (${elapsed.toFixed(1)}ms) >= ${FLOOR_MS - 10}ms (floor=${FLOOR_MS})`
		);
	});

	test('existing username with wrong password (401) takes at least the floor', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_route_specs_floored
		});
		const t0 = performance.now();
		const res = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({
				username: test_app.backend.account.username,
				password: 'wrong-password-1234'
			})
		});
		const elapsed = performance.now() - t0;
		await test_app.cleanup();
		assert.strictEqual(res.status, 401);
		assert.ok(
			elapsed >= FLOOR_MS - 10,
			`expected elapsed (${elapsed.toFixed(1)}ms) >= ${FLOOR_MS - 10}ms (floor=${FLOOR_MS})`
		);
	});
});
