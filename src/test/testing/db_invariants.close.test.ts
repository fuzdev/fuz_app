/**
 * The close paths that must not lose a failure: `close_after_error` rethrows
 * the original when the close succeeds and aggregates both, original first,
 * when it fails; `check_db_invariants_and_close` closes a fixture whatever its
 * check found, and a failing close never hides the violation.
 *
 * @module
 */

import { assert, describe, test, type RunnerTask } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { close_after_error } from '#lib/testing/close_after_error.ts';
import { check_db_invariants_and_close } from '#lib/testing/db_invariants.ts';

/** A describe whose tests all passed, so the suite-level check runs. */
const PASSED_SUITE = {
	type: 'suite',
	result: { state: 'pass' },
	tasks: []
} as unknown as RunnerTask;

describe('close_after_error', () => {
	test('rethrows the original alone when the close succeeds', async () => {
		const original = new Error('original');
		let closed = false;
		const error = await assert_rejects(() =>
			close_after_error(async () => {
				closed = true;
			}, original)
		);
		assert.ok(closed);
		assert.strictEqual(error, original);
	});

	test('aggregates both, the original first, when the close fails too', async () => {
		const original = new Error('original');
		const close_error = new Error('close failed');
		const error = await assert_rejects(() =>
			close_after_error(() => Promise.reject(close_error), original)
		);
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [original, close_error]);
		assert.strictEqual(error.message, 'original');
	});
});

describe('check_db_invariants_and_close', () => {
	test('closes the fixture after a passing check', async () => {
		let closed = 0;
		await check_db_invariants_and_close(PASSED_SUITE, {
			assert_db_invariants: async () => {},
			close: async () => {
				closed++;
			}
		});
		assert.strictEqual(closed, 1);
	});

	test('closes the fixture on a violation and throws the violation', async () => {
		const violation = new Error('broken invariant');
		let closed = 0;
		const error = await assert_rejects(() =>
			check_db_invariants_and_close(PASSED_SUITE, {
				assert_db_invariants: () => Promise.reject(violation),
				close: async () => {
					closed++;
				}
			})
		);
		assert.strictEqual(closed, 1);
		assert.strictEqual(error, violation);
	});

	test('a failing close never hides the violation', async () => {
		const violation = new Error('broken invariant');
		const close_error = new Error('close failed');
		const error = await assert_rejects(() =>
			check_db_invariants_and_close(PASSED_SUITE, {
				assert_db_invariants: () => Promise.reject(violation),
				close: () => Promise.reject(close_error)
			})
		);
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [violation, close_error]);
	});

	test('does nothing for a fixture never built', async () => {
		await check_db_invariants_and_close(PASSED_SUITE, null);
	});
});
