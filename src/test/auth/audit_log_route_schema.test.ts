/**
 * Tests for the audit-log SSE route's wire schemas. `AuditStreamQuery` is a
 * `@fuzdev/fuz_schema` `object`; the `{acting}` query shape is covered in
 * `http/acting_query.fuz_schema.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';

import { AuditStreamQuery } from '#lib/auth/audit_log_route_schema.ts';
import { parse_any } from '#lib/schema_issues.ts';

describe('AuditStreamQuery', () => {
	test('is a fuz_schema schema', () => {
		assert.ok(is_schema(AuditStreamQuery));
	});

	test('takes an acting UUID or none', () => {
		assert.isTrue(parse(AuditStreamQuery, {}).ok);
		// what the query validation calls
		assert.isTrue(parse_any(AuditStreamQuery, {}).ok);
		assert.isTrue(parse(AuditStreamQuery, { acting: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }).ok);
		assert.isFalse(parse(AuditStreamQuery, { acting: 'not-a-uuid' }).ok);
	});

	// the Rust spine's grammar: the max UUID in any case, lowercased
	test('takes the max UUID in any case as the acting selector', () => {
		const result = parse(AuditStreamQuery, { acting: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' });
		assert(result.ok);
		assert.strictEqual(result.value.acting, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
	});

	test('refuses an unknown key', () => {
		const result = parse(AuditStreamQuery, { acting: undefined, since: '1' });
		assert(!result.ok);
		assert.strictEqual(result.issues.length, 1);
		assert.strictEqual(result.issues[0]!.kind, 'unknown_key');
		assert.deepStrictEqual(result.issues[0]!.path, ['since']);
	});
});
