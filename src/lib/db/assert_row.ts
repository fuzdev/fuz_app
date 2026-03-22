/**
 * Assertion helper for INSERT RETURNING results.
 *
 * @module
 */

/**
 * Assert that a row is present, throwing a descriptive error if missing.
 *
 * Use after `INSERT ... RETURNING` queries where the database guarantees
 * a row is returned on success. Replaces bare `row!` non-null assertions
 * with an explicit runtime check.
 *
 * @param row - the row from `query_one` (`T | undefined`) or `rows[0]` (`T | undefined`)
 * @param context - optional context for the error message (e.g. table or operation name)
 * @returns the row, guaranteed non-undefined
 */
export const assert_row = <T>(row: T | undefined, context?: string): T => {
	if (row === undefined) {
		throw new Error(
			context
				? `Expected row from ${context}, but got undefined`
				: 'Expected INSERT RETURNING to produce a row, but got undefined',
		);
	}
	return row;
};
