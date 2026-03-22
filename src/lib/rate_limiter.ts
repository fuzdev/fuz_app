/**
 * In-memory sliding window rate limiter.
 *
 * Tracks failed attempts per key (typically IP address) using a sliding
 * time window. No external dependencies — state resets on server restart.
 *
 * @module
 */

import type {Context} from 'hono';

import {ERROR_RATE_LIMIT_EXCEEDED} from './http/error_schemas.js';

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
}

/** Default options for per-IP login rate limiting: 5 attempts per 15 minutes. */
export const DEFAULT_LOGIN_IP_RATE_LIMIT: RateLimiterOptions = {
	max_attempts: 5,
	window_ms: 15 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
};

/** Default options for per-account login rate limiting: 10 attempts per 30 minutes. */
export const DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT: RateLimiterOptions = {
	max_attempts: 10,
	window_ms: 30 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
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
 * Parameters that accept `RateLimiter | null` (e.g. `ip_rate_limiter`,
 * `login_account_rate_limiter`) silently disable rate limiting when `null`
 * is passed — no checks are performed and all requests are allowed through.
 */
export class RateLimiter {
	readonly options: RateLimiterOptions;

	/** Key → array of attempt timestamps. */
	readonly #attempts: Map<string, Array<number>> = new Map();

	#cleanup_timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: RateLimiterOptions) {
		this.options = options;
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
	 * @param key - rate limit key (e.g. IP address)
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
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
	 */
	reset(key: string): void {
		this.#attempts.delete(key);
	}

	/**
	 * Remove entries whose timestamps are all outside the window.
	 *
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 */
	cleanup(now: number = Date.now()): void {
		const cutoff = now - this.options.window_ms;
		for (const [key, timestamps] of this.#attempts) {
			const active = timestamps.filter((t) => t > cutoff);
			if (active.length === 0) {
				this.#attempts.delete(key);
			} else {
				this.#attempts.set(key, active);
			}
		}
	}

	/** Stop the cleanup timer. Safe to call multiple times. */
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
 * @param options - override individual options; unset fields use `DEFAULT_LOGIN_IP_RATE_LIMIT`
 */
export const create_rate_limiter = (options?: Partial<RateLimiterOptions>): RateLimiter => {
	return new RateLimiter({...DEFAULT_LOGIN_IP_RATE_LIMIT, ...options});
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
