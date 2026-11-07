/**
 * Coverage for the refine-fallback branch in `generate_input_test_cases`.
 *
 * A schema with a top-level refinement (a `check` piped after the object) requiring at least one of N
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
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import { generate_input_test_cases } from '#lib/testing/adversarial_input_cases.ts';
import { generate_valid_body } from '#lib/testing/schema_generators.ts';
import { Email, Uuid } from '#lib/primitive_schemas.ts';

describe('generate_input_test_cases — refine fallback', () => {
	test('synthesizes a base body for a top-level refinement over optional fields', () => {
		const schema = s.pipe(
			s.object({ a: s.optional(s.string), b: s.optional(s.string) }),
			s.check((v) => v.a != null || v.b != null, 'at least one of a or b is required')
		);

		const cases = generate_input_test_cases(schema);
		assert.ok(cases.length > 0, 'expected adversarial cases for a refine schema');
	});

	test('generate_valid_body matches: produces a body that satisfies the refine', () => {
		const schema = s.pipe(
			s.object({ email: s.optional(s.string), username: s.optional(s.string) }),
			s.check((v) => v.email != null || v.username != null)
		);

		const body = generate_valid_body(schema);
		assert.ok(body, 'expected a body');
		const parsed = s.parse(schema, body);
		assert.ok(parsed.ok, `body must round-trip: ${JSON.stringify(parsed)}`);
	});
});

describe('generate_valid_object — single optional field first', () => {
	test('an optional `acting` declared ahead of an exactly-one-of pair stays out', () => {
		const schema = s.pipe(
			s.object({
				acting: s.optional(Uuid),
				a: s.optional(s.string),
				b: s.optional(s.string)
			}),
			s.check((v) => (v.a !== undefined) !== (v.b !== undefined))
		);
		assert.deepEqual(generate_valid_body(schema), { a: 'xxxxxxxxxx' });
	});

	test('an unrelated optional field declared first stays out', () => {
		const schema = s.pipe(
			s.object({
				note: s.optional(s.pipe(s.string, s.max_length(5))),
				a: s.optional(s.string),
				b: s.optional(s.string)
			}),
			s.check((v) => (v.a !== undefined) !== (v.b !== undefined))
		);
		assert.deepEqual(generate_valid_body(schema), { a: 'xxxxxxxxxx' });
	});

	test('a nested refine needing only the second optional field is satisfied', () => {
		const schema = s.object({
			t: s.pipe(
				s.object({ a: s.optional(s.string), b: s.optional(s.string) }),
				s.check((v) => v.a === undefined && v.b !== undefined)
			)
		});
		assert.deepEqual(generate_valid_body(schema), { t: { b: 'xxxxxxxxxx' } });
	});

	test('an optional field whose generated value is invalid does not poison the fill', () => {
		const schema = s.pipe(
			s.object({
				a: s.optional(s.pipe(s.string, s.regex(/^q{3}$/))),
				b: s.optional(s.string)
			}),
			s.check((v) => (v.a !== undefined) !== (v.b !== undefined))
		);
		assert.deepEqual(generate_valid_body(schema), { b: 'xxxxxxxxxx' });
	});

	test('a refine needing two optional fields falls back to the cumulative fill', () => {
		const schema = s.pipe(
			s.object({ a: s.optional(s.string), b: s.optional(s.string) }),
			s.check((v) => v.a !== undefined && v.b !== undefined)
		);
		assert.deepEqual(generate_valid_body(schema), {
			a: 'xxxxxxxxxx',
			b: 'xxxxxxxxxx'
		});
	});

	test('the cumulative fill stops once the refine passes', () => {
		const schema = s.pipe(
			s.object({
				a: s.optional(s.string),
				b: s.optional(s.string),
				c: s.optional(s.string)
			}),
			s.check((v) => v.a !== undefined && v.b !== undefined)
		);
		assert.deepEqual(generate_valid_body(schema), {
			a: 'xxxxxxxxxx',
			b: 'xxxxxxxxxx'
		});
	});
});

describe('generate_input_test_cases — nested refine fallback', () => {
	// the shape of an invite input whose target is exactly one of email or username:
	// the nested refine fails on the required-only `{}`
	const InviteTarget = s.pipe(
		s.object({
			email: s.optional(Email),
			username: s.optional(s.pipe(s.string, s.min_length(1)))
		}),
		s.check(
			(v) => Boolean(v.email) !== Boolean(v.username),
			'exactly one of email or username must be provided'
		)
	);
	const InviteCreateInput = s.object({
		classroom_id: Uuid,
		target: meta(InviteTarget, {
			description: 'exactly one of `email` or `username`'
		}),
		message: s.optional(s.nullable(s.pipe(s.string, s.max_length(100)))),
		acting: s.optional(Uuid)
	});

	test('generate_valid_body fills the nested optional field the refine needs', () => {
		const body = generate_valid_body(InviteCreateInput);
		assert.ok(body);
		assert.deepEqual(body.target, { email: 'test@example.com' });
		assert.ok(s.parse(InviteCreateInput, body).ok);
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
			assert.ok(!s.parse(InviteCreateInput, c.body).ok, `case passes: ${c.label}`);
		}
	});

	test('the nested fill recurses through nested refined objects', () => {
		const schema = s.object({
			outer: s.object({
				inner: s.pipe(
					s.object({ a: s.optional(s.string), b: s.optional(s.string) }),
					s.check((v) => v.a !== undefined || v.b !== undefined)
				)
			})
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.deepEqual(body, { outer: { inner: { a: 'xxxxxxxxxx' } } });
	});

	test('the nested fill satisfies a refine on a wrapper of the object', () => {
		const schema = s.object({
			t: s.pipe(
				s.object({ a: s.optional(s.string), b: s.optional(s.string) }),
				s.transform((v: { a?: string; b?: string }) => v),
				s.check((v) => (v.a !== undefined) !== (v.b !== undefined))
			)
		});
		assert.deepEqual(generate_valid_body(schema), { t: { a: 'xxxxxxxxxx' } });
	});

	test('an unsatisfiable nested refine still throws, naming the label', () => {
		const schema = s.object({
			target: s.pipe(
				s.object({ a: s.optional(s.string) }),
				s.check(() => false, 'never valid')
			)
		});
		assert.throws(
			() => generate_input_test_cases(schema, { label: 'never_method' }),
			/generated base object fails validation for 'never_method'[\s\S]*target: expected never valid/
		);
	});
});
