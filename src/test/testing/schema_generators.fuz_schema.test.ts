/**
 * The testing generators over `@fuzdev/fuz_schema` schemas: valid bodies,
 * paths and string params a fuz_schema schema accepts, adversarial cases a
 * fuz_schema input refuses, the RPC output checks, and the throw on an input
 * no body can be generated for or a value that is no schema.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
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
	safe_integer,
	string,
	transform,
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
	});

	test('a record field generates an empty record', () => {
		const input = object({ tags: record(string), n: number });
		const body = generate_valid_body(input);
		assert.deepEqual(body, { tags: {}, n: 1 });
		assert.ok(parse(input, body).ok);
	});

	test('a void field generates undefined', () => {
		const input = object({ v: fuz_void, n: number });
		const body = generate_valid_body(input);
		assert.deepEqual(body, { v: undefined, n: 1 });
		assert.ok(parse(input, body).ok);
	});

	test('an input that is no object schema throws', () => {
		for (const schema of [string, union([object({ a: string }), object({ b: string })])]) {
			assert.throws(
				() => generate_valid_body(schema),
				/generate_valid_body: the input is no object, void or null schema/
			);
		}
	});

	test('an unrecognized schema throws', () => {
		for (const schema of [{}, { safeParse: () => ({ success: true }) }]) {
			assert.throws(
				() => generate_valid_body(schema as unknown as AnySchema),
				/generate_valid_body: the input is .*a @fuzdev\/fuz_schema schema$/
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
	test('reads each field by its fuz_schema kind', () => {
		const { fields } = to_object_schema_view(Input, 'Input');
		const by_name = Object.fromEntries(fields.map((f) => [f.name, f]));
		assert.strictEqual(by_name.name!.base_type, 'string');
		assert.strictEqual(by_name.count!.base_type, 'number');
		assert.strictEqual(by_name.nested!.base_type, 'object');
		assert.strictEqual(by_name.mode!.base_type, 'one_of');
		assert.strictEqual(by_name.shape!.base_type, 'variant');
		assert.strictEqual(by_name.kind!.base_type, 'literal');
		assert.isTrue(by_name.maybe!.nullable);
		assert.isFalse(by_name.note!.required);
		assert.isTrue(by_name.limit!.has_default);
		assert.isTrue(by_name.name!.required);
	});

	test('a literal(null) field reads as null', () => {
		const [field] = to_object_schema_view(object({ n: literal(null) }), 'n').fields;
		assert.strictEqual(field!.base_type, 'null');
	});

	test('a literal(undefined) field reads as void', () => {
		const [field] = to_object_schema_view(object({ v: fuz_void }), 'v').fields;
		assert.strictEqual(field!.base_type, 'void');
	});

	test('reads required, optional and nullable fields', () => {
		const { fields } = to_object_schema_view(
			object({ a: string, b: optional(number), c: nullable(boolean) }),
			'fuz'
		);
		assert.deepEqual(
			fields.map((f) => ({
				name: f.name,
				base_type: f.base_type,
				required: f.required,
				has_default: f.has_default,
				nullable: f.nullable
			})),
			[
				{ name: 'a', base_type: 'string', required: true, has_default: false, nullable: false },
				{ name: 'b', base_type: 'number', required: false, has_default: false, nullable: false },
				{ name: 'c', base_type: 'boolean', required: true, has_default: false, nullable: true }
			]
		);
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
			assert.ok(value !== null && parse(field_schema, value).ok, field.name);
		}
	});

	test('a URL integer bounded past its transform takes a value in range', () => {
		// `db_routes`' `query_int` shape: the bounds sit after the transform,
		// where JSON Schema can't say them, and exclude the small candidates
		const query_int = (min: number, max: number) =>
			pipe(
				pipe(string, regex(/^[+-]?\d+$/), transform(Number)),
				safe_integer,
				min_value(min),
				max_value(max)
			);
		const query = object({
			defaulted: with_default(query_int(5, 100), 5),
			bare: query_int(7, 1000)
		});
		const view = to_object_schema_view(query, 'q');
		const values: Record<string, string> = {};
		for (const field of view.fields) {
			const field_schema = view.field_schema(field.name)!;
			const value = generate_valid_string_param(field, field_schema);
			assert.ok(value !== null && parse(field_schema, value).ok, `${field.name}: ${value}`);
			values[field.name] = value;
		}
		assert.deepStrictEqual(values, { defaulted: '5', bare: '7' });
		// the query case generators build their base from it
		assert.ok(generate_query_test_cases(query).length > 0);
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
		assert.throws(
			() => generate_input_test_cases(array(string), { label: 'thing_list' }),
			/the input for 'thing_list' is no object, void or null schema/
		);
		assert.throws(
			() => generate_input_test_cases({} as unknown as AnySchema),
			/is .*a @fuzdev\/fuz_schema schema$/
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
