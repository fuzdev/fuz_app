/**
 * The two pure steps of `create_app_server`'s assembly, unit-tested apart from
 * it: `resolve_rate_limiters` (an explicit option wins, the mode decides an
 * omitted one, and only the built limiters are reported for disposal) and
 * `collect_config_diagnostics` (the config-level surface warnings).
 *
 * The same precedence and diagnostics through an assembled server are
 * `create_app_server.close.test.ts`.
 *
 * @module
 */

import { afterEach, assert, describe, test } from 'vitest';

import {
	APP_SERVER_RATE_LIMITER_KEYS,
	collect_config_diagnostics,
	resolve_rate_limiters,
	type AppServerRateLimiterKey,
	type ResolvedRateLimiters
} from '$lib/server/app_server.ts';
import {
	RateLimiter,
	create_rate_limiter,
	default_action_account_rate_limit,
	default_action_ip_rate_limit,
	default_login_account_rate_limit,
	default_login_ip_rate_limit,
	type RateLimiterOptions
} from '$lib/rate_limiter.ts';

// every built limiter is disposed, so no cleanup timer outlives a test
const resolved: Array<ResolvedRateLimiters> = [];
afterEach(() => {
	for (const { built } of resolved.splice(0)) {
		for (const limiter of built) limiter.dispose();
	}
});

const resolve = (...args: Parameters<typeof resolve_rate_limiters>): ResolvedRateLimiters => {
	const result = resolve_rate_limiters(...args);
	resolved.push(result);
	return result;
};

const all_null = (): Record<AppServerRateLimiterKey, null> =>
	Object.fromEntries(APP_SERVER_RATE_LIMITER_KEYS.map((key) => [key, null])) as Record<
		AppServerRateLimiterKey,
		null
	>;

describe('resolve_rate_limiters', () => {
	test('an omitted mode is enforced: every limiter built, one per option', () => {
		const { mode, limiters, built } = resolve({});
		assert.strictEqual(mode, 'enforced');
		assert.deepStrictEqual(Object.keys(limiters), [...APP_SERVER_RATE_LIMITER_KEYS]);
		for (const key of APP_SERVER_RATE_LIMITER_KEYS) assert.instanceOf(limiters[key], RateLimiter);
		assert.deepStrictEqual(
			built,
			APP_SERVER_RATE_LIMITER_KEYS.map((key) => limiters[key]),
			'built in key order'
		);
		assert.strictEqual(
			new Set(built).size,
			APP_SERVER_RATE_LIMITER_KEYS.length,
			'no shared bucket'
		);
	});

	test('each built limiter takes its surface defaults', () => {
		const expected: Record<AppServerRateLimiterKey, RateLimiterOptions> = {
			login_ip_rate_limiter: default_login_ip_rate_limit,
			signup_ip_rate_limiter: default_login_ip_rate_limit,
			bootstrap_ip_rate_limiter: default_login_ip_rate_limit,
			login_account_rate_limiter: default_login_account_rate_limit,
			signup_account_rate_limiter: default_login_account_rate_limit,
			action_ip_rate_limiter: default_action_ip_rate_limit,
			action_account_rate_limiter: default_action_account_rate_limit
		};
		const { limiters } = resolve({ rate_limiters: 'enforced' });
		for (const key of APP_SERVER_RATE_LIMITER_KEYS) {
			assert.deepStrictEqual(limiters[key]!.options, expected[key], key);
			assert.notStrictEqual(limiters[key]!.options, expected[key], `${key} copies its defaults`);
		}
	});

	test('the disabled mode nulls an omitted limiter and builds nothing', () => {
		const { mode, limiters, built } = resolve({ rate_limiters: 'disabled_for_testing' });
		assert.strictEqual(mode, 'disabled_for_testing');
		for (const key of APP_SERVER_RATE_LIMITER_KEYS) assert.strictEqual(limiters[key], null, key);
		assert.deepStrictEqual(built, []);
	});

	for (const mode of ['enforced', 'disabled_for_testing'] as const) {
		test(`under ${mode}, an explicit instance or null wins and is never reported built`, () => {
			const injected = create_rate_limiter({ cleanup_interval_ms: 0 });
			const { limiters, built } = resolve({
				rate_limiters: mode,
				login_ip_rate_limiter: injected,
				action_account_rate_limiter: null
			});
			assert.strictEqual(limiters.login_ip_rate_limiter, injected);
			assert.strictEqual(limiters.action_account_rate_limiter, null);
			assert.ok(!built.includes(injected), 'the caller owns the injected limiter');
			const omitted = APP_SERVER_RATE_LIMITER_KEYS.filter(
				(key) => key !== 'login_ip_rate_limiter' && key !== 'action_account_rate_limiter'
			);
			assert.strictEqual(built.length, mode === 'enforced' ? omitted.length : 0);
			for (const key of omitted) {
				if (mode === 'enforced') assert.ok(built.includes(limiters[key]!), key);
				else assert.strictEqual(limiters[key], null, key);
			}
		});
	}
});

describe('collect_config_diagnostics', () => {
	const enforced = () => resolve({}).limiters;

	test('none for the default cookie and enforced limiters', () => {
		assert.deepStrictEqual(
			collect_config_diagnostics({
				cookie_options: undefined,
				rate_limiter_mode: 'enforced',
				rate_limiters: enforced()
			}),
			[]
		);
		assert.deepStrictEqual(
			collect_config_diagnostics({
				cookie_options: { secure: true, sameSite: 'strict', httpOnly: true },
				rate_limiter_mode: 'enforced',
				rate_limiters: enforced()
			}),
			[],
			'the default cookie settings, spelled out, warn about nothing'
		);
	});

	test('each weakened cookie setting warns', () => {
		assert.deepStrictEqual(
			collect_config_diagnostics({
				cookie_options: { secure: false, sameSite: 'lax', httpOnly: false },
				rate_limiter_mode: 'enforced',
				rate_limiters: enforced()
			}),
			[
				{
					level: 'warning',
					category: 'security',
					message: 'Session cookie secure=false — cookies sent over HTTP'
				},
				{
					level: 'warning',
					category: 'security',
					message: "Session cookie sameSite='lax' — weakened from default 'strict'"
				},
				{
					level: 'warning',
					category: 'security',
					message: 'Session cookie httpOnly=false — cookie accessible to JS'
				}
			]
		);
	});

	test('one warning per explicitly-null limiter, in key order, after the cookie ones', () => {
		const limiters = { ...enforced(), signup_ip_rate_limiter: null, action_ip_rate_limiter: null };
		const messages = collect_config_diagnostics({
			cookie_options: { httpOnly: false },
			rate_limiter_mode: 'enforced',
			rate_limiters: limiters
		}).map((d) => d.message);
		assert.deepStrictEqual(messages, [
			'Session cookie httpOnly=false — cookie accessible to JS',
			'signup IP rate limiter explicitly disabled (null)',
			'action IP rate limiter explicitly disabled (null)'
		]);
	});

	test('the disabled mode is one warning, whatever it nulled', () => {
		const diagnostics = collect_config_diagnostics({
			cookie_options: undefined,
			rate_limiter_mode: 'disabled_for_testing',
			rate_limiters: all_null()
		});
		assert.deepStrictEqual(diagnostics, [
			{
				level: 'warning',
				category: 'security',
				message:
					"rate limiters disabled for testing (rate_limiters: 'disabled_for_testing') — " +
					'every limiter not passed explicitly is off; never use in production'
			}
		]);
	});
});
