import './assert_dev_env.ts';

/**
 * Test-only `RateLimiter` subclass with bucket tracking + reset_all.
 *
 * Production code never instantiates this; test binaries swap it in for
 * production `RateLimiter` so `_testing_reset` can clear every bucket
 * between cases. Mirrors the `TestingArgon2idHasher` pattern from the
 * Rust spine — same call surface as the production class, plus test-only
 * knobs (`reset_all`, `tracked_keys`).
 *
 * Constructor + every overridden method preserve production semantics
 * by delegating to `super.*` after tracking; `reset_all` walks the
 * tracked-keys set and calls `super.reset` per entry. Tests that depend
 * on burst behavior get identical results between production and test
 * instantiations.
 *
 * Usage in a test binary:
 *
 * ```ts
 * import {TestingRateLimiter} from '@fuzdev/fuz_app/testing/testing_rate_limiter.ts';
 *
 * const limiter = new TestingRateLimiter(default_login_ip_rate_limit);
 * await create_app_server({backend, ip_rate_limiter: limiter, ...});
 *
 * // Inside the `_testing_reset` handler's `reset_state`:
 * limiter.reset_all();
 * ```
 *
 * @module
 */

import { RateLimiter, type RateLimitResult } from '../rate_limiter.ts';

/**
 * `RateLimiter` plus bucket tracking. Every `check`/`record` call adds
 * its key to `#seen_keys`; `reset` removes it; `reset_all` clears every
 * tracked bucket. Drop-in replacement anywhere a `RateLimiter` is
 * expected — the type is nominally compatible via subclassing.
 */
export class TestingRateLimiter extends RateLimiter {
	readonly #seen_keys: Set<string> = new Set();

	override check(key: string, now?: number): RateLimitResult {
		this.#seen_keys.add(key);
		return super.check(key, now);
	}

	override record(key: string, now?: number): RateLimitResult {
		this.#seen_keys.add(key);
		return super.record(key, now);
	}

	override reset(key: string): void {
		this.#seen_keys.delete(key);
		super.reset(key);
	}

	/**
	 * Clear every bucket this limiter has been asked about. Idempotent;
	 * safe to call before any check/record activity. Designed to be invoked
	 * from a `_testing_reset` handler's `reset_state` callback so the test
	 * binary's rate-limit buckets don't leak across test cases.
	 */
	reset_all(): void {
		for (const key of this.#seen_keys) {
			super.reset(key);
		}
		this.#seen_keys.clear();
	}

	/**
	 * Snapshot of every bucket key this limiter has observed via
	 * `check`/`record`. Doesn't reflect post-cleanup pruning — keys that
	 * `cleanup()` removed remain in `tracked_keys` until `reset`/`reset_all`
	 * runs (or the limiter is disposed). Useful for assertions like
	 * "limiter saw exactly N IPs" in tests.
	 */
	get tracked_keys(): ReadonlySet<string> {
		return this.#seen_keys;
	}
}
