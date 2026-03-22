/**
 * PostgreSQL error utilities.
 *
 * Works with both `pg` and `@electric-sql/pglite` — both set `.code`
 * on error objects using standard PostgreSQL error codes.
 *
 * @module
 */

/**
 * Check if an error is a PostgreSQL unique constraint violation (error code 23505).
 *
 * @param error - the caught error
 * @returns `true` if the error is a unique constraint violation
 */
export const is_pg_unique_violation = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && (error as {code: unknown}).code === '23505';
