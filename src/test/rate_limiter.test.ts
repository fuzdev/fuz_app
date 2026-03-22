/**
 * Tests for backend_rate_limiter.ts - In-memory sliding window rate limiter.
 *
 * @module
 */

import {describe, assert, test, vi} from 'vitest';
import {Hono} from 'hono';

import {
	RateLimiter,
	create_rate_limiter,
	rate_limit_exceeded_response,
	DEFAULT_LOGIN_IP_RATE_LIMIT,
	DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT,
} from '$lib/rate_limiter.js';
import {ERROR_RATE_LIMIT_EXCEEDED} from '$lib/http/error_schemas.js';
import {get_client_ip} from '$lib/http/proxy.js';

const WINDOW_MS = 60_000; // 1 minute
const MAX_ATTEMPTS = 3;

const create_test_limiter = (): RateLimiter =>
	new RateLimiter({max_attempts: MAX_ATTEMPTS, window_ms: WINDOW_MS, cleanup_interval_ms: 0});

describe('RateLimiter', () => {
	describe('construction', () => {
		test('uses provided options', () => {
			const limiter = create_test_limiter();
			assert.strictEqual(limiter.options.max_attempts, MAX_ATTEMPTS);
			assert.strictEqual(limiter.options.window_ms, WINDOW_MS);
			assert.strictEqual(limiter.options.cleanup_interval_ms, 0);
			limiter.dispose();
		});

		test('create_rate_limiter uses defaults', () => {
			const limiter = create_rate_limiter({cleanup_interval_ms: 0});
			assert.strictEqual(limiter.options.max_attempts, DEFAULT_LOGIN_IP_RATE_LIMIT.max_attempts);
			assert.strictEqual(limiter.options.window_ms, DEFAULT_LOGIN_IP_RATE_LIMIT.window_ms);
			limiter.dispose();
		});

		test('create_rate_limiter allows overrides', () => {
			const limiter = create_rate_limiter({max_attempts: 10, cleanup_interval_ms: 0});
			assert.strictEqual(limiter.options.max_attempts, 10);
			assert.strictEqual(limiter.options.window_ms, DEFAULT_LOGIN_IP_RATE_LIMIT.window_ms);
			limiter.dispose();
		});

		test('size starts at 0', () => {
			const limiter = create_test_limiter();
			assert.strictEqual(limiter.size, 0);
			limiter.dispose();
		});

		test('max_attempts 0 allows fresh keys but blocks after first record', () => {
			const limiter = new RateLimiter({
				max_attempts: 0,
				window_ms: WINDOW_MS,
				cleanup_interval_ms: 0,
			});
			// fresh key with no prior record is allowed (no timestamps to exceed limit)
			const fresh = limiter.check('ip1');
			assert.strictEqual(fresh.allowed, true);
			assert.strictEqual(fresh.remaining, 0);
			// after one record, the key is blocked
			limiter.record('ip1');
			const after = limiter.check('ip1');
			assert.strictEqual(after.allowed, false);
			limiter.dispose();
		});
	});

	describe('DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT', () => {
		test('has expected values', () => {
			assert.strictEqual(DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT.max_attempts, 10);
			assert.strictEqual(DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT.window_ms, 30 * 60_000);
			assert.strictEqual(DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT.cleanup_interval_ms, 5 * 60_000);
		});
	});

	describe('check', () => {
		test('allows requests when no attempts recorded', () => {
			const limiter = create_test_limiter();
			const result = limiter.check('1.2.3.4');
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.remaining, MAX_ATTEMPTS);
			assert.strictEqual(result.retry_after, 0);
			limiter.dispose();
		});

		test('does not record an attempt', () => {
			const limiter = create_test_limiter();
			limiter.check('1.2.3.4');
			limiter.check('1.2.3.4');
			limiter.check('1.2.3.4');
			limiter.check('1.2.3.4');
			// Still allowed because check doesn't record
			const result = limiter.check('1.2.3.4');
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.remaining, MAX_ATTEMPTS);
			limiter.dispose();
		});

		test('reflects recorded attempts', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('1.2.3.4', now);
			limiter.record('1.2.3.4', now + 1000);
			const result = limiter.check('1.2.3.4', now + 2000);
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.remaining, 1);
			limiter.dispose();
		});
	});

	describe('record', () => {
		test('allows requests under limit', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			const r1 = limiter.record('ip1', now);
			assert.strictEqual(r1.allowed, true);
			assert.strictEqual(r1.remaining, 2);

			const r2 = limiter.record('ip1', now + 1000);
			assert.strictEqual(r2.allowed, true);
			assert.strictEqual(r2.remaining, 1);

			const r3 = limiter.record('ip1', now + 2000);
			assert.strictEqual(r3.allowed, true);
			assert.strictEqual(r3.remaining, 0);
			limiter.dispose();
		});

		test('blocks after max_attempts', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);
			const r4 = limiter.record('ip1', now + 3000);
			assert.strictEqual(r4.allowed, false);
			assert.strictEqual(r4.remaining, 0);
			// Oldest attempt at `now`, expires at now + 60_000, checked at now + 3000
			// retry_after = ceil((100_000 + 60_000 - 103_000) / 1000) = 57
			assert.strictEqual(r4.retry_after, 57);
			limiter.dispose();
		});

		test('remaining decrements correctly', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			assert.strictEqual(limiter.record('k', now).remaining, 2);
			assert.strictEqual(limiter.record('k', now + 100).remaining, 1);
			assert.strictEqual(limiter.record('k', now + 200).remaining, 0);
			assert.strictEqual(limiter.record('k', now + 300).remaining, 0);
			limiter.dispose();
		});

		test('tracks size correctly', () => {
			const limiter = create_test_limiter();
			limiter.record('a');
			assert.strictEqual(limiter.size, 1);
			limiter.record('b');
			assert.strictEqual(limiter.size, 2);
			limiter.record('a');
			assert.strictEqual(limiter.size, 2);
			limiter.dispose();
		});
	});

	describe('retry_after', () => {
		test('reports seconds until oldest attempt expires', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);
			// Now blocked — check retry_after
			const result = limiter.record('ip1', now + 3000);
			// Oldest attempt at `now`, window is 60_000ms
			// retry_after = ceil((100_000 + 60_000 - 103_000) / 1000) = ceil(57_000/1000) = 57
			assert.strictEqual(result.retry_after, 57);
			limiter.dispose();
		});

		test('retry_after is 0 when allowed', () => {
			const limiter = create_test_limiter();
			const result = limiter.record('ip1');
			assert.strictEqual(result.retry_after, 0);
			limiter.dispose();
		});
	});

	describe('sliding window', () => {
		test('timestamp exactly at cutoff is pruned', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);

			// Check at exactly window_ms after the first attempt — t > cutoff uses strict >,
			// so the attempt at `now` equals the cutoff and is pruned.
			const result = limiter.check('ip1', now + WINDOW_MS);
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.remaining, 1);
			limiter.dispose();
		});

		test('expired attempts do not count', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			// Fill up the limit
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);

			// Blocked now
			const blocked = limiter.check('ip1', now + 3000);
			assert.strictEqual(blocked.allowed, false);

			// After the window passes, the oldest timestamps expire
			const after_window = limiter.check('ip1', now + WINDOW_MS + 1);
			assert.strictEqual(after_window.allowed, true);
			assert.strictEqual(after_window.remaining, 1); // 2 attempts still active
			limiter.dispose();
		});

		test('partial window expiry frees some capacity', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('ip1', now);
			limiter.record('ip1', now + 10_000);
			limiter.record('ip1', now + 20_000);

			// Move past first attempt's expiry but not second
			const check_time = now + WINDOW_MS + 1;
			const result = limiter.check('ip1', check_time);
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.remaining, 1);
			limiter.dispose();
		});
	});

	describe('record while blocked', () => {
		test('blocked attempts are still tracked and delay full recovery', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			// Fill the limit
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);

			// Blocked — but the attempt is still recorded
			const blocked = limiter.record('ip1', now + 3000);
			assert.strictEqual(blocked.allowed, false);

			// At now + WINDOW_MS + 1, the first attempt (now) expires but the
			// blocked attempt (now+3000) is still active — so 3 active timestamps
			// remain and the key is STILL blocked.
			const still_blocked = limiter.check('ip1', now + WINDOW_MS + 1);
			assert.strictEqual(still_blocked.allowed, false);

			// Only after enough time passes for 2 of the 4 to expire does capacity open
			const recovered = limiter.check('ip1', now + WINDOW_MS + 1001);
			assert.strictEqual(recovered.allowed, true);
			assert.strictEqual(recovered.remaining, 1); // 2 active: now+2000 and now+3000
			limiter.dispose();
		});
	});

	describe('retry_after progression', () => {
		test('retry_after decreases as time passes', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);

			const r1 = limiter.check('ip1', now + 3000);
			assert.strictEqual(r1.allowed, false);
			const retry1 = r1.retry_after;

			// 10 seconds later, retry_after should be 10 less
			const r2 = limiter.check('ip1', now + 13_000);
			assert.strictEqual(r2.allowed, false);
			assert.strictEqual(r2.retry_after, retry1 - 10);
			limiter.dispose();
		});
	});

	describe('max_attempts boundary', () => {
		test('max_attempts of 1 blocks on second attempt', () => {
			const limiter = new RateLimiter({
				max_attempts: 1,
				window_ms: WINDOW_MS,
				cleanup_interval_ms: 0,
			});
			const now = 100_000;
			const r1 = limiter.record('ip1', now);
			assert.strictEqual(r1.allowed, true);
			assert.strictEqual(r1.remaining, 0);

			const r2 = limiter.record('ip1', now + 1000);
			assert.strictEqual(r2.allowed, false);
			assert.ok(r2.retry_after > 0);
			limiter.dispose();
		});
	});

	describe('key independence', () => {
		test('different keys are tracked independently', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			// Fill up ip1
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);

			// ip2 should still be allowed
			const result = limiter.check('ip2', now + 3000);
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.remaining, MAX_ATTEMPTS);
			limiter.dispose();
		});
	});

	describe('reset', () => {
		test('clears attempts for a key', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('ip1', now);
			limiter.record('ip1', now + 1000);
			limiter.record('ip1', now + 2000);

			// Blocked
			assert.strictEqual(limiter.check('ip1', now + 3000).allowed, false);

			// Reset
			limiter.reset('ip1');

			// Now allowed
			const result = limiter.check('ip1', now + 4000);
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.remaining, MAX_ATTEMPTS);
			limiter.dispose();
		});

		test('does not affect other keys', () => {
			const limiter = create_test_limiter();
			limiter.record('ip1');
			limiter.record('ip2');
			limiter.reset('ip1');
			assert.strictEqual(limiter.size, 1);
			limiter.dispose();
		});

		test('reset on unknown key is safe', () => {
			const limiter = create_test_limiter();
			limiter.reset('nonexistent');
			assert.strictEqual(limiter.size, 0);
			limiter.dispose();
		});
	});

	describe('cleanup', () => {
		test('removes entries with all expired timestamps', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('old', now);
			limiter.record('new', now + WINDOW_MS);

			// Cleanup at a time when "old" is expired but "new" is active
			limiter.cleanup(now + WINDOW_MS + 1);
			assert.strictEqual(limiter.size, 1);

			// "new" should still be tracked
			const result = limiter.check('new', now + WINDOW_MS + 1);
			assert.strictEqual(result.remaining, 2);
			limiter.dispose();
		});

		test('keeps entries with active timestamps', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('ip1', now);
			limiter.record('ip1', now + WINDOW_MS - 1000);

			// Only the first one should be expired
			limiter.cleanup(now + WINDOW_MS + 1);
			assert.strictEqual(limiter.size, 1);
			const result = limiter.check('ip1', now + WINDOW_MS + 1);
			assert.strictEqual(result.remaining, 2); // only 1 active attempt
			limiter.dispose();
		});

		test('removes all entries when all are expired', () => {
			const limiter = create_test_limiter();
			const now = 100_000;
			limiter.record('a', now);
			limiter.record('b', now + 1000);
			assert.strictEqual(limiter.size, 2);

			limiter.cleanup(now + WINDOW_MS + 2000);
			assert.strictEqual(limiter.size, 0);
			limiter.dispose();
		});
	});

	describe('dispose', () => {
		test('is safe to call multiple times', () => {
			const limiter = create_test_limiter();
			limiter.dispose();
			limiter.dispose();
			// Should not throw
		});

		test('cleans up interval timer', () => {
			const limiter = new RateLimiter({
				max_attempts: 5,
				window_ms: 60_000,
				cleanup_interval_ms: 100,
			});
			limiter.dispose();
			// No assertion needed — just verify it doesn't throw or leak
		});
	});
});

describe('get_client_ip', () => {
	test('returns unknown without proxy middleware', async () => {
		const app = new Hono();
		let captured_ip = '';
		app.get('/test', (c) => {
			captured_ip = get_client_ip(c);
			return c.text('ok');
		});
		await app.fetch(new Request('http://localhost/test'));
		assert.strictEqual(captured_ip, 'unknown');
	});

	test('returns client_ip set by middleware', async () => {
		const app = new Hono();
		let captured_ip = '';
		app.use('*', async (c, next) => {
			c.set('client_ip', '10.0.0.1');
			await next();
		});
		app.get('/test', (c) => {
			captured_ip = get_client_ip(c);
			return c.text('ok');
		});
		await app.fetch(new Request('http://localhost/test'));
		assert.strictEqual(captured_ip, '10.0.0.1');
	});
});

// --- rate_limit_exceeded_response ---

describe('rate_limit_exceeded_response', () => {
	test('returns 429 with correct body and Retry-After header', async () => {
		const app = new Hono();
		app.get('/test', (c) => rate_limit_exceeded_response(c, 57));
		const res = await app.fetch(new Request('http://localhost/test'));
		assert.strictEqual(res.status, 429);
		assert.strictEqual(res.headers.get('Retry-After'), '57');
		assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
		const body = await res.json();
		assert.deepStrictEqual(body, {error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 57});
	});

	test('Retry-After header rounds up fractional seconds', async () => {
		const app = new Hono();
		app.get('/test', (c) => rate_limit_exceeded_response(c, 12.3));
		const res = await app.fetch(new Request('http://localhost/test'));
		assert.strictEqual(res.headers.get('Retry-After'), '13');
	});

	test('handles 0 retry_after', async () => {
		const app = new Hono();
		app.get('/test', (c) => rate_limit_exceeded_response(c, 0));
		const res = await app.fetch(new Request('http://localhost/test'));
		assert.strictEqual(res.status, 429);
		assert.strictEqual(res.headers.get('Retry-After'), '0');
	});
});

// --- Cleanup timer ---

describe('cleanup timer', () => {
	test('fires after cleanup_interval_ms', () => {
		vi.useFakeTimers();
		try {
			const limiter = new RateLimiter({
				max_attempts: 1,
				window_ms: 1000,
				cleanup_interval_ms: 500,
			});
			limiter.record('key', 0);
			assert.strictEqual(limiter.size, 1);

			// advance past both cleanup interval and window expiry
			vi.advanceTimersByTime(1500);
			assert.strictEqual(limiter.size, 0, 'cleanup timer should have removed expired entry');

			limiter.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test('cleanup_interval_ms 0 disables timer', () => {
		const limiter = new RateLimiter({
			max_attempts: 5,
			window_ms: 1000,
			cleanup_interval_ms: 0,
		});
		limiter.record('key', 0);
		assert.strictEqual(limiter.size, 1);

		// no timer fires, but manual cleanup works
		limiter.cleanup(2000);
		assert.strictEqual(limiter.size, 0);

		// dispose is a safe no-op
		limiter.dispose();
	});
});

// --- Boundary and race edge cases ---

describe('retry_after boundary', () => {
	const boundary_cases = [
		{name: 'exactly at window expiry', offset: 0, expected_retry: 0},
		{name: '1ms before expiry', offset: -1, expected_retry: 1},
		{name: '999ms before expiry', offset: -999, expected_retry: 1},
		{name: '1001ms before expiry', offset: -1001, expected_retry: 2},
		{name: '1ms after expiry', offset: 1, expected_retry: 0},
		{name: 'at half window before expiry', offset: -5000, expected_retry: 5},
	];

	for (const tc of boundary_cases) {
		test(`retry_after ${tc.name}`, () => {
			const limiter = new RateLimiter({
				max_attempts: 1,
				window_ms: 10_000,
				cleanup_interval_ms: 0,
			});
			limiter.record('k', 1000);
			const result = limiter.check('k', 1000 + 10_000 + tc.offset);
			assert.strictEqual(result.retry_after, tc.expected_retry);
			limiter.dispose();
		});
	}
});

describe('check-then-record race window', () => {
	test('concurrent checks all pass before any records (documented limitation)', () => {
		const limiter = new RateLimiter({
			max_attempts: 2,
			window_ms: 60_000,
			cleanup_interval_ms: 0,
		});

		// simulate N concurrent checks before any records — all pass
		const checks = Array.from({length: 5}, () => limiter.check('ip'));
		assert.ok(
			checks.every((c) => c.allowed),
			'all concurrent checks should pass',
		);

		// then all record — exceeds max_attempts
		for (const _check of checks) {
			limiter.record('ip');
		}

		// now blocked with 5 records (well over max_attempts of 2)
		const final = limiter.check('ip');
		assert.strictEqual(final.allowed, false);
		assert.strictEqual(final.remaining, 0);

		limiter.dispose();
	});
});

// --- State machine transitions ---

describe('state machine transitions', () => {
	const transitions = [
		{
			name: 'fresh → allowed on first record',
			prior_records: 0,
			expected_allowed: true,
			expected_remaining: 2,
		},
		{
			name: 'partial → allowed with decreasing remaining',
			prior_records: 1,
			expected_allowed: true,
			expected_remaining: 1,
		},
		{
			name: 'at limit → allowed on last attempt',
			prior_records: 2,
			expected_allowed: true,
			expected_remaining: 0,
		},
		{
			name: 'full → blocked on next attempt',
			prior_records: 3,
			expected_allowed: false,
			expected_remaining: 0,
		},
		{
			name: 'over limit → still blocked',
			prior_records: 5,
			expected_allowed: false,
			expected_remaining: 0,
		},
	];

	for (const tc of transitions) {
		test(tc.name, () => {
			const limiter = new RateLimiter({max_attempts: 3, window_ms: 60_000, cleanup_interval_ms: 0});
			const now = 100_000;
			for (let i = 0; i < tc.prior_records; i++) {
				limiter.record('ip', now + i * 100);
			}
			const result = limiter.record('ip', now + tc.prior_records * 100);
			assert.strictEqual(result.allowed, tc.expected_allowed);
			assert.strictEqual(result.remaining, tc.expected_remaining);
			limiter.dispose();
		});
	}
});

// --- Multi-key interactions ---

describe('multi-key interactions', () => {
	test('two IPs sharing the same limiter instance are independent', () => {
		const limiter = new RateLimiter({max_attempts: 3, window_ms: 60_000, cleanup_interval_ms: 0});
		const now = 100_000;
		// Fill up ip_a to the limit
		limiter.record('ip_a', now);
		limiter.record('ip_a', now + 100);
		limiter.record('ip_a', now + 200);
		const blocked = limiter.record('ip_a', now + 300);
		assert.strictEqual(blocked.allowed, false);

		// ip_b should still be fully available
		const result = limiter.check('ip_b', now + 400);
		assert.strictEqual(result.allowed, true);
		assert.strictEqual(result.remaining, 3);
		limiter.dispose();
	});

	test('same IP in different limiters are independent', () => {
		const limiter_a = new RateLimiter({max_attempts: 3, window_ms: 60_000, cleanup_interval_ms: 0});
		const limiter_b = new RateLimiter({max_attempts: 3, window_ms: 60_000, cleanup_interval_ms: 0});
		const now = 100_000;
		// Fill up ip in limiter_a
		limiter_a.record('ip', now);
		limiter_a.record('ip', now + 100);
		limiter_a.record('ip', now + 200);
		const blocked = limiter_a.record('ip', now + 300);
		assert.strictEqual(blocked.allowed, false);

		// ip in limiter_b should still be available
		const result = limiter_b.check('ip', now + 400);
		assert.strictEqual(result.allowed, true);
		assert.strictEqual(result.remaining, 3);
		limiter_a.dispose();
		limiter_b.dispose();
	});

	test('recording on one key does not affect size tracking of another', () => {
		const limiter = new RateLimiter({max_attempts: 3, window_ms: 60_000, cleanup_interval_ms: 0});
		const now = 100_000;
		limiter.record('key_a', now);
		limiter.record('key_b', now + 100);
		limiter.record('key_c', now + 200);
		assert.strictEqual(limiter.size, 3);

		limiter.reset('key_b');
		assert.strictEqual(limiter.size, 2);
		limiter.dispose();
	});
});
