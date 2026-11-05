/**
 * Tests for the audit-log SSE route's wire schemas.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { AuditStreamQuery } from '#lib/auth/audit_log_route_schema.ts';

describe('AuditStreamQuery', () => {
	test('takes an acting UUID or none', () => {
		assert.isTrue(AuditStreamQuery.safeParse({}).success);
		assert.isTrue(
			AuditStreamQuery.safeParse({ acting: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }).success
		);
		assert.isFalse(AuditStreamQuery.safeParse({ acting: 'not-a-uuid' }).success);
	});

	// the Rust spine's grammar: the max UUID in any case, lowercased
	test('takes the max UUID in any case as the acting selector', () => {
		const result = AuditStreamQuery.safeParse({ acting: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' });
		assert(result.success);
		assert.strictEqual(result.data.acting, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
	});
});
