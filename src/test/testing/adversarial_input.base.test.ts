/**
 * Coverage for the seeded base of `generate_input_test_cases` /
 * `generate_rpc_params_test_cases` — `{base}` replaces the generated body
 * every case breaks one field of, and a base the schema refuses throws.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import { generate_input_test_cases } from '#lib/testing/adversarial_input_cases.ts';
import { generate_rpc_params_test_cases } from '#lib/testing/rpc_envelope_cases.ts';

// exactly one of `id` / `slug` — the generated base fills `id`
const GetInput = z
	.strictObject({
		id: z.uuid().optional(),
		slug: z.string().min(1).max(40).optional(),
		count: z.number().int()
	})
	.refine((v) => Boolean(v.id) !== Boolean(v.slug), {
		message: 'exactly one of id or slug must be provided'
	});

const SEEDED_BASE = { slug: 'seeded_slug', count: 7 };

describe('generate_input_test_cases — seeded base', () => {
	test('cases are built from the seeded base', () => {
		const cases = generate_input_test_cases(GetInput, { base: SEEDED_BASE });
		const missing_count = cases.find((c) => c.label === 'missing: count');
		assert.ok(missing_count);
		assert.deepEqual(missing_count.body, { slug: 'seeded_slug' });
		const wrong_count = cases.find(
			(c) => c.label === 'wrong type: count (string instead of number)'
		);
		assert.ok(wrong_count);
		assert.deepEqual(wrong_count.body, { slug: 'seeded_slug', count: 'not_a_number' });
		// no case carries the generated base's `id`
		for (const c of cases) {
			if (typeof c.body !== 'object' || c.body === null || Array.isArray(c.body)) continue;
			if (c.label.includes(': id')) continue;
			assert.notProperty(c.body, 'id', c.label);
		}
	});

	test('without a base the generated one is used', () => {
		const cases = generate_input_test_cases(GetInput);
		const missing_count = cases.find((c) => c.label === 'missing: count');
		assert.ok(missing_count);
		assert.deepEqual(missing_count.body, { id: '00000000-0000-0000-0000-000000000000' });
	});

	test('the seeded base is not mutated', () => {
		const base = { ...SEEDED_BASE };
		generate_input_test_cases(GetInput, { base });
		assert.deepEqual(base, SEEDED_BASE);
	});

	test('a base the schema refuses throws, naming the label', () => {
		assert.throws(
			() =>
				generate_input_test_cases(GetInput, {
					base: { id: '00000000-0000-0000-0000-000000000000', slug: 'both', count: 1 },
					label: 'thing_get'
				}),
			/seeded base for 'thing_get' fails validation.*exactly one of id or slug/
		);
	});
});

describe('generate_rpc_params_test_cases — seeded base', () => {
	test('forwards the base and drops the structural cases', () => {
		const cases = generate_rpc_params_test_cases(GetInput, { base: SEEDED_BASE });
		assert.ok(cases.length > 0);
		assert.notInclude(
			cases.map((c) => c.label),
			'non-object body (array)'
		);
		const missing_count = cases.find((c) => c.label === 'missing: count');
		assert.ok(missing_count);
		assert.deepEqual(missing_count.body, { slug: 'seeded_slug' });
	});

	test('an invalid base throws, naming the method', () => {
		assert.throws(
			() => generate_rpc_params_test_cases(GetInput, { base: { count: 1 }, label: 'thing_get' }),
			/'thing_get'/
		);
	});
});
