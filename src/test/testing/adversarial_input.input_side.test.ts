/**
 * Format and boundary cases read from a field's input side —
 * `to_field_json_schema` renders `io: 'input'` and resolves a nullable's
 * `anyOf`, so a field carrying a transform or pipe (`Username`) and an
 * optional nullable field keep the cases a bare field gets — and the guard
 * that no generated case is accidentally valid.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';

import {
	generate_input_test_cases,
	generate_params_test_cases,
	generate_query_test_cases,
	type InputTestCase
} from '#lib/testing/adversarial_input_cases.ts';
import { detect_format, to_field_json_schema } from '#lib/testing/schema_generators.ts';
import {
	Blake3Hash,
	bounded_string,
	Email,
	FactHashSchema,
	Timestamp,
	Username,
	USERNAME_LENGTH_MAX,
	UsernameProvided,
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

	test('reads the bounds of a pipe', () => {
		const json = to_field_json_schema(s.pipe(s.string, s.min_length(2), s.max_length(8)));
		assert.ok(json);
		assert.strictEqual(json.type, 'string');
		assert.strictEqual(json.minLength, 2);
		assert.strictEqual(json.maxLength, 8);
	});

	test("resolves a nullable's one non-null branch", () => {
		const json = to_field_json_schema(s.optional(s.nullable(Username)));
		assert.ok(json);
		assert.strictEqual(json.anyOf, undefined);
		assert.strictEqual(json.maxLength, USERNAME_LENGTH_MAX);
	});

	test("resolves a nullable's one non-null type", () => {
		// a bare `integer` folds to `type: ['integer', 'null']`, an anyOf when it has keywords
		assert.strictEqual(
			to_field_json_schema(s.nullable(s.pipe(s.number, s.integer))).type,
			'integer'
		);
		assert.strictEqual(
			to_field_json_schema(s.nullable(s.pipe(s.string, s.max_length(4)))).maxLength,
			4
		);
		assert.strictEqual(to_field_json_schema(s.nullable(s.boolean)).type, 'boolean');
	});

	test('keeps a union of two non-null branches whole', () => {
		const json = to_field_json_schema(
			s.union([s.pipe(s.string, s.max_length(3)), s.number, s.literal(null)])
		);
		assert.ok(json);
		assert.ok(Array.isArray(json.anyOf));
		assert.strictEqual(json.maxLength, undefined);
	});

	test('writes a type JSON Schema cannot represent with no constraints', () => {
		const { $schema: _, ...json } = to_field_json_schema(s.bigint);
		assert.deepEqual(json, {});
	});

	test('keeps the bounds of the branches beside one JSON Schema cannot represent', () => {
		const json = to_field_json_schema(s.union([s.pipe(s.string, s.max_length(3)), s.bigint]));
		assert.deepEqual(json.anyOf, [{ type: 'string', maxLength: 3 }, {}]);
	});

	test('keeps the bounds around a check JSON Schema cannot say', () => {
		const json = to_field_json_schema(
			s.pipe(
				s.string,
				s.max_length(5),
				s.check((v: string) => v !== 'x')
			)
		);
		assert.ok(json);
		assert.strictEqual(json.maxLength, 5);
	});

	test('reads a format', () => {
		assert.strictEqual(detect_format(s.pipe(s.string, s.uuid)), 'uuid');
	});

	test('throws on a schema fuz_schema refuses in either mode', () => {
		assert.throws(
			() => to_field_json_schema(s.object({ constructor: s.string })),
			/Object\.prototype/
		);
	});
});

describe('generate_input_test_cases — transform and pipe fields', () => {
	const Input = s.object({ username: Username, login: UsernameProvided });
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
		const Piped = s.object({ p: s.pipe(s.pipe(s.string, s.max_length(5)), s.min_length(2)) });
		assert.include(labels_of(generate_input_test_cases(Piped), 'p'), 'over maxLength: p (6 chars)');
	});

	test('the pattern violation fails the real regex', () => {
		const json = to_field_json_schema(Username);
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
	const Input = s.object({
		username: s.optional(s.nullable(Username)),
		count: s.nullable(s.pipe(s.number, s.integer, s.min_value(1), s.max_value(10))),
		tags: s.optional(s.nullable(s.pipe(s.array(s.string), s.min_length(1), s.max_length(3))))
	});
	const generate = () => generate_input_test_cases(Input);

	test('an optional nullable string field gets its format and length cases', () => {
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

	test('an optional nullable array field gets its item-count bounds', () => {
		assert.includeMembers(labels_of(generate(), 'tags'), [
			'empty array for minItems > 0: tags',
			'over maxItems: tags (4 items)'
		]);
	});
});

describe('generate_input_test_cases — union fields', () => {
	test("a union's branch format generates its violation", () => {
		// two datetime grammars behind one refine, as a `since` filter declares
		const Since = s.pipe(
			s.union([
				s.pipe(s.string, s.iso_datetime, s.max_length(30)),
				s.pipe(s.string, s.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/))
			]),
			s.check((v: string) => Number(v.slice(0, 4)) >= 1)
		);
		const cases = generate_input_test_cases(s.object({ since: s.optional(Since) }));
		assert.include(labels_of(cases, 'since'), 'format: since (malformed datetime)');
	});
});

describe('generate_input_test_cases — refine-only bounds', () => {
	test('a bound only a refinement enforces generates no boundary case', () => {
		// a code-point length JSON Schema can't express
		const CodePoints = s.pipe(
			s.string,
			s.check((v: string) => Array.from(v).length <= 39)
		);
		const cases = generate_input_test_cases(s.object({ name: CodePoints }));
		assert.deepEqual(labels_of(cases, 'name'), [
			'missing: name',
			'wrong type: name (number instead of string)',
			'null: name'
		]);
	});
});

describe('generate_input_test_cases — no case is accidentally valid', () => {
	// fields whose generated candidates a naive generator would emit as valid
	const fixtures: Record<string, s.Schema> = {
		username: Username,
		username_nullish: s.optional(s.nullable(Username)),
		username_provided: UsernameProvided,
		email: Email,
		email_nullish: s.optional(s.nullable(Email)),
		uuid: Uuid,
		uuid_nullable: s.nullable(Uuid),
		datetime: Timestamp,
		blake3: Blake3Hash,
		fact_hash: s.optional(s.nullable(FactHashSchema)),
		bounded: s.optional(s.nullable(bounded_string({ min: 2, max: 5 }))),
		piped: s.pipe(s.pipe(s.string, s.max_length(5)), s.min_length(2)),
		// bounded ahead of the trim, so the base is generated within it
		trimmed: s.pipe(
			s.string,
			s.max_length(4),
			s.transform((v: string) => v.trim()),
			s.min_length(1)
		),
		count: s.optional(s.nullable(s.pipe(s.number, s.integer, s.min_value(1), s.max_value(10)))),
		positive: s.pipe(s.number, s.min_value(1), s.max_value(99)),
		tags: s.optional(s.nullable(s.pipe(s.array(s.string), s.min_length(1), s.max_length(3)))),
		// a pattern that admits the pattern-violation string
		permissive_pattern: s.pipe(s.string, s.regex(/^[^\n]*$/))
	};
	const Input = s.object(fixtures);
	const generate = () => generate_input_test_cases(Input);

	test('every case fails the input schema, and every per-field case fails its field', () => {
		const cases = generate();
		assert.ok(cases.length > Object.keys(fixtures).length);
		for (const c of cases) {
			assert.isFalse(s.parse(Input, c.body).ok, c.label);
			if (c.field === undefined) continue;
			const value = (c.body as Record<string, unknown>)[c.field];
			assert.isFalse(s.parse(fixtures[c.field]!, value).ok, c.label);
		}
	});

	test('a candidate the field accepts is dropped', () => {
		assert.notInclude(
			labels_of(generate(), 'permissive_pattern'),
			'format: permissive_pattern (pattern violation)'
		);
	});

	test('params and query format cases fail their field', () => {
		const Params = s.object({
			id: Uuid,
			name: Username,
			loose: s.pipe(s.string, s.regex(/^[^\n]*$/))
		});
		const params_cases = generate_params_test_cases(Params);
		assert.includeMembers(
			params_cases.map((c) => c.label),
			['malformed uuid: param id', 'pattern violation: param name']
		);
		for (const c of params_cases) {
			assert.isFalse(s.parse(Params, c.params).ok, c.label);
		}
		const query_cases = generate_query_test_cases(Params);
		assert.include(
			query_cases.map((c) => c.label),
			'pattern violation: query name'
		);
		for (const c of query_cases) {
			assert.isFalse(s.parse(Params, c.query).ok, c.label);
		}
	});
});
