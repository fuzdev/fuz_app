import { describe, assert, test } from 'vitest';

import { pg_error_code, is_pg_unique_violation } from '$lib/db/pg_error.ts';

/** Build an `Error` carrying a `code` property, the shape `pg`/PGlite throw. */
const error_with_code = (code: unknown): Error => Object.assign(new Error('pg error'), { code });

describe('pg_error_code', () => {
	test('extracts the code string from a pg-shaped error', () => {
		assert.strictEqual(pg_error_code(error_with_code('23505')), '23505');
		assert.strictEqual(pg_error_code(error_with_code('22P02')), '22P02');
	});

	test('non-SQLSTATE string codes pass through — callers compare against specific values', () => {
		// Node FS errors carry string codes too; the extractor doesn't
		// distinguish, so a truthiness check at a call site would be a bug.
		assert.strictEqual(pg_error_code(error_with_code('ENOSPC')), 'ENOSPC');
	});

	test('returns null for non-errors and errors without a string code', () => {
		assert.isNull(pg_error_code(new Error('plain')));
		assert.isNull(pg_error_code(error_with_code(23505)));
		assert.isNull(pg_error_code(error_with_code(undefined)));
		assert.isNull(pg_error_code('23505'));
		assert.isNull(pg_error_code(null));
		assert.isNull(pg_error_code(undefined));
	});
});

describe('is_pg_unique_violation', () => {
	test('matches only SQLSTATE 23505', () => {
		assert.isTrue(is_pg_unique_violation(error_with_code('23505')));
		assert.isFalse(is_pg_unique_violation(error_with_code('23503')));
		assert.isFalse(is_pg_unique_violation(new Error('plain')));
		assert.isFalse(is_pg_unique_violation(null));
	});
});
