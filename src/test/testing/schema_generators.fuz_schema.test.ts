/**
 * The testing generators over `@fuzdev/fuz_schema` schemas: valid bodies,
 * paths and string params a fuz_schema schema accepts, adversarial cases a
 * fuz_schema input refuses, the RPC output checks, and the throw on an input
 * no body can be generated for or a schema of neither library.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import {
	array,
	boolean,
	check,
	integer,
	iso_datetime,
	literal,
	loose_object,
	max_length,
	max_value,
	min_length,
	min_value,
	nullable,
	number,
	object,
	one_of,
	optional,
	parse,
	pipe,
	record,
	regex,
	string,
	union,
	uuid,
	variant,
	void as fuz_void,
	with_default,
	type AnySchema
} from '@fuzdev/fuz_schema/schema.ts';

import {
	generate_valid_body,
	generate_valid_object,
	generate_valid_string_param,
	resolve_valid_path,
	to_object_schema_view
} from '#lib/testing/schema_generators.ts';
import {
	generate_input_test_cases,
	generate_params_test_cases,
	generate_query_test_cases
} from '#lib/testing/adversarial_input_cases.ts';
import { assert_jsonrpc_success_response } from '#lib/testing/rpc_helpers.ts';
import { expect_output } from '#lib/testing/cross_backend/cross_rpc.ts';
import { parse_any } from '#lib/schema_issues.ts';

const TOKEN_ID = pipe(string, regex(/^tok_[A-Za-z0-9_-]{12}$/));

const Input = object({
	name: pipe(string, min_length(3), max_length(20)),
	count: pipe(number, integer, min_value(5), max_value(9)),
	enabled: boolean,
	tags: pipe(array(string), min_length(2)),
	id: pipe(string, uuid),
	at: pipe(string, iso_datetime),
	token_id: TOKEN_ID,
	kind: literal('full'),
	mode: one_of(['a', 'b']),
	choice: union([object({ x: number }), string]),
	shape: variant('type', [object({ type: literal('dot') }), object({ type: literal('box') })]),
	nested: object({ inner: pipe(string, min_length(1)) }),
	maybe: nullable(string),
	note: optional(string),
	limit: with_default(number, 10)
});

describe('generate_valid_body over fuz_schema', () => {
	test('generates a body the schema accepts, every required and defaulted field filled', () => {
		const body = generate_valid_body(Input);
		assert.ok(body);
		assert.ok(parse(Input, body).ok, JSON.stringify(body));
		assert.deepEqual(
			Object.keys(body).sort(),
			Object.keys(Input.def)
				.filter((k) => k !== 'note')
				.sort(),
			'the optional field stays out, the defaulted one is generated'
		);
	});

	test('a regex field gets a value the schema accepts', () => {
		const body = generate_valid_body(object({ token_id: TOKEN_ID }));
		assert.deepEqual(body, { token_id: 'tok_xxxxxxxxxxxx' });
	});

	test('a check over optional fields is satisfied', () => {
		const ExactlyOne = pipe(
			object({ id: optional(string), slug: optional(string) }),
			check((v: { id?: string; slug?: string }) => (v.id === undefined) !== (v.slug === undefined))
		);
		const body = generate_valid_body(ExactlyOne);
		assert.ok(body && parse(ExactlyOne, body).ok, JSON.stringify(body));
	});

	test('a wrapped object schema generates its object', () => {
		const body = generate_valid_body(optional(object({ a: string })));
		assert.deepEqual(body, { a: 'xxxxxxxxxx' });
	});

	test('a void or null input takes no body', () => {
		assert.strictEqual(generate_valid_body(fuz_void), undefined);
		assert.strictEqual(generate_valid_body(literal(null)), undefined);
	});

	test('a void under a wrapper throws, as dispatch reads absent params as `{}` for it', () => {
		assert.throws(() => generate_valid_body(optional(fuz_void)), /void under wrappers/);
		assert.throws(() => generate_valid_body(z.void().optional()), /void under wrappers/);
	});

	test('a record field generates an empty record, in both libraries', () => {
		const fuz_input = object({ tags: record(string), n: number });
		const fuz_body = generate_valid_body(fuz_input);
		assert.deepEqual(fuz_body, { tags: {}, n: 1 });
		assert.ok(parse(fuz_input, fuz_body).ok);
		const zod_input = z.strictObject({ tags: z.record(z.string(), z.string()), n: z.number() });
		const zod_body = generate_valid_body(zod_input);
		assert.deepEqual(zod_body, { tags: {}, n: 1 });
		assert.ok(zod_input.safeParse(zod_body).success);
	});

	test('a void field generates undefined, in both libraries', () => {
		assert.deepEqual(generate_valid_body(object({ v: fuz_void, n: number })), {
			v: undefined,
			n: 1
		});
		assert.deepEqual(generate_valid_body(z.strictObject({ v: z.void(), n: z.number() })), {
			v: undefined,
			n: 1
		});
	});

	test('a zod `z.undefined()` field generates undefined', () => {
		const input = z.strictObject({ u: z.undefined(), n: z.number() });
		const body = generate_valid_body(input);
		assert.deepEqual(body, { u: undefined, n: 1 });
		assert.ok(input.safeParse(body).success);
	});

	test('an input that is no object schema throws', () => {
		for (const schema of [string, union([object({ a: string }), object({ b: string })])]) {
			assert.throws(
				() => generate_valid_body(schema),
				/generate_valid_body: the input is no object, void or null schema/
			);
		}
		assert.throws(() => generate_valid_body(z.string()), /innermost type is 'string'/);
	});

	test('an unrecognized schema throws', () => {
		for (const schema of [{}, { safeParse: () => ({ success: true }) }]) {
			assert.throws(
				() => generate_valid_body(schema as unknown as AnySchema),
				/generate_valid_body: the input is neither a Zod schema nor a @fuzdev\/fuz_schema schema/
			);
		}
	});

	test('generate_valid_object returns the parse result', () => {
		const generated = generate_valid_object(object({ a: string }), object({ a: string }));
		assert.ok(generated.result.ok);
		assert.deepEqual(generated.value, { a: 'xxxxxxxxxx' });
		assert.throws(
			() => generate_valid_object(string, string),
			/generate_valid_object: the object schema is not an object schema/
		);
	});
});

describe('to_object_schema_view over fuz_schema', () => {
	test('reads each field in Zod vocabulary', () => {
		const { fields } = to_object_schema_view(Input, 'Input');
		const by_name = Object.fromEntries(fields.map((f) => [f.name, f]));
		assert.strictEqual(by_name.name!.base_type, 'string');
		assert.strictEqual(by_name.count!.base_type, 'number');
		assert.strictEqual(by_name.nested!.base_type, 'object');
		assert.strictEqual(by_name.mode!.base_type, 'enum');
		assert.strictEqual(by_name.shape!.base_type, 'union');
		assert.strictEqual(by_name.kind!.base_type, 'literal');
		assert.isTrue(by_name.maybe!.nullable);
		assert.isFalse(by_name.note!.required);
		assert.isTrue(by_name.limit!.has_default);
		assert.isTrue(by_name.name!.required);
	});

	test('a literal(null) field reads as null, as z.null() does', () => {
		const [field] = to_object_schema_view(object({ n: literal(null) }), 'n').fields;
		assert.strictEqual(field!.base_type, 'null');
		assert.strictEqual(
			to_object_schema_view(z.strictObject({ n: z.null() }), 'n').fields[0]!.base_type,
			'null'
		);
	});

	test('a literal(undefined) field reads as void, as z.void() does', () => {
		const [field] = to_object_schema_view(object({ v: fuz_void }), 'v').fields;
		assert.strictEqual(field!.base_type, 'void');
		assert.strictEqual(
			to_object_schema_view(z.strictObject({ v: z.void() }), 'v').fields[0]!.base_type,
			'void'
		);
	});

	test('matches zod_extract_fields on the same shape', () => {
		const zod_fields = to_object_schema_view(
			z.strictObject({ a: z.string(), b: z.number().optional(), c: z.boolean().nullable() }),
			'zod'
		).fields;
		const fuz_fields = to_object_schema_view(
			object({ a: string, b: optional(number), c: nullable(boolean) }),
			'fuz'
		).fields;
		assert.deepEqual(fuz_fields, zod_fields);
	});
});

describe('resolve_valid_path and generate_valid_string_param over fuz_schema', () => {
	test('a constrained param resolves to a value its schema accepts', () => {
		const params = object({ token_id: TOKEN_ID, id: pipe(string, uuid), name: string });
		assert.strictEqual(
			resolve_valid_path('/api/tokens/:token_id/:id/:name', params),
			'/api/tokens/tok_xxxxxxxxxxxx/00000000-0000-0000-0000-000000000000/test_name'
		);
	});

	test('a params schema that is no object schema throws', () => {
		assert.throws(() => resolve_valid_path('/x/:id', string), /is not an object schema/);
	});

	test('a string param is found for each field', () => {
		const view = to_object_schema_view(object({ token_id: TOKEN_ID, n: string }), 'q');
		for (const field of view.fields) {
			const field_schema = view.field_schema(field.name)!;
			const value = generate_valid_string_param(field, field_schema);
			assert.ok(value !== null && parse_any(field_schema, value).ok, field.name);
		}
	});
});

describe('generate_input_test_cases over fuz_schema', () => {
	test('a fuz_schema object input gets cases, each refused by the input', () => {
		const cases = generate_input_test_cases(Input);
		assert.ok(cases.length > 0);
		const labels = cases.map((c) => c.label);
		for (const expected of [
			'extra unknown key',
			'missing: name',
			'wrong type: count (string instead of number)',
			'null: enabled',
			'format: token_id (pattern violation)',
			'format: id (malformed uuid)',
			'under minLength: name (2 chars)',
			'over maxLength: name (21 chars)',
			'below minimum: count (4)',
			'above maximum: count (10)',
			'non-integer: count (5.5)',
			'under minItems: tags (1 items)'
		]) {
			assert.include(labels, expected);
		}
		for (const c of cases) {
			assert.isFalse(parse(Input, c.body).ok, c.label);
		}
	});

	test('a loose_object input gets no extra-key case', () => {
		const labels = generate_input_test_cases(loose_object({ a: string })).map((c) => c.label);
		assert.notInclude(labels, 'extra unknown key');
		assert.include(labels, 'missing: a');
	});

	test('a void or null input gets no cases, a wrapped void or an input that is no object throws', () => {
		assert.deepEqual(generate_input_test_cases(fuz_void), []);
		assert.deepEqual(generate_input_test_cases(literal(null)), []);
		assert.throws(() => generate_input_test_cases(optional(fuz_void)), /void under wrappers/);
		assert.throws(() => generate_input_test_cases(z.void().optional()), /void under wrappers/);
		assert.throws(
			() => generate_input_test_cases(array(string), { label: 'thing_list' }),
			/the input for 'thing_list' is no object, void or null schema/
		);
		assert.throws(
			() => generate_input_test_cases({} as unknown as AnySchema),
			/is neither a Zod schema nor a @fuzdev\/fuz_schema schema/
		);
	});

	test('a seeded base the input refuses throws, naming the issues', () => {
		assert.throws(
			() => generate_input_test_cases(object({ a: string }), { base: { a: 1 }, label: 'm' }),
			/the seeded base for 'm' fails validation[\s\S]*a/
		);
	});
});

describe('generate_params_test_cases and generate_query_test_cases over fuz_schema', () => {
	test('a constrained param gets its violation, refused by the field', () => {
		const params = object({ token_id: TOKEN_ID, id: pipe(string, uuid) });
		const cases = generate_params_test_cases(params);
		assert.deepEqual(
			cases.map((c) => c.label),
			['pattern violation: param token_id', 'malformed uuid: param id']
		);
		for (const c of cases) assert.isFalse(parse(params, c.params).ok, c.label);
	});

	test('a required query field gets its missing case', () => {
		assert.deepEqual(generate_query_test_cases(object({ name: string })), [
			{ label: 'missing query: name', query: {} }
		]);
	});
});

describe('RPC output checks over fuz_schema', () => {
	const Output = object({ ok: literal(true) });

	test('assert_jsonrpc_success_response validates the result', () => {
		assert_jsonrpc_success_response({ jsonrpc: '2.0', id: 1, result: { ok: true } }, Output);
		assert.throws(
			() =>
				assert_jsonrpc_success_response({ jsonrpc: '2.0', id: 1, result: { ok: false } }, Output),
			/does not match output schema/
		);
	});

	test('expect_output returns the parsed output', () => {
		const value: { ok: true } = expect_output(
			{ status: 200, ok: true, result: { ok: true }, error: undefined },
			Output
		);
		assert.deepEqual(value, { ok: true });
		assert.throws(
			() => expect_output({ status: 200, ok: true, result: { ok: 1 }, error: undefined }, Output),
			/does not match output schema/
		);
	});
});
