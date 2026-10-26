/**
 * Coverage for the refine-fallback branch in `generate_input_test_cases`.
 *
 * A schema with a top-level `.refine()` requiring at least one of N
 * optional fields fails the initial base-object parse (everything skipped
 * as `!field.required && !field.has_default`). The fallback fills
 * optional fields until parse succeeds — without it, the function throws
 * before producing any test cases. Each optional field is tried alone
 * first, so one the refine doesn't need stays out of the body, then the
 * fields cumulatively, for a refine needing several. The same fill runs for
 * nested objects (`generate_valid_object` from `generate_valid_value`'s
 * object case), so a nested exactly-one-of target is satisfied too. These
 * tests pin the contract directly so future contributors can't silently
 * regress it.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import { generate_input_test_cases } from '#lib/testing/adversarial_input_cases.ts';
import { generate_valid_body } from '#lib/testing/schema_generators.ts';

describe('generate_input_test_cases — refine fallback', () => {
	test('synthesizes a base body for a top-level .refine() over optional fields', () => {
		const schema = z
			.strictObject({
				a: z.string().optional(),
				b: z.string().optional()
			})
			.refine((v) => v.a != null || v.b != null, {
				message: 'at least one of a or b is required'
			});

		const cases = generate_input_test_cases(schema);
		assert.ok(cases.length > 0, 'expected adversarial cases for a refine schema');
	});

	test('generate_valid_body matches: produces a body that satisfies the refine', () => {
		const schema = z
			.strictObject({
				email: z.string().optional(),
				username: z.string().optional()
			})
			.refine((v) => v.email != null || v.username != null);

		const body = generate_valid_body(schema);
		assert.ok(body, 'expected a body');
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});
});

describe('generate_valid_object — single optional field first', () => {
	test('an optional `acting` declared ahead of an exactly-one-of pair stays out', () => {
		const schema = z
			.strictObject({
				acting: z.uuid().optional(),
				a: z.string().optional(),
				b: z.string().optional()
			})
			.refine((v) => (v.a !== undefined) !== (v.b !== undefined));
		assert.deepEqual(generate_valid_body(schema), { a: 'xxxxxxxxxx' });
	});

	test('an unrelated optional field declared first stays out', () => {
		const schema = z
			.strictObject({
				note: z.string().max(5).optional(),
				a: z.string().optional(),
				b: z.string().optional()
			})
			.refine((v) => (v.a !== undefined) !== (v.b !== undefined));
		assert.deepEqual(generate_valid_body(schema), { a: 'xxxxxxxxxx' });
	});

	test('a nested refine needing only the second optional field is satisfied', () => {
		const schema = z.strictObject({
			t: z
				.strictObject({ a: z.string().optional(), b: z.string().optional() })
				.refine((v) => v.a === undefined && v.b !== undefined)
		});
		assert.deepEqual(generate_valid_body(schema), { t: { b: 'xxxxxxxxxx' } });
	});

	test('an optional field whose generated value is invalid does not poison the fill', () => {
		const schema = z
			.strictObject({
				a: z
					.string()
					.regex(/^q{3}$/)
					.optional(),
				b: z.string().optional()
			})
			.refine((v) => (v.a !== undefined) !== (v.b !== undefined));
		assert.deepEqual(generate_valid_body(schema), { b: 'xxxxxxxxxx' });
	});

	test('a refine needing two optional fields falls back to the cumulative fill', () => {
		const schema = z
			.strictObject({ a: z.string().optional(), b: z.string().optional() })
			.refine((v) => v.a !== undefined && v.b !== undefined);
		assert.deepEqual(generate_valid_body(schema), { a: 'xxxxxxxxxx', b: 'xxxxxxxxxx' });
	});

	test('the cumulative fill stops once the refine passes', () => {
		const schema = z
			.strictObject({
				a: z.string().optional(),
				b: z.string().optional(),
				c: z.string().optional()
			})
			.refine((v) => v.a !== undefined && v.b !== undefined);
		assert.deepEqual(generate_valid_body(schema), { a: 'xxxxxxxxxx', b: 'xxxxxxxxxx' });
	});
});

describe('generate_input_test_cases — nested refine fallback', () => {
	// the shape of an invite input whose target is exactly one of email or username:
	// the nested refine fails on the required-only `{}`
	const InviteTarget = z
		.strictObject({
			email: z.email().optional(),
			username: z.string().min(1).optional()
		})
		.refine((v) => Boolean(v.email) !== Boolean(v.username), {
			message: 'exactly one of email or username must be provided'
		});
	const InviteCreateInput = z.strictObject({
		classroom_id: z.uuid(),
		target: InviteTarget.meta({ description: 'exactly one of `email` or `username`' }),
		message: z.string().max(100).nullish(),
		acting: z.uuid().optional()
	});

	test('generate_valid_body fills the nested optional field the refine needs', () => {
		const body = generate_valid_body(InviteCreateInput);
		assert.ok(body);
		assert.deepEqual(body.target, { email: 'test@example.com' });
		assert.ok(InviteCreateInput.safeParse(body).success);
		// the top level needed no optional field
		assert.notProperty(body, 'message');
		assert.notProperty(body, 'acting');
	});

	test('generate_input_test_cases builds cases from a base that passes', () => {
		const cases = generate_input_test_cases(InviteCreateInput);
		const labels = cases.map((c) => c.label);
		assert.include(labels, 'missing: target');
		assert.include(labels, 'wrong type: target (string instead of object)');
		for (const c of cases) {
			assert.ok(!InviteCreateInput.safeParse(c.body).success, `case passes: ${c.label}`);
		}
	});

	test('the nested fill recurses through nested refined objects', () => {
		const schema = z.strictObject({
			outer: z.strictObject({
				inner: z
					.strictObject({ a: z.string().optional(), b: z.string().optional() })
					.refine((v) => v.a !== undefined || v.b !== undefined)
			})
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.deepEqual(body, { outer: { inner: { a: 'xxxxxxxxxx' } } });
	});

	test('the nested fill satisfies a refine on a wrapper of the object', () => {
		const schema = z.strictObject({
			t: z
				.strictObject({ a: z.string().optional(), b: z.string().optional() })
				.transform((v) => v)
				.refine((v) => (v.a !== undefined) !== (v.b !== undefined))
		});
		assert.deepEqual(generate_valid_body(schema), { t: { a: 'xxxxxxxxxx' } });
	});

	test('an unsatisfiable nested refine still throws, naming the label', () => {
		const schema = z.strictObject({
			target: z.strictObject({ a: z.string().optional() }).refine(() => false, {
				message: 'never valid'
			})
		});
		assert.throws(
			() => generate_input_test_cases(schema, { label: 'never_method' }),
			/generated base object fails validation for 'never_method'.*target: never valid/
		);
	});
});
