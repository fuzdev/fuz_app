/**
 * The boundary values `generate_input_test_cases` builds beside the empty
 * string, the empty array and the out-of-range numbers: one short of a
 * `minLength` or `minItems` above one and a non-integer for an integer field —
 * each inside the field's other bounds, so the bound it is named for is the
 * one that refuses.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';

import {
	expected_invalid_reason,
	generate_input_test_cases,
	type InputTestCase
} from '#lib/testing/adversarial_input_cases.ts';
import { AdminAccountListInput } from '#lib/auth/admin_action_specs.ts';
import { ERROR_LIMIT_INVALID } from '#lib/http/error_schemas.ts';
import { Uuid } from '#lib/primitive_schemas.ts';

const labels_of = (cases: Array<InputTestCase>, field: string): Array<string> =>
	cases.filter((c) => c.field === field).map((c) => c.label);

const value_of = (cases: Array<InputTestCase>, label: string): unknown => {
	const found = cases.find((c) => c.label === label);
	assert.ok(found, `no case '${label}'`);
	return (found.body as Record<string, unknown>)[found.field!];
};

describe('generate_input_test_cases — under minLength', () => {
	test('a string one short of minLength, a prefix of the valid value', () => {
		// `x`s fail the pattern, so only a prefix of the valid value isolates the length
		const Input = s.object({
			name: s.pipe(s.string, s.regex(/^[a-d]*$/), s.min_length(4), s.max_length(20))
		});
		const cases = generate_input_test_cases(Input, { base: { name: 'abcd' } });
		assert.strictEqual(value_of(cases, 'under minLength: name (3 chars)'), 'abc');
		assert.include(labels_of(cases, 'name'), 'empty string: name');
	});

	test('a minLength of one has the empty string only', () => {
		const cases = generate_input_test_cases(s.object({ name: s.pipe(s.string, s.min_length(1)) }));
		assert.include(labels_of(cases, 'name'), 'empty string: name');
		assert.notOk(labels_of(cases, 'name').some((l) => l.startsWith('under minLength')));
	});
});

describe('generate_input_test_cases — under minItems', () => {
	test("an array one short of minItems carries the valid value's items", () => {
		const Input = s.object({
			ids: s.pipe(s.array(Uuid), s.min_length(3), s.max_length(5))
		});
		const cases = generate_input_test_cases(Input);
		const value = value_of(cases, 'under minItems: ids (2 items)');
		assert.deepEqual(value, [
			'00000000-0000-0000-0000-000000000000',
			'00000000-0000-0000-0000-000000000000'
		]);
		assert.include(labels_of(cases, 'ids'), 'empty array for minItems > 0: ids');
	});

	test('a minItems of one has the empty array only', () => {
		const cases = generate_input_test_cases(
			s.object({ ids: s.pipe(s.array(Uuid), s.min_length(1)) })
		);
		assert.notOk(labels_of(cases, 'ids').some((l) => l.startsWith('under minItems')));
	});
});

describe('generate_input_test_cases — non-integer', () => {
	test('an integer field gets a non-integer inside its range', () => {
		const cases = generate_input_test_cases(
			s.object({
				count: s.pipe(s.number, s.integer, s.min_value(1), s.max_value(10))
			})
		);
		assert.strictEqual(value_of(cases, 'non-integer: count (1.5)'), 1.5);
	});

	test('the non-integer steps down when up leaves the range', () => {
		const cases = generate_input_test_cases(
			s.object({
				count: s.pipe(s.number, s.integer, s.min_value(-5), s.max_value(-1))
			})
		);
		// the valid value is -1, the maximum
		assert.strictEqual(value_of(cases, 'non-integer: count (-1.5)'), -1.5);
	});

	test('a number field gets none', () => {
		const cases = generate_input_test_cases(
			s.object({ ratio: s.pipe(s.number, s.min_value(0), s.max_value(1)) })
		);
		assert.notOk(labels_of(cases, 'ratio').some((l) => l.startsWith('non-integer')));
	});

	test("a non-integer limit owes the field's declared reason", () => {
		const case_ = generate_input_test_cases(AdminAccountListInput).find(
			(c) => c.label === 'non-integer: limit (1.5)'
		);
		assert.ok(case_);
		assert.strictEqual(expected_invalid_reason(AdminAccountListInput, case_), ERROR_LIMIT_INVALID);
	});
});
