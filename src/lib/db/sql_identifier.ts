/**
 * SQL identifier validation for the places an identifier must be
 * interpolated rather than parameterized.
 *
 * PostgreSQL parameterizes values only — table and column names in DDL
 * (DROP TABLE, TRUNCATE, ALTER) and the alias `qualify_columns` prefixes
 * onto a projection (`db/sql_columns.ts`) have to be string-interpolated.
 * This validator ensures such identifiers are safe to interpolate.
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
 * @throws Error if the identifier contains characters outside `[a-zA-Z0-9_]`
 *   or starts with a digit
 */
export const assert_valid_sql_identifier = (name: string): string => {
	if (!VALID_SQL_IDENTIFIER.test(name)) {
		throw new Error(`Invalid SQL identifier: ${name}`);
	}
	return name;
};
