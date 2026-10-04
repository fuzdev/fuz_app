/**
 * Tests for `account_schema.ts`'s grant predicates: `is_role_grant_active` —
 * the in-memory expiry recheck over a second-truncated wire stamp — and
 * `has_global_role`, which adds the role and a `null` scope to it.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { has_global_role, is_role_grant_active } from '$lib/auth/account_schema.ts';
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

describe('has_global_role', () => {
	const NOW = new Date(W);
	const SCOPE = '11111111-1111-4111-8111-111111111111';

	const grant = (
		role: string,
		scope_id: string | null,
		overrides: { revoked_at?: string | null; expires_at?: string | null } = {}
	): {
		role: string;
		scope_id: string | null;
		revoked_at?: string | null;
		expires_at: string | null;
	} => ({
		role,
		scope_id,
		expires_at: null,
		...overrides
	});

	test('admits a live grant of the role with no scope', () => {
		assert.strictEqual(has_global_role([grant('admin', null)], 'admin', NOW), true);
		assert.strictEqual(
			has_global_role([grant('teacher', SCOPE), grant('admin', null)], 'admin', NOW),
			true
		);
	});

	test('denies a grant of the role scoped to a resource', () => {
		assert.strictEqual(has_global_role([grant('admin', SCOPE)], 'admin', NOW), false);
	});

	test('a scoped grant beside the global one changes nothing', () => {
		assert.strictEqual(
			has_global_role([grant('admin', SCOPE), grant('admin', null)], 'admin', NOW),
			true
		);
	});

	test('a grant with no `scope_id` field is not read as global', () => {
		// both backends always send `scope_id`; a row decoded without it fails closed
		const no_scope = { role: 'admin', expires_at: null } as unknown as ReturnType<typeof grant>;
		assert.strictEqual(has_global_role([no_scope], 'admin', NOW), false);
	});

	test('denies a global grant of another role, and an empty list', () => {
		assert.strictEqual(has_global_role([grant('teacher', null)], 'admin', NOW), false);
		assert.strictEqual(has_global_role([], 'admin', NOW), false);
	});

	test('denies a revoked global grant', () => {
		assert.strictEqual(
			has_global_role([grant('admin', null, { revoked_at: '2026-05-01T00:00:00Z' })], 'admin', NOW),
			false
		);
	});

	test('follows the expiry second, like `is_role_grant_active`', () => {
		const grants = [grant('admin', null, { expires_at: EXPIRES_AT })];
		assert.strictEqual(has_global_role(grants, 'admin', new Date(W + ISO8601_SECOND_MS - 1)), true);
		assert.strictEqual(has_global_role(grants, 'admin', new Date(W + ISO8601_SECOND_MS)), false);
	});

	test('an expired global grant does not fall back to a live scoped one', () => {
		assert.strictEqual(
			has_global_role(
				[grant('admin', null, { expires_at: EXPIRES_AT }), grant('admin', SCOPE)],
				'admin',
				new Date(W + ISO8601_SECOND_MS)
			),
			false
		);
	});

	test('`now` defaults to the current time', () => {
		assert.strictEqual(
			has_global_role([grant('admin', null, { expires_at: '2000-01-01T00:00:00Z' })], 'admin'),
			false
		);
		assert.strictEqual(
			has_global_role([grant('admin', null, { expires_at: '9999-01-01T00:00:00Z' })], 'admin'),
			true
		);
	});
});
