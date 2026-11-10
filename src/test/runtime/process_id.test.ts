/**
 * Tests for runtime/process_id.ts — which numbers name one process.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { assert_process_id, is_process_id, PROCESS_ID_MAX } from '#lib/runtime/process_id.ts';

describe('is_process_id', () => {
	test('a positive integer up to PROCESS_ID_MAX names one process', () => {
		for (const pid of [1, 2, PROCESS_ID_MAX]) {
			assert.ok(is_process_id(pid), String(pid));
			assert_process_id(pid);
		}
	});

	test('0, negatives, non-integers, and past PROCESS_ID_MAX do not', () => {
		for (const pid of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, PROCESS_ID_MAX + 1]) {
			assert.ok(!is_process_id(pid), String(pid));
			assert.throws(() => assert_process_id(pid), RangeError, undefined, String(pid));
		}
	});
});
