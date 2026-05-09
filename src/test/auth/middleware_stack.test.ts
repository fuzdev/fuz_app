/**
 * Integration tests for the full middleware stack with adversarial inputs.
 *
 * Uses `create_test_middleware_stack_app` from the testing library to compose
 * proxy + origin + bearer auth middleware (no DB needed) and exercises attack
 * scenarios: XFF spoofing, bearer + Origin rejection, and rate limit bucket
 * keying on resolved client IP.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {RateLimiter} from '$lib/rate_limiter.js';
import {RateLimitError, ERROR_RATE_LIMIT_EXCEEDED} from '$lib/http/error_schemas.js';
import {create_test_middleware_stack_app, TEST_MIDDLEWARE_PATH} from '$lib/testing/middleware.js';
import {describe_standard_adversarial_headers} from '$lib/testing/adversarial_headers.js';

// --- Shared test fixtures ---

const TRUSTED_PROXY = '10.0.0.1';
const ALLOWED_ORIGIN = 'https://app.example.com';

// --- XFF / client IP resolution scenarios (need per-case connection_ip) ---

describe('XFF client IP resolution', () => {
	test('XFF spoofing from untrusted connection is ignored', async () => {
		const {app} = create_test_middleware_stack_app({connection_ip: '1.2.3.4'});
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {'X-Forwarded-For': '10.0.0.1'},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.client_ip, '1.2.3.4');
	});

	test('XFF from trusted proxy resolves client IP correctly', async () => {
		const {app} = create_test_middleware_stack_app({connection_ip: TRUSTED_PROXY});
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {'X-Forwarded-For': '5.5.5.5'},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.client_ip, '5.5.5.5');
	});

	test('multiple X-Forwarded-For values — rightmost trusted honored', async () => {
		const {app} = create_test_middleware_stack_app({connection_ip: TRUSTED_PROXY});
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {'X-Forwarded-For': '1.1.1.1, 2.2.2.2'},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		// proxy middleware resolves the rightmost client IP from XFF
		assert.strictEqual(body.client_ip, '2.2.2.2');
	});
});

// --- Table-driven adversarial header attacks (via convenience wrapper) ---

describe_standard_adversarial_headers(
	'adversarial header attacks',
	{connection_ip: TRUSTED_PROXY},
	ALLOWED_ORIGIN,
);

// --- Host header spoofing ---

describe('Host header spoofing', () => {
	test('spoofed Host header does not affect auth resolution', async () => {
		const {app} = create_test_middleware_stack_app({connection_ip: TRUSTED_PROXY});
		// spoofed Host should not change auth behavior — session/bearer auth
		// does not depend on Host header
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {Host: 'evil.attacker.com'},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('spoofed Host with valid bearer token still authenticates', async () => {
		const {app, mock_validate} = create_test_middleware_stack_app({connection_ip: TRUSTED_PROXY});
		mock_validate.mockResolvedValueOnce({
			id: 'tok-1',
			account_id: 'acct-1',
			name: 'test',
			token_hash: 'h',
		});
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {
				Host: 'evil.attacker.com:666',
				Authorization: 'Bearer secret_fuz_token_test_valid',
			},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.account_id, 'acct-1');
	});
});

// --- Rate limit keying on resolved client IP ---

describe('rate limiting keys on resolved client IP', () => {
	test('same XFF client IP from different connections shares rate limit bucket', async () => {
		const limiter = new RateLimiter({
			max_attempts: 3,
			window_ms: 60_000,
			cleanup_interval_ms: 0,
		});

		const {app} = create_test_middleware_stack_app({
			connection_ip: TRUSTED_PROXY,
			ip_rate_limiter: limiter,
		});

		// exhaust the limit with invalid bearer tokens — all from same XFF client IP
		// Bearer middleware soft-fails (200) but still records rate limit attempts
		for (let i = 0; i < 3; i++) {
			const res = await app.request(TEST_MIDDLEWARE_PATH, {
				method: 'GET',
				headers: {
					Authorization: `Bearer bad_token_${i}`,
					'X-Forwarded-For': '5.5.5.5',
				},
			});
			assert.strictEqual(res.status, 200, `attempt ${i} should soft-fail to 200`);
		}

		// next request from same client IP should be rate-limited (429 is the only hard-fail)
		const blocked = await app.request(TEST_MIDDLEWARE_PATH, {
			method: 'GET',
			headers: {
				Authorization: 'Bearer bad_token_final',
				'X-Forwarded-For': '5.5.5.5',
			},
		});
		assert.strictEqual(blocked.status, 429);
		const body = await blocked.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		RateLimitError.parse(body);

		limiter.dispose();
	});

	test('different XFF client IPs have independent rate limit buckets', async () => {
		const limiter = new RateLimiter({
			max_attempts: 2,
			window_ms: 60_000,
			cleanup_interval_ms: 0,
		});

		const {app} = create_test_middleware_stack_app({
			connection_ip: TRUSTED_PROXY,
			ip_rate_limiter: limiter,
		});

		// exhaust limit for IP 5.5.5.5
		for (let i = 0; i < 2; i++) {
			await app.request(TEST_MIDDLEWARE_PATH, {
				method: 'GET',
				headers: {
					Authorization: `Bearer bad_${i}`,
					'X-Forwarded-For': '5.5.5.5',
				},
			});
		}

		// 5.5.5.5 should be blocked
		const blocked = await app.request(TEST_MIDDLEWARE_PATH, {
			method: 'GET',
			headers: {
				Authorization: 'Bearer bad_extra',
				'X-Forwarded-For': '5.5.5.5',
			},
		});
		assert.strictEqual(blocked.status, 429);
		RateLimitError.parse(await blocked.json());

		// 6.6.6.6 should still be allowed (soft-fail, not rate-limited)
		const allowed = await app.request(TEST_MIDDLEWARE_PATH, {
			method: 'GET',
			headers: {
				Authorization: 'Bearer bad_other',
				'X-Forwarded-For': '6.6.6.6',
			},
		});
		assert.strictEqual(allowed.status, 200, '6.6.6.6 should not be rate-limited (soft-fail)');

		limiter.dispose();
	});

	test('valid bearer token succeeds from non-rate-limited IP while rate-limited IP stays blocked', async () => {
		const limiter = new RateLimiter({
			max_attempts: 2,
			window_ms: 60_000,
			cleanup_interval_ms: 0,
		});

		const VALID_TOKEN = 'valid_token_xyz';
		const {app, mock_validate} = create_test_middleware_stack_app({
			connection_ip: TRUSTED_PROXY,
			ip_rate_limiter: limiter,
		});

		// configure mocks for a valid token path — bearer auth only consumes
		// `query_validate_api_token`; account / actor / role_grant lookups are the
		// dispatcher's authorization phase concern, not middleware.
		mock_validate.mockImplementation((_deps: any, raw_token: string) =>
			Promise.resolve(
				raw_token === VALID_TOKEN
					? {
							id: 'tok-1',
							account_id: 'acct-1',
							name: 'test',
							token_hash: 'h',
						}
					: undefined,
			),
		);

		// exhaust rate limit for 5.5.5.5 with invalid tokens (soft-fail 200, but record() still fires)
		for (let i = 0; i < 2; i++) {
			const res = await app.request(TEST_MIDDLEWARE_PATH, {
				headers: {Authorization: `Bearer bad_${i}`, 'X-Forwarded-For': '5.5.5.5'},
			});
			assert.strictEqual(res.status, 200, `attempt ${i} should soft-fail to 200`);
		}

		// 5.5.5.5 blocked even with valid token — rate limit fires before validation
		const calls_before_blocked = mock_validate.mock.calls.length;
		const blocked = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {Authorization: `Bearer ${VALID_TOKEN}`, 'X-Forwarded-For': '5.5.5.5'},
		});
		assert.strictEqual(blocked.status, 429);
		RateLimitError.parse(await blocked.json());
		assert.strictEqual(
			mock_validate.mock.calls.length,
			calls_before_blocked,
			'rate-limited request should not reach token validation',
		);

		// 6.6.6.6 with valid token succeeds — independent bucket
		const allowed = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {Authorization: `Bearer ${VALID_TOKEN}`, 'X-Forwarded-For': '6.6.6.6'},
		});
		assert.strictEqual(allowed.status, 200);
		const body = await allowed.json();
		assert.strictEqual(body.account_id, 'acct-1', 'valid token should set ACCOUNT_ID_KEY');
		assert.strictEqual(body.client_ip, '6.6.6.6', 'XFF should resolve to client IP');

		// 6.6.6.6 with invalid token soft-fails to 200 (not rate-limited — valid token reset its counter)
		const other_invalid = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {Authorization: 'Bearer bad_other', 'X-Forwarded-For': '6.6.6.6'},
		});
		assert.strictEqual(other_invalid.status, 200);

		limiter.dispose();
	});

	test('untrusted connection ignores XFF for rate limit bucket', async () => {
		const limiter = new RateLimiter({
			max_attempts: 2,
			window_ms: 60_000,
			cleanup_interval_ms: 0,
		});

		// untrusted connection IP — XFF should be ignored
		const {app} = create_test_middleware_stack_app({
			connection_ip: '1.2.3.4',
			ip_rate_limiter: limiter,
		});

		// exhaust limit — rate limit keys on connection IP 1.2.3.4, not XFF
		for (let i = 0; i < 2; i++) {
			await app.request(TEST_MIDDLEWARE_PATH, {
				method: 'GET',
				headers: {
					Authorization: `Bearer bad_${i}`,
					'X-Forwarded-For': '5.5.5.5',
				},
			});
		}

		// blocked — keyed on 1.2.3.4 not 5.5.5.5
		const blocked = await app.request(TEST_MIDDLEWARE_PATH, {
			method: 'GET',
			headers: {
				Authorization: 'Bearer bad_3',
				'X-Forwarded-For': '5.5.5.5',
			},
		});
		assert.strictEqual(blocked.status, 429);
		RateLimitError.parse(await blocked.json());

		limiter.dispose();
	});
});
