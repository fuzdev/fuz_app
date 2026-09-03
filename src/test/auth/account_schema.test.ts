/**
 * Tests for `account_schema.ts`'s `is_role_grant_active` — the in-memory
 * expiry recheck over a second-truncated wire stamp.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { is_role_grant_active } from '$lib/auth/account_schema.ts';
import { ISO8601_SECOND_MS } from '$lib/timestamp.ts';

// the second-truncated wire stamp the predicate compares against
const EXPIRES_AT = '2026-06-01T12:00:00Z';
const W = Date.parse(EXPIRES_AT);

describe('is_role_grant_active', () => {
	test('admits through the end of the second its truncated stamp names', () => {
		// the stamp stands for `[W, W + 1s)`, so the whole second is still live
		assert.strictEqual(is_role_grant_active({ expires_at: EXPIRES_AT }, new Date(W)), true);
		assert.strictEqual(
			is_role_grant_active({ expires_at: EXPIRES_AT }, new Date(W + ISO8601_SECOND_MS - 1)),
			true
		);
	});

	test('denies once that second is over', () => {
		assert.strictEqual(
			is_role_grant_active({ expires_at: EXPIRES_AT }, new Date(W + ISO8601_SECOND_MS)),
			false
		);
		assert.strictEqual(
			is_role_grant_active({ expires_at: EXPIRES_AT }, new Date(W + ISO8601_SECOND_MS * 60)),
			false
		);
	});

	test('denies a revoked grant regardless of expiry', () => {
		assert.strictEqual(
			is_role_grant_active(
				{ revoked_at: '2026-05-01T00:00:00Z', expires_at: EXPIRES_AT },
				new Date(W)
			),
			false
		);
		assert.strictEqual(
			is_role_grant_active({ revoked_at: '2026-05-01T00:00:00Z', expires_at: null }, new Date(W)),
			false
		);
	});

	test('admits a grant with no expiry', () => {
		assert.strictEqual(is_role_grant_active({ expires_at: null }, new Date(W)), true);
		assert.strictEqual(
			is_role_grant_active({ revoked_at: null, expires_at: null }, new Date(W)),
			true
		);
	});

	test('denies a malformed stamp — an unparseable expiry is never live', () => {
		assert.strictEqual(is_role_grant_active({ expires_at: 'not-a-timestamp' }, new Date(W)), false);
		assert.strictEqual(is_role_grant_active({ expires_at: '12:00:00' }, new Date(W)), false);
	});
});
