/**
 * In-memory sliding window rate limiter.
 *
 * Tracks failed attempts per key (typically IP address) using a sliding
 * time window. No external dependencies — state resets on server restart.
 *
 * @module
 */

import type {Context} from 'hono';
import {LruMap} from '@fuzdev/fuz_util/lru_map.js';

import {ERROR_RATE_LIMIT_EXCEEDED} from './http/error_schemas.js';

/**
 * Default tracked-key cap: bounds worst-case memory under key-enumeration
 * attacks (an attacker rotating source IPs cannot grow the backing map
 * indefinitely between cleanup ticks). Tuned to comfortably fit real
 * traffic for a single-instance deployment while capping memory at a few
 * MB in the worst case.
 */
export const DEFAULT_RATE_LIMITER_MAX_KEYS = 100_000;

/**
 * Configuration for a rate limiter instance.
 */
export interface RateLimiterOptions {
	/** Maximum allowed attempts within the window. */
	max_attempts: number;
	/** Sliding window duration in milliseconds. */
	window_ms: number;
	/** Interval for pruning stale entries (0 disables the timer). */
	cleanup_interval_ms: number;
	/**
	 * Maximum tracked keys. When exceeded, the least-recently-used key is
	 * evicted — bounds memory under key-enumeration attacks. Default:
	 * `DEFAULT_RATE_LIMITER_MAX_KEYS` (100_000). Pass `null` to disable the
	 * cap (falls back to an unbounded `Map` — only recommended when the key
	 * set is known to be closed, e.g. a per-account limiter keyed to a
	 * bounded-size account table).
	 *
	 * LRU trade-off: every `check` / `record` call marks the key as
	 * most-recently-used, so keys under active attack stay fresh and won't
	 * be evicted. A slow-burn attacker spread across many low-volume keys
	 * can, however, drop out of the table and reset their budget — set
	 * `max_keys` high enough to fit the expected legitimate key set and
	 * this stays theoretical.
	 */
	max_keys?: number | null;
}

/** Default options for per-IP login rate limiting: 5 attempts per 15 minutes. */
export const default_login_ip_rate_limit: RateLimiterOptions = {
	max_attempts: 5,
	window_ms: 15 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS,
};

/** Default options for per-account login rate limiting: 10 attempts per 30 minutes. */
export const default_login_account_rate_limit: RateLimiterOptions = {
	max_attempts: 10,
	window_ms: 30 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS,
};

/**
 * Default options for per-IP action-dispatcher rate limiting: 600 attempts
 * per 15 minutes. Shared by the HTTP RPC and WebSocket action dispatchers
 * (one budget per action, not per transport). Permissive — catches runaway
 * scripts and egregious oracle probes, but well above human or normal
 * automation pace. Tighten downstream for stricter deployments.
 */
export const default_action_ip_rate_limit: RateLimiterOptions = {
	max_attempts: 600,
	window_ms: 15 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS,
};

/**
 * Default options for per-actor action-dispatcher rate limiting: 1200
 * attempts per 15 minutes. Shared by the HTTP RPC and WebSocket action
 * dispatchers. Permissive — sustained ~80/min is well above any human
 * admin workflow; an oracle probing 10k addresses still finishes in
 * ~2 hours, slow enough to surface in audit. Tighten downstream.
 */
export const default_action_account_rate_limit: RateLimiterOptions = {
	max_attempts: 1200,
	window_ms: 15 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS,
};

/**
 * Result of a rate limit check or record operation.
 */
export interface RateLimitResult {
	/** Whether the request is allowed. */
	allowed: boolean;
	/** Remaining attempts before blocking. */
	remaining: number;
	/** Seconds until the oldest active attempt expires (0 if allowed). */
	retry_after: number;
}

/**
 * In-memory sliding window rate limiter.
 *
 * Stores an array of timestamps per key. On `check`/`record`, timestamps
 * outside the window are pruned. `retry_after` reports seconds until the
 * oldest active timestamp expires.
 *
 * The backing store is an `LruMap` when `options.max_keys` is a positive
 * number (default `DEFAULT_RATE_LIMITER_MAX_KEYS`) and a plain `Map` when
 * `max_keys` is `null`. The `LruMap` path bounds memory under
 * key-enumeration attack at the cost of a slight per-op overhead and the
 * LRU trade-off described on `RateLimiterOptions.max_keys`.
 *
 * Parameters that accept `RateLimiter | null` (e.g. `ip_rate_limiter`,
 * `login_account_rate_limiter`) silently disable rate limiting when `null`
 * is passed — no checks are performed and all requests are allowed through.
 */
export class RateLimiter {
	readonly options: RateLimiterOptions;

	/** Key → array of attempt timestamps. */
	readonly #attempts: Map<string, Array<number>> | LruMap<string, Array<number>>;

	#cleanup_timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: RateLimiterOptions) {
		this.options = options;
		const max_keys =
			options.max_keys === undefined ? DEFAULT_RATE_LIMITER_MAX_KEYS : options.max_keys;
		this.#attempts = max_keys === null ? new Map() : new LruMap<string, Array<number>>(max_keys);
		if (options.cleanup_interval_ms > 0) {
			this.#cleanup_timer = setInterval(() => this.cleanup(), options.cleanup_interval_ms);
			// Allow the process to exit even if the timer is still active.
			if (typeof this.#cleanup_timer === 'object' && 'unref' in this.#cleanup_timer) {
				this.#cleanup_timer.unref();
			}
		}
	}

	/** Number of tracked keys. */
	get size(): number {
		return this.#attempts.size;
	}

	/**
	 * Check whether `key` is allowed without recording an attempt.
	 *
	 * Prunes timestamps that fell outside the window as a side effect (and
	 * removes the key entirely when none remain), so the backing map stays
	 * bounded even under read-only traffic.
	 *
	 * @param key - rate limit key (e.g. IP address)
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 * @mutates internal map - prunes expired timestamps for `key`
	 */
	check(key: string, now: number = Date.now()): RateLimitResult {
		const {max_attempts, window_ms} = this.options;
		const cutoff = now - window_ms;
		const timestamps = this.#attempts.get(key);

		if (!timestamps) {
			return {allowed: true, remaining: max_attempts, retry_after: 0};
		}

		const active = timestamps.filter((t) => t > cutoff);
		if (active.length !== timestamps.length) {
			if (active.length === 0) {
				this.#attempts.delete(key);
			} else {
				this.#attempts.set(key, active);
			}
		}

		if (active.length < max_attempts) {
			return {allowed: true, remaining: max_attempts - active.length, retry_after: 0};
		}

		const oldest = active[0]!;
		const retry_after = Math.ceil((oldest + window_ms - now) / 1000);
		return {allowed: false, remaining: 0, retry_after};
	}

	/**
	 * Record a failed attempt for `key` and return the updated result.
	 *
	 * @param key - rate limit key (e.g. IP address)
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 * @mutates internal map - appends `now` to the timestamp list for `key` (after pruning expired entries)
	 */
	record(key: string, now: number = Date.now()): RateLimitResult {
		const {max_attempts, window_ms} = this.options;
		const cutoff = now - window_ms;

		let timestamps = this.#attempts.get(key);
		if (timestamps) {
			// Prune expired entries in place.
			const active = timestamps.filter((t) => t > cutoff);
			active.push(now);
			this.#attempts.set(key, active);
			timestamps = active;
		} else {
			timestamps = [now];
			this.#attempts.set(key, timestamps);
		}

		const count = timestamps.length;
		if (count <= max_attempts) {
			return {allowed: true, remaining: max_attempts - count, retry_after: 0};
		}

		const oldest = timestamps[0]!;
		const retry_after = Math.ceil((oldest + window_ms - now) / 1000);
		return {allowed: false, remaining: 0, retry_after};
	}

	/**
	 * Clear all attempts for `key` (e.g. after successful login).
	 *
	 * @mutates internal map - removes the entry for `key`
	 */
	reset(key: string): void {
		this.#attempts.delete(key);
	}

	/**
	 * Remove entries whose timestamps are all outside the window.
	 *
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 * @mutates internal map - prunes expired timestamps and deletes empty keys
	 */
	cleanup(now: number = Date.now()): void {
		const cutoff = now - this.options.window_ms;
		// Snapshot before mutating: `LruMap.set()` on an existing key moves it
		// to the MRU end during iteration and causes re-visit in the same pass.
		// The `Map` path is unaffected but the snapshot is cheap on both.
		const entries = [...this.#attempts];
		for (const [key, timestamps] of entries) {
			const active = timestamps.filter((t) => t > cutoff);
			if (active.length === 0) {
				this.#attempts.delete(key);
			} else {
				this.#attempts.set(key, active);
			}
		}
	}

	/**
	 * Stop the cleanup timer. Safe to call multiple times.
	 *
	 * @mutates timer - clears the cleanup `setInterval` and nulls the handle
	 */
	dispose(): void {
		if (this.#cleanup_timer !== null) {
			clearInterval(this.#cleanup_timer);
			this.#cleanup_timer = null;
		}
	}
}

/**
 * Create a `RateLimiter` with sensible defaults for per-IP login protection.
 *
 * @param options - override individual options; unset fields use `default_login_ip_rate_limit`
 */
export const create_rate_limiter = (options?: Partial<RateLimiterOptions>): RateLimiter => {
	return new RateLimiter({...default_login_ip_rate_limit, ...options});
};

/**
 * Build a 429 rate-limit-exceeded JSON response with `Retry-After` header.
 *
 * @param c - Hono context
 * @param retry_after - seconds until the client should retry
 * @returns a 429 Response
 */
export const rate_limit_exceeded_response = (c: Context, retry_after: number): Response =>
	c.json(
		{error: ERROR_RATE_LIMIT_EXCEEDED, retry_after},
		{status: 429, headers: {'Retry-After': String(Math.ceil(retry_after))}},
	);
