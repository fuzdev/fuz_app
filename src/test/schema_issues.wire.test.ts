/**
 * Tests for `to_wire_issues` and `WireIssue` in `schema_issues.ts` — either
 * library's issues as the one shape an error response carries.
 *
 * The Zod table pins one row per Zod issue code the mapping knows (and each
 * origin, format and type it reads), each with the input it fails; the parity
 * table checks that a Zod schema and its fuz_schema twin give the same
 * `kind`, `path`, `expected` and `received` for the same input.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import * as s from '@fuzdev/fuz_schema/schema.ts';

import { parse_any, to_wire_issues, WireIssue, type ValidationSchema } from '#lib/schema_issues.ts';

const wire_of = (schema: ValidationSchema, input: unknown): Array<WireIssue> => {
	const result = parse_any(schema, input);
	assert.ok(!result.ok, `refused: ${String(input)}`);
	return to_wire_issues(result.issues, input);
};

/** A wire issue without its `message`, the part both libraries agree on. */
type WireIssueFields = Omit<WireIssue, 'message'>;

const fields_of = (issues: Array<WireIssue>): Array<WireIssueFields> =>
	issues.map(({ message: _, ...fields }) => fields);

interface ZodRow {
	label: string;
	schema: z.ZodType;
	input: unknown;
	expected: Array<WireIssueFields>;
}

const issue = (
	kind: string,
	path: Array<string | number>,
	expected: string,
	received: string
): WireIssueFields => ({ kind, path, expected, received });

const ZOD_ROWS: Array<ZodRow> = [
	// invalid_type
	{
		label: 'invalid_type string',
		schema: z.string(),
		input: 1,
		expected: [issue('string', [], 'string', 'number')]
	},
	{
		label: 'invalid_type at a missing key is the type, received undefined',
		schema: z.strictObject({ a: z.string() }),
		input: {},
		expected: [issue('string', ['a'], 'string', 'undefined')]
	},
	{
		label: 'invalid_type number received NaN',
		schema: z.number(),
		input: NaN,
		expected: [issue('number', [], 'number', 'NaN')]
	},
	{
		label: 'invalid_type number received Infinity',
		schema: z.number(),
		input: -Infinity,
		expected: [issue('number', [], 'number', '-Infinity')]
	},
	{
		label: 'invalid_type boolean',
		schema: z.boolean(),
		input: 'x',
		expected: [issue('boolean', [], 'boolean', 'string')]
	},
	{
		label: 'invalid_type bigint',
		schema: z.bigint(),
		input: 1,
		expected: [issue('bigint', [], 'bigint', 'number')]
	},
	{
		label: 'invalid_type int is integer',
		schema: z.int(),
		input: 1.5,
		expected: [issue('integer', [], 'integer', 'number')]
	},
	{
		label: 'invalid_type object received null',
		schema: z.strictObject({}),
		input: null,
		expected: [issue('object', [], 'object', 'null')]
	},
	{
		label: 'invalid_type object received array',
		schema: z.strictObject({}),
		input: [],
		expected: [issue('object', [], 'object', 'array')]
	},
	{
		label: 'invalid_type record',
		schema: z.record(z.string(), z.number()),
		input: 'x',
		expected: [issue('record', [], 'object', 'string')]
	},
	{
		label: 'invalid_type array',
		schema: z.array(z.number()),
		input: {},
		expected: [issue('array', [], 'array', 'object')]
	},
	{
		label: 'invalid_type tuple is array',
		schema: z.tuple([z.string()]),
		input: 1,
		expected: [issue('array', [], 'array', 'number')]
	},
	{
		label: 'invalid_type null is a literal',
		schema: z.null(),
		input: 1,
		expected: [issue('literal', [], 'null', 'number')]
	},
	{
		label: 'invalid_type undefined is a literal',
		schema: z.undefined(),
		input: 1,
		expected: [issue('literal', [], 'undefined', 'number')]
	},
	{
		label: 'invalid_type void is a literal of undefined',
		schema: z.void(),
		input: 1,
		expected: [issue('literal', [], 'undefined', 'number')]
	},
	{
		label: 'invalid_type nan is a literal',
		schema: z.nan(),
		input: 1,
		expected: [issue('literal', [], 'NaN', 'number')]
	},
	{
		label: 'invalid_type nonoptional is missing_key',
		schema: z.strictObject({ a: z.string().optional().nonoptional() }),
		input: {},
		expected: [issue('missing_key', ['a'], 'a required key', 'undefined')]
	},
	{
		label: 'invalid_type with no fuz_schema kind is a check',
		schema: z.date(),
		input: 1,
		expected: [issue('check', [], 'date', 'number')]
	},
	{
		label: 'invalid_type never is a check',
		schema: z.never(),
		input: 1,
		expected: [issue('check', [], 'never', 'number')]
	},
	// too_small / too_big
	{
		label: 'too_small string is min_length',
		schema: z.string().min(3),
		input: 'a',
		expected: [issue('min_length', [], 'length >= 3', 'string')]
	},
	{
		label: 'too_small exact length is min_length',
		schema: z.string().length(3),
		input: 'a',
		expected: [issue('min_length', [], 'length >= 3', 'string')]
	},
	{
		label: 'too_big array is max_length',
		schema: z.array(z.number()).max(1),
		input: [1, 2],
		expected: [issue('max_length', [], 'length <= 1', 'array')]
	},
	{
		label: 'too_small number is min_value',
		schema: z.number().min(3),
		input: 1,
		expected: [issue('min_value', [], '>= 3', 'number')]
	},
	{
		label: 'too_small exclusive number writes >',
		schema: z.number().gt(3),
		input: 3,
		expected: [issue('min_value', [], '> 3', 'number')]
	},
	{
		label: 'too_big exclusive number writes <',
		schema: z.number().lt(3),
		input: 3,
		expected: [issue('max_value', [], '< 3', 'number')]
	},
	{
		label: 'too_big int is max_value',
		schema: z.int(),
		input: 2 ** 60,
		expected: [issue('max_value', [], `<= ${Number.MAX_SAFE_INTEGER}`, 'number')]
	},
	{
		label: 'too_small bigint is min_value',
		schema: z.bigint().min(3n),
		input: 1n,
		expected: [issue('min_value', [], '>= 3', 'bigint')]
	},
	// invalid_format
	{
		label: 'invalid_format uuid',
		schema: z.uuid(),
		input: 'x',
		expected: [issue('uuid', [], 'uuid', 'string')]
	},
	{
		label: 'invalid_format guid is uuid',
		schema: z.guid(),
		input: 'x',
		expected: [issue('uuid', [], 'uuid', 'string')]
	},
	{
		label: 'invalid_format datetime is iso_datetime',
		schema: z.iso.datetime(),
		input: 'x',
		expected: [issue('iso_datetime', [], 'iso_datetime', 'string')]
	},
	{
		label: 'invalid_format regex expects the pattern',
		schema: z.string().regex(/^a+$/),
		input: 'b',
		expected: [issue('regex', [], '/^a+$/', 'string')]
	},
	{
		label: 'invalid_format with no fuz_schema kind is a check',
		schema: z.email(),
		input: 'b',
		expected: [issue('check', [], 'email', 'string')]
	},
	{
		label: 'invalid_format starts_with is a check',
		schema: z.string().startsWith('ab'),
		input: 'b',
		expected: [issue('check', [], 'starts_with', 'string')]
	},
	// unrecognized_keys
	{
		label: 'unrecognized_keys splits per key, each key on its path',
		schema: z.strictObject({ a: z.string() }),
		input: { a: 'x', b: 1, c: null },
		expected: [
			issue('unknown_key', ['b'], 'no unknown keys', 'number'),
			issue('unknown_key', ['c'], 'no unknown keys', 'null')
		]
	},
	{
		label: 'unrecognized_keys on a nested object',
		schema: z.strictObject({ inner: z.strictObject({}) }),
		input: { inner: { x: [] } },
		expected: [issue('unknown_key', ['inner', 'x'], 'no unknown keys', 'array')]
	},
	// invalid_union
	{
		label: 'invalid_union names each option',
		schema: z.union([z.string(), z.number(), z.strictObject({ a: z.string() })]),
		input: { a: 1 },
		expected: [issue('union', [], 'string | number | object', 'object')]
	},
	{
		label: 'invalid_union names a literal option by its value',
		schema: z.union([z.literal('a'), z.null(), z.string()]),
		input: 1,
		expected: [issue('union', [], '"a" | null | string', 'number')]
	},
	{
		label: 'invalid_union names a refined option by its type, once',
		schema: z.union([z.string().min(3), z.string().max(1)]),
		input: 'ab',
		expected: [issue('union', [], 'string', 'string')]
	},
	{
		label: 'invalid_union nested in an object',
		schema: z.strictObject({ u: z.union([z.string(), z.strictObject({ a: z.string() })]) }),
		input: { u: { a: 1 } },
		expected: [issue('union', ['u'], 'string | object', 'object')]
	},
	{
		label: 'invalid_union with a discriminator is a variant',
		schema: z.discriminatedUnion('t', [
			z.strictObject({ t: z.literal('a') }),
			z.strictObject({ t: z.literal('b') })
		]),
		input: { t: 'c' },
		expected: [issue('variant', ['t'], '"a" | "b"', 'string')]
	},
	{
		label: 'invalid_union of more than one match',
		schema: z.xor([z.string(), z.string()]),
		input: 'a',
		expected: [issue('union', [], 'exactly one option', 'string')]
	},
	// invalid_value
	{
		label: 'invalid_value of one value is a literal',
		schema: z.literal('a'),
		input: 'c',
		expected: [issue('literal', [], '"a"', 'string')]
	},
	{
		label: 'invalid_value of several is a one_of',
		schema: z.enum(['a', 'b']),
		input: 1,
		expected: [issue('one_of', [], '"a" | "b"', 'number')]
	},
	// the rest
	{
		label: 'custom is a check',
		schema: z.string().refine(() => false),
		input: 'b',
		expected: [issue('check', [], 'check', 'string')]
	},
	{
		label: 'custom at its own path',
		schema: z
			.strictObject({ a: z.string(), b: z.string() })
			.refine(() => false, { path: ['b'], message: 'nope' }),
		input: { a: 'x', b: 'y' },
		expected: [issue('check', ['b'], 'check', 'string')]
	},
	{
		label: 'not_multiple_of is a check',
		schema: z.number().multipleOf(3),
		input: 4,
		expected: [issue('check', [], 'multiple of 3', 'number')]
	},
	{
		label: 'invalid_key is a check',
		schema: z.record(z.string().min(2), z.number()),
		input: { a: 1 },
		expected: [issue('check', ['a'], 'a valid key', 'number')]
	},
	// paths
	{
		label: 'a nested path through arrays, received read at it',
		schema: z.strictObject({ a: z.strictObject({ b: z.array(z.number()) }) }),
		input: { a: { b: [1, 'x', NaN] } },
		expected: [
			issue('number', ['a', 'b', 1], 'number', 'string'),
			issue('number', ['a', 'b', 2], 'number', 'NaN')
		]
	}
];

describe('to_wire_issues of Zod issues', () => {
	for (const { label, schema, input, expected } of ZOD_ROWS) {
		test(label, () => {
			const wire = wire_of(schema, input);
			assert.deepStrictEqual(fields_of(wire), expected);
			for (const w of wire) assert.ok(WireIssue.safeParse(w).success, JSON.stringify(w));
		});
	}

	test('invalid_element is a check', () => {
		// Zod reports a map's or set's bad element by the element's own issue, so this is built
		const element_issue: z.core.$ZodIssue = {
			code: 'invalid_element',
			origin: 'map',
			key: 'a',
			issues: [],
			path: ['m'],
			message: 'Invalid element'
		};
		assert.deepStrictEqual(to_wire_issues([element_issue], { m: 1 }), [
			{
				kind: 'check',
				path: ['m'],
				expected: 'a valid element',
				received: 'number',
				message: 'Invalid element'
			}
		]);
	});

	test("keeps Zod's own message", () => {
		const result = z.strictObject({ a: z.string() }).safeParse({ a: 1 });
		assert.ok(!result.success);
		const [wire] = to_wire_issues(result.error.issues, { a: 1 });
		assert.strictEqual(wire!.message, result.error.issues[0]!.message);
		assert.strictEqual(wire!.message, 'Invalid input: expected string, received number');
	});

	test("an unrecognized key keeps Zod's text, and one of several gets the one-key form", () => {
		const schema = z.strictObject({});
		assert.deepStrictEqual(
			wire_of(schema, { b: 1 }).map((w) => w.message),
			['Unrecognized key: "b"']
		);
		assert.deepStrictEqual(
			wire_of(schema, { b: 1, c: 2 }).map((w) => w.message),
			['Unrecognized key: "b"', 'Unrecognized key: "c"']
		);
	});

	test('the wire fields come in the canonical order', () => {
		const [wire] = wire_of(z.string(), 1);
		assert.deepStrictEqual(Object.keys(wire!), ['kind', 'path', 'expected', 'received', 'message']);
	});

	test('WireIssue admits a field a newer server adds', () => {
		const [wire] = wire_of(z.string(), 1);
		assert.ok(WireIssue.safeParse({ ...wire!, added: true }).success);
	});

	test('serializes a bigint bound, which a raw Zod issue cannot', () => {
		const result = z.bigint().min(3n).safeParse(1n);
		assert.ok(!result.success);
		assert.throws(() => JSON.stringify(result.error.issues));
		assert.doesNotThrow(() => JSON.stringify(to_wire_issues(result.error.issues, 1n)));
	});
});

describe('to_wire_issues of fuz_schema issues', () => {
	test('passes the fields through, with format_issue as the message', () => {
		const schema = s.object({ a: s.object({ b: s.array(s.number) }) });
		const input = { a: { b: [1, 'x'] }, z: null };
		const result = s.parse(schema, input);
		assert.ok(!result.ok);
		const wire = to_wire_issues(result.issues, input);
		assert.deepStrictEqual(wire, [
			{
				kind: 'number',
				path: ['a', 'b', 1],
				expected: 'number',
				received: 'string',
				message: 'a.b.1: expected number, received string'
			},
			{
				kind: 'unknown_key',
				path: ['z'],
				expected: 'no unknown keys',
				received: 'null',
				message: 'z: expected no unknown keys, received null'
			}
		]);
		for (const [i, w] of wire.entries()) {
			assert.strictEqual(w.message, s.format_issue(result.issues[i]!));
			assert.ok(WireIssue.safeParse(w).success);
		}
	});

	test('a message set by `message` is the text', () => {
		const schema = s.object({ a: s.message(s.string, 'need text') });
		const wire = wire_of(schema, { a: 1 });
		assert.strictEqual(wire.length, 1);
		assert.strictEqual(wire[0]!.message, s.format_issue({ ...wire[0]!, message: 'need text' }));
		assert.strictEqual(wire[0]!.message, 'a: need text');
	});
});

interface ParityRow {
	label: string;
	zod: z.ZodType;
	fuz: s.AnySchema;
	inputs: Array<unknown>;
}

const PARITY_ROWS: Array<ParityRow> = [
	{
		label: 'object fields, missing, wrong and unknown',
		zod: z.strictObject({ a: z.string(), n: z.number() }),
		fuz: s.object({ a: s.string, n: s.number }),
		inputs: [{}, { a: 1, n: NaN }, { a: 'x', n: 1, b: [], c: null }, null, [1], 'x']
	},
	{
		label: 'nested arrays',
		zod: z.strictObject({ a: z.strictObject({ b: z.array(z.number()) }) }),
		fuz: s.object({ a: s.object({ b: s.array(s.number) }) }),
		inputs: [{ a: { b: [1, 'x', Infinity] } }, { a: { b: {} } }]
	},
	{
		label: 'string bounds',
		zod: z.string().min(2).max(3),
		fuz: s.pipe(s.string, s.min_length(2), s.max_length(3)),
		inputs: ['a', 'abcd']
	},
	{
		label: 'number bounds',
		zod: z.number().min(2).max(3),
		fuz: s.pipe(s.number, s.min_value(2), s.max_value(3)),
		inputs: [1, 4]
	},
	{
		label: 'array bounds',
		zod: z.array(z.number()).max(1),
		fuz: s.pipe(s.array(s.number), s.max_length(1)),
		inputs: [[1, 2]]
	},
	{
		label: 'uuid and iso_datetime',
		zod: z.strictObject({ id: z.uuid(), at: z.iso.datetime() }),
		fuz: s.object({ id: s.pipe(s.string, s.uuid), at: s.pipe(s.string, s.iso_datetime) }),
		inputs: [{ id: 'x', at: 'y' }]
	},
	{
		label: 'regex',
		zod: z.string().regex(/^a+$/),
		fuz: s.pipe(s.string, s.regex(/^a+$/)),
		inputs: ['b']
	},
	{
		label: 'literals and one_of',
		zod: z.strictObject({ l: z.literal('a'), o: z.enum(['a', 'b']), n: z.null() }),
		fuz: s.object({ l: s.literal('a'), o: s.one_of(['a', 'b']), n: s.literal(null) }),
		inputs: [{ l: 'b', o: 'c', n: 1 }]
	},
	{
		label: 'union',
		zod: z.union([z.string(), z.number(), z.strictObject({ a: z.string() })]),
		fuz: s.union([s.string, s.number, s.object({ a: s.string })]),
		inputs: [{ a: 1 }, null, true]
	},
	{
		label: 'variant',
		zod: z.discriminatedUnion('t', [
			z.strictObject({ t: z.literal('a') }),
			z.strictObject({ t: z.literal('b') })
		]),
		fuz: s.variant('t', [s.object({ t: s.literal('a') }), s.object({ t: s.literal('b') })]),
		inputs: [{ t: 'c' }]
	},
	{
		label: 'record',
		zod: z.record(z.string(), z.number()),
		fuz: s.record(s.number),
		inputs: ['x', { a: 'x' }]
	}
];

describe('to_wire_issues parity', () => {
	for (const { label, zod, fuz, inputs } of PARITY_ROWS) {
		test(`${label}: Zod maps to what fuz_schema reports`, () => {
			for (const input of inputs) {
				assert.deepStrictEqual(
					fields_of(wire_of(zod, input)),
					fields_of(wire_of(fuz, input)),
					JSON.stringify(input)
				);
			}
		});
	}
});
