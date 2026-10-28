/**
 * The disabled-floor banner of `auth/fail_floor.ts` — once per module
 * instance per floor, from the login and signup route factories, silent for a
 * positive floor — and the floor delay itself.
 *
 * @module
 */

import { describe, assert, test, vi, afterEach } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_stub_app_deps } from '#lib/testing/stubs.ts';

/**
 * A fresh module graph, so the once-per-module flags start unset whatever
 * earlier tests in the run assembled.
 */
const import_fresh = async () => {
	vi.resetModules();
	const fail_floor = await import('#lib/auth/fail_floor.ts');
	const { create_account_route_specs } = await import('#lib/auth/account_routes.ts');
	const { create_signup_route_specs } = await import('#lib/auth/signup_routes.ts');
	return { ...fail_floor, create_account_route_specs, create_signup_route_specs };
};

const session_options = create_session_config('test_session');

const route_deps = () => ({
	...create_stub_app_deps(),
	log: new Logger('test:fail_floor', { level: 'off' })
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('warn_if_fail_floor_disabled', () => {
	test('the login and signup factories each announce a zero floor once', async () => {
		const fresh = await import_fresh();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const login = (login_fail_floor_ms: number) =>
			fresh.create_account_route_specs(route_deps(), {
				session_options,
				login_ip_rate_limiter: null,
				login_account_rate_limiter: null,
				login_fail_floor_ms
			});
		const signup = (signup_fail_floor_ms: number) =>
			fresh.create_signup_route_specs(route_deps(), {
				session_options,
				signup_ip_rate_limiter: null,
				signup_account_rate_limiter: null,
				signup_fail_floor_ms
			});
		login(0);
		login(-1);
		signup(0);
		signup(0);
		assert.deepStrictEqual(error_spy.mock.calls, [
			[fresh.LOGIN_FAIL_FLOOR_DISABLED_BANNER],
			[fresh.SIGNUP_FAIL_FLOOR_DISABLED_BANNER]
		]);
		assert.include(fresh.LOGIN_FAIL_FLOOR_DISABLED_BANNER, 'LOGIN FAILURE TIMING FLOOR DISABLED');
		assert.include(fresh.SIGNUP_FAIL_FLOOR_DISABLED_BANNER, 'SIGNUP FAILURE TIMING FLOOR DISABLED');
	});

	test('a negative floor announces on its own', async () => {
		const fresh = await import_fresh();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		fresh.warn_if_fail_floor_disabled('login', -1, new Logger('test:fail_floor', { level: 'off' }));
		assert.deepStrictEqual(error_spy.mock.calls, [[fresh.LOGIN_FAIL_FLOOR_DISABLED_BANNER]]);
	});

	test('a positive floor, the default included, prints nothing', async () => {
		const fresh = await import_fresh();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		fresh.create_account_route_specs(route_deps(), {
			session_options,
			login_ip_rate_limiter: null,
			login_account_rate_limiter: null
		});
		fresh.create_signup_route_specs(route_deps(), {
			session_options,
			signup_ip_rate_limiter: null,
			signup_account_rate_limiter: null,
			signup_fail_floor_ms: 1
		});
		assert.deepStrictEqual(error_spy.mock.calls, []);
	});

	test('logs the warning beside the banner', async () => {
		const fresh = await import_fresh();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = new Logger('test:fail_floor', { level: 'off' });
		const warn_spy = vi.spyOn(log, 'warn');
		fresh.warn_if_fail_floor_disabled('signup', 0, log);
		fresh.warn_if_fail_floor_disabled('signup', 0, log);
		assert.strictEqual(warn_spy.mock.calls.length, 1);
		assert.include(String(warn_spy.mock.calls[0]![0]), 'signup failure timing floor disabled');
	});
});

describe('start_fail_floor', () => {
	test('resolves after the floor, within the jitter window', async () => {
		const { start_fail_floor } = await import('#lib/auth/fail_floor.ts');
		vi.useFakeTimers();
		try {
			let resolved = false;
			void start_fail_floor(100, 10).then(() => {
				resolved = true;
			});
			await vi.advanceTimersByTimeAsync(89);
			assert.isFalse(resolved, 'resolved before floor - jitter');
			await vi.advanceTimersByTimeAsync(21);
			assert.isTrue(resolved, 'not resolved by floor + jitter');
		} finally {
			vi.useRealTimers();
		}
	});

	test('the jitter reaches both ends of its window', async () => {
		const { start_fail_floor } = await import('#lib/auth/fail_floor.ts');
		vi.useFakeTimers();
		try {
			for (const [random, at] of [
				[0, 90],
				[0.9999, 110]
			] as const) {
				vi.spyOn(Math, 'random').mockReturnValue(random);
				let resolved = false;
				void start_fail_floor(100, 10).then(() => {
					resolved = true;
				});
				await vi.advanceTimersByTimeAsync(at - 1);
				assert.isFalse(resolved, `random ${random}: resolved before ${at}ms`);
				await vi.advanceTimersByTimeAsync(1);
				assert.isTrue(resolved, `random ${random}: not resolved at ${at}ms`);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test('resolves at once when the floor is disabled', async () => {
		const { start_fail_floor } = await import('#lib/auth/fail_floor.ts');
		vi.useFakeTimers();
		try {
			let resolved = false;
			void start_fail_floor(0, 25).then(() => {
				resolved = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			assert.isTrue(resolved);
		} finally {
			vi.useRealTimers();
		}
	});
});
