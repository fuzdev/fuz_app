/**
 * The bootstrap rate limit on the wire, identical on both spines: past the
 * per-IP budget (`default_login_ip_rate_limit`, the twins' shared default) a
 * bootstrap attempt answers `429 {error: "rate_limit_exceeded", retry_after}`,
 * the same integer of seconds in `Retry-After`.
 *
 * The answers were gathered by the `cross_backend_security` project's
 * `globalSetup` before each keeper bootstrap (`bootstrap_rate_limit_probe.ts`),
 * since bootstrap is one-shot per backend.
 *
 * @module
 */

import { assert, describe, inject, test } from 'vitest';

import { ERROR_RATE_LIMIT_EXCEEDED } from '#lib/http/error_schemas.ts';
import { default_login_ip_rate_limit } from '#lib/rate_limiter.ts';
import { check_declared_skips } from '#lib/testing/cross_backend/declared_skips.ts';

import type { BootstrapRateLimitProbe } from './bootstrap_rate_limit_probe.ts';
import './cross_test_types.ts';

const probes = inject('security_bootstrap_rate_limit');

const assert_bootstrap_429 = (probe: BootstrapRateLimitProbe, label: string): void => {
	assert.strictEqual(
		probe.refused_before,
		default_login_ip_rate_limit.max_attempts,
		`${label}: the budget's wrong tokens were refused 401 first`
	);
	assert.strictEqual(probe.status, 429, `${label}: status`);
	assert.ok(probe.retry_after !== null, `${label}: Retry-After is sent`);
	assert.match(probe.retry_after, /^[1-9][0-9]*$/, `${label}: Retry-After is whole seconds`);
	assert.deepStrictEqual(
		probe.body,
		{ error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: Number(probe.retry_after) },
		`${label}: body`
	);
};

describe('bootstrap rate limit', () => {
	test('the TS spine answers the bootstrap 429', () => {
		assert_bootstrap_429(probes.a, 'ts');
	});

	test('the Rust spine answers the bootstrap 429', () => {
		assert_bootstrap_429(probes.b, 'rust');
	});
});

check_declared_skips({});
