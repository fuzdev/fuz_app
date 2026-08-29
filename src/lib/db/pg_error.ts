/**
 * PostgreSQL error utilities.
 *
 * Works with both `pg` and `@electric-sql/pglite` — both set `.code`
 * on error objects using standard PostgreSQL error codes.
 *
 * @module
 */

/**
 * Extract the error-code string from a caught error, for SQLSTATE checks.
 *
 * Other error families also carry string `code`s (Node FS errors:
 * `ENOENT`, `ENOSPC`, …) — compare the result against specific SQLSTATE
 * values, never against truthiness.
 *
 * @param error - the caught error
 * @returns the `code` string, or `null` when the value isn't an `Error`
 * or carries no string `code`
 */
export const pg_error_code = (error: unknown): string | null =>
	error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
		? (error as { code: string }).code
		: null;

/**
 * Check if an error is a PostgreSQL unique constraint violation (error code 23505).
 *
 * @param error - the caught error
 * @returns `true` if the error is a unique constraint violation
 */
export const is_pg_unique_violation = (error: unknown): boolean => pg_error_code(error) === '23505';
