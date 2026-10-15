import { assert, test, describe } from 'vitest';
import { z } from 'zod';

import {
	zod_unwrap_def,
	zod_get_base_type,
	zod_get_innermost_type,
	zod_get_schema_keys,
	zod_get_field_schema,
	zod_unwrap_to_object,
	zod_extract_fields,
	type ZodFieldInfo
} from '#lib/zod.ts';

/** The `zod_extract_fields` info for a single field, the window onto the module-internal predicates. */
const field_info = (schema: z.ZodType): ZodFieldInfo =>
	zod_extract_fields(z.strictObject({ f: schema }))[0]!;

// -- wrapper traversal --

describe('wrapper traversal', () => {
	const wrappers: Array<[string, (inner: z.ZodString) => z.ZodType]> = [
		['optional', (inner) => inner.optional()],
		['nullable', (inner) => inner.nullable()],
		['default', (inner) => inner.default('hi')],
		['prefault', (inner) => inner.prefault('hi')],
		['pipe', (inner) => inner.pipe(z.string())],
		['transform', (inner) => inner.transform((v) => v.length)]
	];

	for (const [label, wrap] of wrappers) {
		test(`unwraps ${label}`, () => {
			const inner = z.string();
			assert.equal(zod_get_innermost_type(wrap(inner)), inner);
		});
	}

	const terminal: Array<[string, z.ZodType]> = [
		['string', z.string()],
		['number', z.number()],
		['boolean', z.boolean()],
		['enum', z.enum(['a', 'b'])],
		['object', z.strictObject({ x: z.string() })],
		['array', z.array(z.string())]
	];

	for (const [label, schema] of terminal) {
		test(`stops at ${label}`, () => {
			assert.equal(zod_get_innermost_type(schema), schema);
		});
	}
});

// -- zod_unwrap_def --

describe('zod_unwrap_def', () => {
	test('returns def directly for base types', () => {
		assert.equal(zod_unwrap_def(z.string()).type, 'string');
		assert.equal(zod_unwrap_def(z.number()).type, 'number');
		assert.equal(zod_unwrap_def(z.boolean()).type, 'boolean');
	});

	test('unwraps single wrapper', () => {
		assert.equal(zod_unwrap_def(z.string().optional()).type, 'string');
		assert.equal(zod_unwrap_def(z.string().nullable()).type, 'string');
		assert.equal(zod_unwrap_def(z.number().default(0)).type, 'number');
	});

	test('unwraps multiple layers', () => {
		const schema = z.string().nullable().optional().default('x');
		assert.equal(zod_unwrap_def(schema).type, 'string');
	});

	test('unwraps pipe to input schema', () => {
		const schema = z.string().pipe(z.string());
		assert.equal(zod_unwrap_def(schema).type, 'string');
	});

	test('stops at non-wrapper types', () => {
		assert.equal(zod_unwrap_def(z.enum(['a', 'b'])).type, 'enum');
	});

	test('unwraps to object', () => {
		const schema = z.strictObject({ x: z.string() }).default({ x: 'hi' });
		assert.equal(zod_unwrap_def(schema).type, 'object');
	});
});

// -- zod_get_base_type --

describe('zod_get_base_type', () => {
	const cases: Array<[string, z.ZodType, string]> = [
		['plain string', z.string(), 'string'],
		['plain number', z.number(), 'number'],
		['plain boolean', z.boolean(), 'boolean'],
		['enum', z.enum(['x']), 'enum'],
		['array', z.array(z.number()), 'array'],
		['object', z.strictObject({ a: z.string() }), 'object'],
		['optional string', z.string().optional(), 'string'],
		['nullable number', z.number().nullable(), 'number'],
		['default boolean', z.boolean().default(true), 'boolean'],
		['optional nullable default', z.string().nullable().default('x').optional(), 'string']
	];

	for (const [label, schema, expected] of cases) {
		test(label, () => {
			assert.equal(zod_get_base_type(schema), expected);
		});
	}
});

// -- zod_get_innermost_type --

describe('zod_get_innermost_type', () => {
	test('returns base type unchanged', () => {
		const schema = z.string();
		assert.equal(zod_get_innermost_type(schema), schema);
	});

	test('unwraps optional', () => {
		const inner = z.string();
		assert.equal(zod_get_innermost_type(inner.optional()), inner);
	});

	test('unwraps nullable', () => {
		const inner = z.number();
		assert.equal(zod_get_innermost_type(inner.nullable()), inner);
	});

	test('unwraps default', () => {
		const inner = z.boolean();
		assert.equal(zod_get_innermost_type(inner.default(false)), inner);
	});

	test('unwraps pipe to input schema', () => {
		const input = z.string();
		assert.equal(zod_get_innermost_type(input.pipe(z.string())), input);
	});

	test('unwraps multiple wrappers', () => {
		const inner = z.string();
		const wrapped = inner.nullable().default('x').optional();
		assert.equal(zod_get_innermost_type(wrapped), inner);
	});

	test('returns ZodObject for wrapped object', () => {
		const obj = z.strictObject({ a: z.string() });
		const result = zod_get_innermost_type(obj.optional().default({ a: 'hi' }));
		assert.equal(result.def.type, 'object');
		assert.ok('a' in (result as z.ZodObject).shape);
	});

	test('returns ZodArray for array', () => {
		const arr = z.array(z.number());
		assert.equal(zod_get_innermost_type(arr), arr);
	});
});

// -- zod_get_schema_keys --

describe('zod_get_schema_keys', () => {
	test('returns keys for plain object', () => {
		const schema = z.strictObject({ a: z.string(), b: z.number(), c: z.boolean() });
		assert.deepEqual(zod_get_schema_keys(schema), ['a', 'b', 'c']);
	});

	test('returns keys through wrappers', () => {
		const schema = z
			.strictObject({ x: z.string(), y: z.number() })
			.default({ x: 'hi', y: 1 })
			.optional();
		assert.deepEqual(zod_get_schema_keys(schema), ['x', 'y']);
	});

	test('empty object returns empty array', () => {
		assert.deepEqual(zod_get_schema_keys(z.strictObject({})), []);
	});

	test('non-object schema returns empty array', () => {
		assert.deepEqual(zod_get_schema_keys(z.string()), []);
		assert.deepEqual(zod_get_schema_keys(z.array(z.string())), []);
		assert.deepEqual(zod_get_schema_keys(z.enum(['a'])), []);
	});
});

// -- zod_get_field_schema --

describe('zod_get_field_schema', () => {
	test('returns field schema when present', () => {
		const inner = z.string();
		const schema = z.strictObject({ name: inner });
		assert.equal(zod_get_field_schema(schema, 'name'), inner);
	});

	test('throws for missing key', () => {
		const schema = z.strictObject({ name: z.string() });
		assert.throws(() => zod_get_field_schema(schema, 'absent'), /Field "absent" not found/);
	});

	test('throws for non-object schema', () => {
		assert.throws(() => zod_get_field_schema(z.string(), 'x'), /Field "x" not found/);
	});

	test('unwraps wrappers around object', () => {
		const inner = z.boolean();
		const schema = z.strictObject({ on: inner }).optional();
		assert.equal(zod_get_field_schema(schema, 'on'), inner);
	});
});

// -- zod_unwrap_to_object --

describe('zod_unwrap_to_object', () => {
	test('returns object schema directly', () => {
		const schema = z.strictObject({ x: z.string() });
		const result = zod_unwrap_to_object(schema);
		assert.ok(result);
		assert.ok('x' in result.shape);
	});

	test('unwraps optional around object', () => {
		const result = zod_unwrap_to_object(z.strictObject({ x: z.string() }).optional());
		assert.ok(result);
		assert.ok('x' in result.shape);
	});

	test('unwraps default around object', () => {
		const result = zod_unwrap_to_object(z.strictObject({ x: z.string() }).default({ x: 'hi' }));
		assert.ok(result);
		assert.ok('x' in result.shape);
	});

	test('unwraps nullable around object', () => {
		const result = zod_unwrap_to_object(z.strictObject({ x: z.number() }).nullable());
		assert.ok(result);
		assert.ok('x' in result.shape);
	});

	test('unwraps multiple layers around object', () => {
		const result = zod_unwrap_to_object(
			z.strictObject({ a: z.boolean() }).default({ a: true }).optional()
		);
		assert.ok(result);
		assert.ok('a' in result.shape);
	});

	const non_objects: Array<[string, z.ZodType]> = [
		['string', z.string()],
		['number', z.number()],
		['array', z.array(z.string())],
		['optional string', z.string().optional()],
		['enum', z.enum(['a'])]
	];

	for (const [label, schema] of non_objects) {
		test(`returns null for ${label}`, () => {
			assert.equal(zod_unwrap_to_object(schema), null);
		});
	}

	test('works with z.object (loose)', () => {
		const result = zod_unwrap_to_object(z.object({ y: z.number() }));
		assert.ok(result);
		assert.ok('y' in result.shape);
	});

	test('works with empty object', () => {
		const result = zod_unwrap_to_object(z.strictObject({}));
		assert.ok(result);
		assert.equal(Object.keys(result.shape).length, 0);
	});
});

// -- required (not optional at the outermost level) --

describe('zod_extract_fields required', () => {
	test('false for optional schema', () => {
		assert.ok(!field_info(z.string().optional()).required);
	});

	test('true for required schema', () => {
		assert.ok(field_info(z.string()).required);
	});

	test('true for nullable (not optional)', () => {
		assert.ok(field_info(z.string().nullable()).required);
	});

	test('true for default (not optional)', () => {
		assert.ok(field_info(z.string().default('x')).required);
	});

	test('checks outermost only — inner optional not detected', () => {
		assert.ok(field_info(z.string().optional().nullable()).required);
	});

	test('checks outermost only — outer optional detected', () => {
		assert.ok(!field_info(z.string().nullable().optional()).required);
	});
});

// -- nullable --

describe('zod_extract_fields nullable', () => {
	test('true for nullable schema', () => {
		assert.ok(field_info(z.string().nullable()).nullable);
	});

	test('false for non-nullable schema', () => {
		assert.ok(!field_info(z.string()).nullable);
	});

	test('false for optional-only schema', () => {
		assert.ok(!field_info(z.string().optional()).nullable);
	});

	test('finds nullable through optional wrapper', () => {
		assert.ok(field_info(z.string().nullable().optional()).nullable);
	});

	test('finds nullable through default wrapper', () => {
		assert.ok(field_info(z.string().nullable().default('x')).nullable);
	});

	test('finds nullable through multiple wrappers', () => {
		assert.ok(field_info(z.string().nullable().default('x').optional()).nullable);
	});

	test('false when no nullable at any level', () => {
		assert.ok(!field_info(z.string().default('x').optional()).nullable);
	});
});

// -- has_default --

describe('zod_extract_fields has_default', () => {
	test('true for schema with default', () => {
		assert.ok(field_info(z.string().default('x')).has_default);
	});

	test('false for schema without default', () => {
		assert.ok(!field_info(z.string()).has_default);
	});

	test('finds default through optional wrapper', () => {
		assert.ok(field_info(z.string().default('x').optional()).has_default);
	});

	test('finds default through nullable wrapper', () => {
		assert.ok(field_info(z.number().default(0).nullable()).has_default);
	});

	test('false for optional without default', () => {
		assert.ok(!field_info(z.string().optional()).has_default);
	});

	test('false for nullable without default', () => {
		assert.ok(!field_info(z.string().nullable()).has_default);
	});

	test('detects default of false', () => {
		assert.ok(field_info(z.boolean().default(false)).has_default);
	});

	test('true for prefault', () => {
		assert.ok(field_info(z.string().prefault('x')).has_default);
	});
});

// -- zod_extract_fields --

describe('zod_extract_fields', () => {
	test('extracts basic field info', () => {
		const schema = z.strictObject({
			name: z.string(),
			age: z.number().optional(),
			active: z.boolean().default(true)
		});
		const fields = zod_extract_fields(schema);
		assert.equal(fields.length, 3);

		const name_field = fields.find((f) => f.name === 'name')!;
		assert.equal(name_field.base_type, 'string');
		assert.ok(name_field.required);
		assert.ok(!name_field.has_default);
		assert.ok(!name_field.nullable);

		const age_field = fields.find((f) => f.name === 'age')!;
		assert.equal(age_field.base_type, 'number');
		assert.ok(!age_field.required);
		assert.ok(!age_field.has_default);
		assert.ok(!age_field.nullable);

		const active_field = fields.find((f) => f.name === 'active')!;
		assert.equal(active_field.base_type, 'boolean');
		assert.ok(active_field.required);
		assert.ok(active_field.has_default);
		assert.ok(!active_field.nullable);
	});

	test('detects nullable fields', () => {
		const schema = z.strictObject({
			value: z.string().nullable(),
			wrapped: z.number().nullable().optional()
		});
		const fields = zod_extract_fields(schema);
		assert.ok(fields.find((f) => f.name === 'value')!.nullable);
		assert.ok(fields.find((f) => f.name === 'wrapped')!.nullable);
	});

	test('empty object returns empty array', () => {
		assert.equal(zod_extract_fields(z.strictObject({})).length, 0);
	});

	test('handles enum fields', () => {
		const schema = z.strictObject({ status: z.enum(['active', 'inactive']) });
		const fields = zod_extract_fields(schema);
		assert.equal(fields[0]!.base_type, 'enum');
		assert.ok(fields[0]!.required);
	});

	test('handles deeply wrapped fields', () => {
		const schema = z.strictObject({
			deep: z.string().nullable().default('x').optional()
		});
		const fields = zod_extract_fields(schema);
		const f = fields[0]!;
		assert.equal(f.base_type, 'string');
		assert.ok(!f.required);
		assert.ok(f.has_default);
		assert.ok(f.nullable);
	});
});
