/**
 * Tests for the shared SQL identifier validator.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {assert_valid_sql_identifier, VALID_SQL_IDENTIFIER} from '$lib/db/sql_identifier.js';

describe('VALID_SQL_IDENTIFIER', () => {
	test('matches simple identifiers', () => {
		assert.ok(VALID_SQL_IDENTIFIER.test('account'));
		assert.ok(VALID_SQL_IDENTIFIER.test('auth_session'));
		assert.ok(VALID_SQL_IDENTIFIER.test('_private'));
		assert.ok(VALID_SQL_IDENTIFIER.test('Table1'));
	});

	test('rejects invalid identifiers', () => {
		assert.ok(!VALID_SQL_IDENTIFIER.test(''));
		assert.ok(!VALID_SQL_IDENTIFIER.test('1starts_with_digit'));
		assert.ok(!VALID_SQL_IDENTIFIER.test('has space'));
		assert.ok(!VALID_SQL_IDENTIFIER.test('has-dash'));
		assert.ok(!VALID_SQL_IDENTIFIER.test('has.dot'));
		assert.ok(!VALID_SQL_IDENTIFIER.test("Robert'; DROP TABLE students;--"));
	});
});

describe('assert_valid_sql_identifier', () => {
	test('returns the identifier when valid', () => {
		assert.strictEqual(assert_valid_sql_identifier('account'), 'account');
		assert.strictEqual(assert_valid_sql_identifier('auth_session'), 'auth_session');
		assert.strictEqual(assert_valid_sql_identifier('_meta'), '_meta');
	});

	test('throws on invalid identifiers', () => {
		assert.throws(() => assert_valid_sql_identifier(''), /Invalid SQL identifier/);
		assert.throws(() => assert_valid_sql_identifier('1bad'), /Invalid SQL identifier/);
		assert.throws(
			() => assert_valid_sql_identifier("x'; DROP TABLE y;--"),
			/Invalid SQL identifier/,
		);
		assert.throws(() => assert_valid_sql_identifier('a b'), /Invalid SQL identifier/);
	});

	test('rejects semicolons and quotes', () => {
		assert.throws(() => assert_valid_sql_identifier('table;'), /Invalid SQL identifier/);
		assert.throws(() => assert_valid_sql_identifier("table'"), /Invalid SQL identifier/);
		assert.throws(() => assert_valid_sql_identifier('table"'), /Invalid SQL identifier/);
	});
});
