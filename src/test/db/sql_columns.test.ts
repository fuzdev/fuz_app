/**
 * Tests for sql_columns.ts — the `*_COLUMNS` projection helpers.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	columns_sql,
	iso8601_timestamp_column,
	iso8601_timestamp_expr,
	qualify_columns,
	omit_columns,
	type ColumnExpr
} from '$lib/db/sql_columns.ts';

const COLUMNS = ['id', 'name', 'token_hash', 'created_at'] as const;

/** A `created_at`-only override, the shape every query module builds. */
const created_at_expr = iso8601_timestamp_expr(COLUMNS, ['created_at']);

describe('iso8601_timestamp_expr', () => {
	test('projects the named columns and declines the rest', () => {
		const expr = created_at_expr('');
		assert.strictEqual(expr('created_at'), iso8601_timestamp_column('', 'created_at'));
		assert.strictEqual(expr('id'), undefined);
		assert.strictEqual(expr('name'), undefined);
	});

	test('threads the qualifier through', () => {
		assert.strictEqual(
			created_at_expr('t')('created_at'),
			iso8601_timestamp_column('t', 'created_at')
		);
	});

	test('throws on a name that is not in the column list', () => {
		assert.throws(
			() => iso8601_timestamp_expr(COLUMNS, ['updated_at' as 'created_at']),
			/"updated_at" is not in the column list/
		);
	});
});

describe('columns_sql', () => {
	test('renders the select list in projection order', () => {
		assert.strictEqual(columns_sql(COLUMNS), 'id, name, token_hash, created_at');
	});

	test('applies the expr override, aliased back to the column name', () => {
		assert.strictEqual(
			columns_sql(COLUMNS, created_at_expr('')),
			`id, name, token_hash, ${iso8601_timestamp_column('', 'created_at')} AS created_at`
		);
	});

	test('keeps the bare reference for a column the override declines', () => {
		const expr: ColumnExpr = () => undefined;
		assert.strictEqual(columns_sql(COLUMNS, expr), columns_sql(COLUMNS));
	});
});

describe('iso8601_timestamp_column', () => {
	test('renders the spine format literal', () => {
		// Byte-identical to `fuz_db::iso8601_timestamp_column`
		// (`crates/fuz_db/src/sql_helpers.rs`) — the two spines must serialize
		// the same instant to the same bytes, so this literal is pinned on
		// both sides rather than derived.
		assert.strictEqual(
			iso8601_timestamp_column('al', 'created_at'),
			`to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
		);
	});

	test('drops the qualifier on the empty-alias form', () => {
		assert.strictEqual(
			iso8601_timestamp_column('', 'created_at'),
			`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
		);
	});
});

describe('qualify_columns', () => {
	test('prefixes every column with the alias', () => {
		assert.strictEqual(
			qualify_columns(COLUMNS, 'al'),
			'al.id, al.name, al.token_hash, al.created_at'
		);
	});

	test('aliases an overridden column back to its own name', () => {
		// TS reads rows by name, so an override must carry an output name —
		// the Rust twin decodes positionally and needs none.
		assert.strictEqual(
			qualify_columns(COLUMNS, 'al', created_at_expr('al')),
			`al.id, al.name, al.token_hash, ${iso8601_timestamp_column('al', 'created_at')} AS created_at`
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
