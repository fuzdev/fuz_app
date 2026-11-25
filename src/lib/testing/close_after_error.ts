import './assert_dev_env.ts';

/**
 * `close_after_error` — release what a failed step's caller acquired without
 * losing the failure. A vitest-free leaf, so the test app, the invariant
 * hooks and the shipped suites share it without reaching one another's
 * import graphs.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';

/**
 * Run `close` after `error` failed what it guards, then throw: `error` alone,
 * or, when the close fails too, an `AggregateError` of both, `error` first.
 *
 * @param close - releases what the failed step's caller acquired
 * @param error - the failure, rethrown
 * @throws the failure, or an `AggregateError` of it and the close's
 */
export const close_after_error = async (
	close: () => Promise<void>,
	error: unknown
): Promise<never> => {
	try {
		await close();
	} catch (close_error) {
		throw new AggregateError([error, close_error], to_error_message(error));
	}
	throw error;
};
