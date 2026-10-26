/**
 * Format and boundary cases read from a field's input side —
 * `to_field_json_schema` renders `io: 'input'` and resolves a nullable's
 * `anyOf`, so a field carrying a `.transform()` or pipe (`Username`) and a
 * `.nullish()` field keep the cases a bare field gets — and the guard that no
 * generated case is accidentally valid.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import {
	generate_input_test_cases,
	generate_params_test_cases,
	generate_query_test_cases,
	type InputTestCase
} from '#lib/testing/adversarial_input_cases.ts';
import { to_field_json_schema } from '#lib/testing/schema_generators.ts';
import {
	bounded_string,
	Blake3Hash,
	Datetime,
	Email,
	FactHashSchema,
	Username,
	UsernameProvided,
	USERNAME_LENGTH_MAX,
	Uuid
} from '#lib/primitive_schemas.ts';

const labels_of = (cases: Array<InputTestCase>, field: string): Array<string> =>
	cases.filter((c) => c.field === field).map((c) => c.label);

const value_of = (cases: Array<InputTestCase>, label: string): unknown => {
	const found = cases.find((c) => c.label === label);
	assert.ok(found, `no case '${label}'`);
	return (found.body as Record<string, unknown>)[found.field!];
};

describe('to_field_json_schema', () => {
	test('renders the input side of a transform', () => {
		const json = to_field_json_schema(Username);
		assert.ok(json);
		assert.strictEqual(json.minLength, 3);
		assert.strictEqual(json.maxLength, USERNAME_LENGTH_MAX);
		assert.strictEqual(typeof json.pattern, 'string');
	});

	test("resolves a nullable's one non-null branch", () => {
		const json = to_field_json_schema(Username.nullish());
		assert.ok(json);
		assert.strictEqual(json.anyOf, undefined);
		assert.strictEqual(json.maxLength, USERNAME_LENGTH_MAX);
	});

	test('keeps a union of two non-null branches whole', () => {
		const json = to_field_json_schema(z.union([z.string().max(3), z.number(), z.null()]));
		assert.ok(json);
		assert.ok(Array.isArray(json.anyOf));
		assert.strictEqual(json.maxLength, undefined);
	});

	test('is null for a type JSON Schema cannot represent', () => {
		assert.strictEqual(to_field_json_schema(z.date()), null);
	});
});

describe('generate_input_test_cases — transform and pipe fields', () => {
	const Input = z.strictObject({ username: Username, login: UsernameProvided });
	// generated per test, so a generator failure fails each test, not collection
	const generate = () => generate_input_test_cases(Input);

	test('a transform field gets its format and length cases', () => {
		assert.includeMembers(labels_of(generate(), 'username'), [
			'format: username (pattern violation)',
			'empty string: username',
			`over maxLength: username (${USERNAME_LENGTH_MAX + 1} chars)`
		]);
	});

	test('a transform-then-refine field gets its length cases', () => {
		assert.includeMembers(labels_of(generate(), 'login'), [
			'empty string: login',
			'over maxLength: login (256 chars)'
		]);
	});

	test("a pipe's input-side bounds generate cases", () => {
		const Piped = z.strictObject({ p: z.string().max(5).pipe(z.string().min(2)) });
		assert.include(labels_of(generate_input_test_cases(Piped), 'p'), 'over maxLength: p (6 chars)');
	});

	test('the pattern violation fails the real regex', () => {
		const json = to_field_json_schema(Username)!;
		const value = value_of(generate(), 'format: username (pattern violation)');
		assert.strictEqual(typeof value, 'string');
		assert.isFalse(new RegExp(json.pattern as string).test(value as string));
	});

	test('the over-maxLength string is over in UTF-16 units and in code points', () => {
		const value = value_of(
			generate(),
			`over maxLength: username (${USERNAME_LENGTH_MAX + 1} chars)`
		);
		assert.strictEqual(typeof value, 'string');
		assert.strictEqual((value as string).length, USERNAME_LENGTH_MAX + 1);
		assert.strictEqual(Array.from(value as string).length, USERNAME_LENGTH_MAX + 1);
	});
});

describe('generate_input_test_cases — bounds under a nullable anyOf', () => {
	const Input = z.strictObject({
		username: Username.nullish(),
		count: z.number().int().min(1).max(10).nullable(),
		tags: z.array(z.string()).min(1).max(3).nullish()
	});
	const generate = () => generate_input_test_cases(Input);

	test('a nullish string field gets its format and length cases', () => {
		assert.includeMembers(labels_of(generate(), 'username'), [
			'format: username (pattern violation)',
			'empty string: username',
			`over maxLength: username (${USERNAME_LENGTH_MAX + 1} chars)`
		]);
	});

	test('a nullable number field gets its numeric bounds', () => {
		assert.includeMembers(labels_of(generate(), 'count'), [
			'below minimum: count (0)',
			'above maximum: count (11)'
		]);
	});

	test('a nullish array field gets its item-count bounds', () => {
		assert.includeMembers(labels_of(generate(), 'tags'), [
			'empty array for minItems > 0: tags',
			'over maxItems: tags (4 items)'
		]);
	});
});

describe('generate_input_test_cases — union fields', () => {
	test("a union's branch format generates its violation", () => {
		// two datetime grammars behind one refine, as a `since` filter declares
		const Since = z
			.union([z.iso.datetime().max(30), z.iso.datetime({ precision: -1 })])
			.refine((v) => Number(v.slice(0, 4)) >= 1);
		const cases = generate_input_test_cases(z.strictObject({ since: Since.optional() }));
		assert.include(labels_of(cases, 'since'), 'format: since (malformed datetime)');
	});
});

describe('generate_input_test_cases — refine-only bounds', () => {
	test('a bound only a refinement enforces generates no boundary case', () => {
		// a code-point length JSON Schema can't express
		const CodePoints = z.string().refine((s) => Array.from(s).length <= 39);
		const cases = generate_input_test_cases(z.strictObject({ name: CodePoints }));
		assert.deepEqual(labels_of(cases, 'name'), [
			'missing: name',
			'wrong type: name (number instead of string)',
			'null: name'
		]);
	});
});

describe('generate_input_test_cases — no case is accidentally valid', () => {
	// fields whose generated candidates a naive generator would emit as valid
	const fixtures: Record<string, z.ZodType> = {
		username: Username,
		username_nullish: Username.nullish(),
		username_provided: UsernameProvided,
		email: Email,
		email_nullish: Email.nullish(),
		uuid: Uuid,
		uuid_nullable: Uuid.nullable(),
		datetime: Datetime,
		blake3: Blake3Hash,
		fact_hash: FactHashSchema.nullish(),
		bounded: bounded_string({ min: 2, max: 5 }).nullish(),
		piped: z.string().max(5).pipe(z.string().min(2)),
		trimmed: z.string().trim().min(1).max(4),
		count: z.number().int().min(1).max(10).nullish(),
		positive: z.number().positive().lt(100),
		tags: z.array(z.string()).min(1).max(3).nullish(),
		// a pattern that admits the pattern-violation string
		permissive_pattern: z.string().regex(/^[^\n]*$/),
		// a coercion that accepts the wrong-type value
		coerced: z.coerce.string(),
		// a preprocess that accepts the empty and over-long strings
		padded: z.preprocess(
			(v) => (typeof v === 'string' ? v.padEnd(1, 'x').slice(0, 4) : v),
			z.string().min(1).max(4)
		)
	};
	const Input = z.strictObject(fixtures);
	const generate = () => generate_input_test_cases(Input);

	test('every case fails the input schema, and every per-field case fails its field', () => {
		const cases = generate();
		assert.ok(cases.length > Object.keys(fixtures).length);
		for (const c of cases) {
			assert.isFalse(Input.safeParse(c.body).success, c.label);
			if (c.field === undefined) continue;
			const value = (c.body as Record<string, unknown>)[c.field];
			assert.isFalse(fixtures[c.field]!.safeParse(value).success, c.label);
		}
	});

	test('a candidate the field accepts is dropped', () => {
		assert.notInclude(
			labels_of(generate(), 'permissive_pattern'),
			'format: permissive_pattern (pattern violation)'
		);
		assert.notInclude(
			labels_of(generate(), 'coerced'),
			'wrong type: coerced (number instead of string)'
		);
		assert.notInclude(labels_of(generate(), 'padded'), 'empty string: padded');
		assert.notInclude(labels_of(generate(), 'padded'), 'over maxLength: padded (5 chars)');
	});

	test('params and query format cases fail their field', () => {
		const Params = z.strictObject({
			id: Uuid,
			name: Username,
			loose: z.string().regex(/^[^\n]*$/)
		});
		const params_cases = generate_params_test_cases(Params);
		assert.includeMembers(
			params_cases.map((c) => c.label),
			['malformed uuid: param id', 'pattern violation: param name']
		);
		for (const c of params_cases) {
			assert.isFalse(Params.safeParse(c.params).success, c.label);
		}
		const query_cases = generate_query_test_cases(Params);
		assert.include(
			query_cases.map((c) => c.label),
			'pattern violation: query name'
		);
		for (const c of query_cases) {
			assert.isFalse(Params.safeParse(c.query).success, c.label);
		}
	});
});
