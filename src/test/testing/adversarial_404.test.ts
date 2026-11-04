/**
 * Tests for `extract_404_error_code` — the error code the adversarial 404
 * stub answers with, read from a Zod or a fuz_schema 404 schema.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { literal, object, one_of, pipe, string, transform } from '@fuzdev/fuz_schema/schema.ts';

import { extract_404_error_code } from '#lib/testing/adversarial_404.ts';

describe('extract_404_error_code', () => {
	test('reads a Zod literal and the first of an enum', () => {
		assert.strictEqual(
			extract_404_error_code(z.looseObject({ error: z.literal('thing_not_found') })),
			'thing_not_found'
		);
		assert.strictEqual(
			extract_404_error_code(z.looseObject({ error: z.enum(['a_not_found', 'b_not_found']) })),
			'a_not_found'
		);
	});

	test('reads the code beside a field JSON Schema cannot say', () => {
		// an output-side transform used to throw the whole read into `null`,
		// dropping the route from the suite
		const schema = z.looseObject({
			error: z.literal('thing_not_found'),
			name: z.string().transform((s) => s.length)
		});
		assert.strictEqual(extract_404_error_code(schema), 'thing_not_found');
	});

	test('reads a fuz_schema literal and the first of a one_of', () => {
		assert.strictEqual(
			extract_404_error_code(object({ error: literal('thing_not_found') })),
			'thing_not_found'
		);
		assert.strictEqual(
			extract_404_error_code(object({ error: one_of(['a_not_found', 'b_not_found']) })),
			'a_not_found'
		);
		assert.strictEqual(
			extract_404_error_code(
				object({
					error: literal('thing_not_found'),
					size: pipe(
						string,
						transform((s: string) => s.length)
					)
				})
			),
			'thing_not_found'
		);
	});

	test('is null when error is no literal or enum', () => {
		assert.strictEqual(extract_404_error_code(z.looseObject({ error: z.string() })), null);
		assert.strictEqual(extract_404_error_code(object({ error: string })), null);
		assert.strictEqual(extract_404_error_code(z.string()), null);
	});
});
