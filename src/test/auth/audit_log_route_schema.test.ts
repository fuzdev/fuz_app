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

	// `zod-uuid-uppercase-max`: a declared gap against the Rust spine; this fails,
	// and the ledger header's entry goes, when the query schema moves to the twin
	test('the Zod acting query refuses the uppercase max UUID', () => {
		assert.isFalse(
			AuditStreamQuery.safeParse({ acting: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' }).success
		);
	});
});
