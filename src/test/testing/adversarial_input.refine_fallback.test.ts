/**
 * Coverage for the refine-fallback branch in `generate_input_test_cases`.
 *
 * A schema with a top-level `.refine()` requiring at least one of N
 * optional fields fails the initial base-object parse (everything skipped
 * as `!field.required && !field.has_default`). The fallback fills
 * optional fields until parse succeeds — without it, the function throws
 * before producing any test cases. Today only invite_create exercises
 * this path indirectly through the RPC attack-surface suite; this test
 * pins the contract directly so future contributors can't silently
 * regress it.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {generate_input_test_cases} from '$lib/testing/adversarial_input.ts';
import {generate_valid_body} from '$lib/testing/schema_generators.ts';

describe('generate_input_test_cases — refine fallback', () => {
	test('synthesizes a base body for a top-level .refine() over optional fields', () => {
		const schema = z
			.strictObject({
				a: z.string().optional(),
				b: z.string().optional(),
			})
			.refine((v) => v.a != null || v.b != null, {
				message: 'at least one of a or b is required',
			});

		const cases = generate_input_test_cases(schema);
		assert.ok(cases.length > 0, 'expected adversarial cases for a refine schema');
	});

	test('generate_valid_body matches: produces a body that satisfies the refine', () => {
		const schema = z
			.strictObject({
				email: z.string().optional(),
				username: z.string().optional(),
			})
			.refine((v) => v.email != null || v.username != null);

		const body = generate_valid_body(schema);
		assert.ok(body, 'expected a body');
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});
});
