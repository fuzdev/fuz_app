/**
 * Integration tests for the full middleware stack with adversarial inputs.
 *
 * Uses `create_test_middleware_stack_app` from the testing library to compose
 * proxy + origin + bearer auth middleware (no DB needed) and exercises attack
 * scenarios: XFF spoofing, bearer + Origin rejection, and Host header spoofing.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_test_middleware_stack_app, TEST_MIDDLEWARE_PATH } from '$lib/testing/middleware.ts';
import { describe_standard_adversarial_headers } from '$lib/testing/adversarial_headers.ts';

// --- Shared test fixtures ---

const TRUSTED_PROXY = '10.0.0.1';
const ALLOWED_ORIGIN = 'https://app.example.com';

// --- XFF / client IP resolution scenarios (need per-case connection_ip) ---

describe('XFF client IP resolution', () => {
	test('XFF spoofing from untrusted connection is ignored', async () => {
		const { app } = create_test_middleware_stack_app({ connection_ip: '1.2.3.4' });
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: { 'X-Forwarded-For': '10.0.0.1' }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.client_ip, '1.2.3.4');
	});

	test('XFF from trusted proxy resolves client IP correctly', async () => {
		const { app } = create_test_middleware_stack_app({ connection_ip: TRUSTED_PROXY });
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: { 'X-Forwarded-For': '5.5.5.5' }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.client_ip, '5.5.5.5');
	});

	test('multiple X-Forwarded-For values — rightmost trusted honored', async () => {
		const { app } = create_test_middleware_stack_app({ connection_ip: TRUSTED_PROXY });
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' }
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
	{ connection_ip: TRUSTED_PROXY },
	ALLOWED_ORIGIN
);

// --- Host header spoofing ---

describe('Host header spoofing', () => {
	test('spoofed Host header does not affect auth resolution', async () => {
		const { app } = create_test_middleware_stack_app({ connection_ip: TRUSTED_PROXY });
		// spoofed Host should not change auth behavior — session/bearer auth
		// does not depend on Host header
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: { Host: 'evil.attacker.com' }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('spoofed Host with valid bearer token still authenticates', async () => {
		const { app, mock_validate } = create_test_middleware_stack_app({
			connection_ip: TRUSTED_PROXY
		});
		mock_validate.mockResolvedValueOnce({
			id: 'tok-1',
			account_id: 'acct-1',
			name: 'test',
			token_hash: 'h'
		});
		const res = await app.request(TEST_MIDDLEWARE_PATH, {
			headers: {
				Host: 'evil.attacker.com:666',
				Authorization: 'Bearer secret_fuz_token_test_valid'
			}
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.account_id, 'acct-1');
	});
});
