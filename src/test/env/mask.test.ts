/**
 * Tests for env/mask.ts — env value display formatting with secret masking.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import {format_env_display_value, MASKED_VALUE} from '$lib/env/mask.js';

describe('format_env_display_value', () => {
	const cases: Array<[input: unknown, secret: boolean, expected: string]> = [
		// non-secret: strings pass through, others JSON-stringify
		['hello', false, 'hello'],
		['', false, ''],
		[4040, false, '4040'],
		[true, false, 'true'],
		[null, false, 'null'],
		[{a: 1}, false, '{"a":1}'],
		[undefined, false, 'undefined'],
		// secret: always masked
		['hunter2', true, MASKED_VALUE],
		[4040, true, MASKED_VALUE],
		[null, true, MASKED_VALUE],
	];

	for (const [input, secret, expected] of cases) {
		test(`(${JSON.stringify(input)}, secret=${secret}) → ${JSON.stringify(expected)}`, () => {
			assert.strictEqual(format_env_display_value(input, secret), expected);
		});
	}

	test('MASKED_VALUE is ***', () => {
		assert.strictEqual(MASKED_VALUE, '***');
	});
});
