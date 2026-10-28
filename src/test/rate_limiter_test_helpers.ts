/**
 * Shared rate-limiter fixtures for fuz_app's own suites that drive the login,
 * password and bootstrap handlers through a limiter and the trusted proxy.
 *
 * @module
 */

import { RateLimiter } from '#lib/rate_limiter.ts';
import { create_proxy_middleware } from '#lib/http/proxy.ts';

/** The simulated connection IP — the proxy trusts it and a request without `X-Forwarded-For` keys on it. */
export const TEST_CONNECTION_IP = '127.0.0.1';

/**
 * Proxy middleware for tests: trusts the simulated connection IP, so
 * `X-Forwarded-For` headers are honored and `get_client_ip(c)` returns a real
 * value.
 */
export const test_proxy_middleware = create_proxy_middleware({
	trusted_proxies: [TEST_CONNECTION_IP],
	get_connection_ip: () => TEST_CONNECTION_IP
});

/** The window of `create_test_limiter`'s limiters. */
export const TEST_LIMITER_WINDOW_MS = 60_000;

/** The attempts `create_test_limiter`'s limiters allow per window. */
export const TEST_LIMITER_MAX_ATTEMPTS = 3;

/** A fresh limiter with no cleanup timer, so a test never leaves one running. */
export const create_test_limiter = (): RateLimiter =>
	new RateLimiter({
		max_attempts: TEST_LIMITER_MAX_ATTEMPTS,
		window_ms: TEST_LIMITER_WINDOW_MS,
		cleanup_interval_ms: 0
	});
