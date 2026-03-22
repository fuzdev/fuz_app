/**
 * SQL identifier validation for dynamic DDL queries.
 *
 * PostgreSQL DDL operations (DROP TABLE, TRUNCATE, ALTER) do not support
 * parameterized table/column names — only values can be parameterized.
 * This validator ensures identifiers are safe for string interpolation
 * in those specific cases.
 *
 * @module
 */

/**
 * Pattern matching valid SQL identifiers: starts with a letter or underscore,
 * followed by letters, digits, or underscores.
 */
export const VALID_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Assert that a string is a valid SQL identifier.
 *
 * Use this before interpolating table or column names into DDL queries
 * where parameterized placeholders (`$1`) are not supported.
 *
 * @param name - the identifier to validate
 * @returns the validated identifier
 * @throws if the identifier contains invalid characters
 */
export const assert_valid_sql_identifier = (name: string): string => {
	if (!VALID_SQL_IDENTIFIER.test(name)) {
		throw new Error(`Invalid SQL identifier: ${name}`);
	}
	return name;
};
