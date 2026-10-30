/**
 * PostgreSQL error utilities.
 *
 * Works with both `pg` and `@electric-sql/pglite` — both set `.code`
 * on error objects using standard PostgreSQL error codes.
 *
 * @module
 */

import { is_db_checkout_error } from './db_checkout_error.ts';

/**
 * Extract the error-code string from a caught error, for SQLSTATE checks.
 *
 * A failed pool checkout (`DbCheckoutError`) is read through to its cause, so
 * a connect the server refused (`3D000` for a missing database, `28P01` for a
 * bad password) keeps its code.
 *
 * Other error families also carry string `code`s (Node FS errors:
 * `ENOENT`, `ENOSPC`, …) — compare the result against specific SQLSTATE
 * values, never against truthiness.
 *
 * @param error - the caught error
 * @returns the `code` string, or `null` when the value isn't an `Error`
 * or carries no string `code`
 */
export const pg_error_code = (error: unknown): string | null => {
	const err = is_db_checkout_error(error) ? (error as Error).cause : error;
	return err instanceof Error &&
		'code' in err &&
		typeof (err as { code: unknown }).code === 'string'
		? (err as { code: string }).code
		: null;
};

/**
 * Check if an error is a PostgreSQL unique constraint violation (error code 23505).
 *
 * @param error - the caught error
 * @returns `true` if the error is a unique constraint violation
 */
export const is_pg_unique_violation = (error: unknown): boolean => pg_error_code(error) === '23505';
