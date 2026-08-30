/**
 * Tests for sql_columns.ts — the `*_COLUMNS` projection helpers.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { columns_sql, qualify_columns, omit_columns } from '$lib/db/sql_columns.ts';

const COLUMNS = ['id', 'name', 'token_hash', 'created_at'] as const;

describe('columns_sql', () => {
	test('renders the select list in projection order', () => {
		assert.strictEqual(columns_sql(COLUMNS), 'id, name, token_hash, created_at');
	});
});

describe('qualify_columns', () => {
	test('prefixes every column with the alias', () => {
		assert.strictEqual(
			qualify_columns(COLUMNS, 'al'),
			'al.id, al.name, al.token_hash, al.created_at'
		);
	});

	test('rejects an alias that is not a plain identifier', () => {
		// The alias is interpolated into SQL — a computed one must fail loud.
		assert.throws(() => qualify_columns(COLUMNS, 'c '), /Invalid SQL identifier/);
		assert.throws(() => qualify_columns(COLUMNS, 'c; DROP TABLE x'), /Invalid SQL identifier/);
	});
});

describe('omit_columns', () => {
	test('drops the named columns, preserving order', () => {
		assert.deepEqual(omit_columns(COLUMNS, 'token_hash'), ['id', 'name', 'created_at']);
		assert.deepEqual(omit_columns(COLUMNS, 'id', 'created_at'), ['name', 'token_hash']);
	});

	test('throws on a name that is not in the list', () => {
		// A typo here would silently keep the column it meant to hide. The
		// `as const` array makes this a compile error too; a plain `string[]`
		// (a consumer's const) only has the runtime check.
		const plain: Array<string> = [...COLUMNS];
		assert.throws(() => omit_columns(plain, 'token_hsh'), /"token_hsh" is not in the column list/);
	});
});
