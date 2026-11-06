/**
 * Tests for schema_helpers - shared pure helpers for schema introspection.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import {
	array,
	bigint,
	boolean,
	check,
	lazy,
	literal,
	loose_object,
	message,
	min_length,
	nullable,
	number,
	object,
	object_with_rest,
	optional,
	pipe,
	record,
	string,
	strip_object,
	transform,
	union,
	variant,
	void as fuz_void,
	with_default,
	type AnySchema
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import {
	is_null_schema,
	is_strict_object_schema,
	is_void_schema,
	to_void_params,
	to_input_params,
	json_has_own_proto_key,
	safe_parse_dropping_unknown_keys,
	UNKNOWN_KEY_PASSES_MAX,
	schema_to_surface,
	middleware_applies
} from '#lib/http/schema_helpers.ts';

describe('is_null_schema', () => {
	test('returns true for z.null()', () => {
		assert.strictEqual(is_null_schema(z.null()), true);
	});

	test('returns false for z.string()', () => {
		assert.strictEqual(is_null_schema(z.string()), false);
	});

	test('returns false for z.strictObject()', () => {
		assert.strictEqual(is_null_schema(z.strictObject({ name: z.string() })), false);
	});

	test('returns false for z.nullable(z.string()) — accepts null but is not z.null()', () => {
		assert.strictEqual(is_null_schema(z.nullable(z.string())), false);
	});

	test('returns false for z.void()', () => {
		assert.strictEqual(is_null_schema(z.void()), false);
	});

	test('returns true for a fuz_schema literal(null)', () => {
		assert.strictEqual(is_null_schema(literal(null)), true);
	});

	test('returns false for a fuz_schema nullable and other literals', () => {
		assert.strictEqual(is_null_schema(nullable(string)), false);
		assert.strictEqual(is_null_schema(literal('null')), false);
		assert.strictEqual(is_null_schema(literal(undefined)), false);
	});
});

describe('is_void_schema', () => {
	test('returns true for z.void()', () => {
		assert.strictEqual(is_void_schema(z.void()), true);
	});

	test('returns false for z.null()', () => {
		assert.strictEqual(is_void_schema(z.null()), false);
	});

	test('returns false for z.undefined()', () => {
		assert.strictEqual(is_void_schema(z.undefined()), false);
	});

	test('returns false for z.string()', () => {
		assert.strictEqual(is_void_schema(z.string()), false);
	});

	test('returns false for z.strictObject()', () => {
		assert.strictEqual(is_void_schema(z.strictObject({ name: z.string() })), false);
	});

	// fuz_schema's void is `literal(undefined)`, detected by shape (kind + def),
	// so a `meta` copy (a new `{kind, def, run}` object) still reads void
	const cases: Array<[label: string, schema: z.ZodType | AnySchema, expected: boolean]> = [
		['z.void()', z.void(), true],
		['s.void', fuz_void, true],
		['literal(undefined)', literal(undefined), true],
		['meta(s.void, …)', meta(fuz_void, { description: 'no params' }), true],
		['z.undefined()', z.undefined(), false],
		['z.null()', z.null(), false],
		['literal(null)', literal(null), false],
		['literal("undefined")', literal('undefined'), false],
		['optional(string)', optional(string), false],
		['s.string', string, false],
		['object({})', object({}), false]
	];
	for (const [label, schema, expected] of cases) {
		test(`${label} → ${expected}`, () => {
			assert.strictEqual(is_void_schema(schema), expected);
		});
	}
});

describe('to_void_params', () => {
	test('reads absent, null, and {} as the no-arg call', () => {
		for (const params of [undefined, null, {}]) {
			assert.strictEqual(to_void_params(params), undefined, JSON.stringify(params));
		}
	});

	test('passes any other shape through for z.void() to refuse', () => {
		for (const params of [{ a: 1 }, [], [1], 0, '', false]) {
			assert.strictEqual(to_void_params(params), params, JSON.stringify(params));
		}
	});
});

describe('to_input_params', () => {
	test('applies to_void_params to a z.void() input', () => {
		for (const params of [undefined, null, {}]) {
			assert.strictEqual(to_input_params(z.void(), params), undefined, JSON.stringify(params));
		}
		const extra = { a: 1 };
		assert.strictEqual(to_input_params(z.void(), extra), extra);
	});

	test('applies to_void_params to a fuz_schema void input', () => {
		for (const input of [fuz_void, meta(fuz_void, { description: 'no params' })]) {
			for (const params of [undefined, null, {}]) {
				assert.strictEqual(to_input_params(input, params), undefined, JSON.stringify(params));
			}
			const extra = { a: 1 };
			assert.strictEqual(to_input_params(input, extra), extra);
		}
	});

	test('reads absent and null params of a fuz_schema object input as {}', () => {
		const input = object({ limit: optional(number) });
		assert.deepStrictEqual(to_input_params(input, undefined), {});
		assert.deepStrictEqual(to_input_params(input, null), {});
	});

	test('reads absent and null params of any other input as {}', () => {
		const input = z.strictObject({ limit: z.number().optional() });
		assert.deepStrictEqual(to_input_params(input, undefined), {});
		assert.deepStrictEqual(to_input_params(input, null), {});
		const params = { limit: 2 };
		assert.strictEqual(to_input_params(input, params), params);
	});
});

describe('json_has_own_proto_key', () => {
	const has = (json: string): boolean => json_has_own_proto_key(JSON.parse(json));

	test('finds an own key at the top level, nested in an object, and nested in an array', () => {
		assert.strictEqual(has('{"__proto__":{"x":1}}'), true);
		assert.strictEqual(has('{"__proto__":null}'), true);
		assert.strictEqual(has('{"a":1,"b":{"c":{"__proto__":{}}}}'), true);
		assert.strictEqual(has('{"a":{"b":[1,{"__proto__":{}}]}}'), true);
		assert.strictEqual(has('[{"__proto__":1}]'), true);
	});

	test('reads an escaped spelling as the key it decodes to', () => {
		assert.strictEqual(has('{"\\u005f_proto__":1}'), true);
	});

	test('admits constructor, prototype, a __proto__ value, and a near-miss key', () => {
		assert.strictEqual(has('{"constructor":{"prototype":{"x":1}}}'), false);
		assert.strictEqual(has('{"prototype":{}}'), false);
		assert.strictEqual(has('{"a":"__proto__","b":["__proto__"]}'), false);
		assert.strictEqual(has('{"__proto":1,"_proto__":1,"__PROTO__":1}'), false);
		assert.strictEqual(has('{}'), false);
		assert.strictEqual(has('[]'), false);
	});

	test('reads scalars as holding no key', () => {
		for (const value of [null, undefined, 1, 'x', true]) {
			assert.strictEqual(json_has_own_proto_key(value), false);
		}
	});

	test('ignores an inherited __proto__ — an object literal sets the prototype', () => {
		assert.strictEqual(json_has_own_proto_key({ __proto__: { x: 1 } }), false);
	});

	test('walks nesting deeper than the call stack without throwing', () => {
		const depth = 400_000;
		const deep = '{"a":'.repeat(depth) + '{}' + '}'.repeat(depth);
		assert.strictEqual(has(deep), false);
		const deep_hit = '['.repeat(depth) + '{"__proto__":1}' + ']'.repeat(depth);
		assert.strictEqual(has(deep_hit), true);
	});
});

describe('safe_parse_dropping_unknown_keys', () => {
	const schema = z.strictObject({
		a: z.number(),
		nested: z.strictObject({ b: z.string() }).optional(),
		list: z.array(z.strictObject({ c: z.boolean() })).optional()
	});

	test('passes a matching value through', () => {
		const result = safe_parse_dropping_unknown_keys(schema, { a: 1 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1 });
	});

	test('drops undeclared keys at every depth without mutating the input', () => {
		const value = { a: 1, x: 0, nested: { b: 'b', y: 0 }, list: [{ c: true, z: 0 }] };
		const snapshot = structuredClone(value);
		const result = safe_parse_dropping_unknown_keys(schema, value);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, nested: { b: 'b' }, list: [{ c: true }] });
		assert.deepStrictEqual(value, snapshot);
	});

	test('still fails on any other issue, with the original issues', () => {
		const result = safe_parse_dropping_unknown_keys(schema, { a: 'nope', x: 0 });
		assert.ok(!result.ok);
		const codes = result.issues.map((issue) => ('code' in issue ? issue.code : issue.kind)).sort();
		assert.deepStrictEqual(codes, ['invalid_type', 'unrecognized_keys']);
	});

	test('drops an unknown key a Zod union of strict objects reports', () => {
		const either = z.union([z.strictObject({ a: z.number() }), z.strictObject({ b: z.number() })]);
		const result = safe_parse_dropping_unknown_keys(either, { a: 1, x: 1 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1 });
	});

	test('drops the keys either stage of a pipe refuses', () => {
		const piped = z
			.strictObject({ a: z.number(), b: z.number().optional() })
			.pipe(z.strictObject({ a: z.number() }));
		const result = safe_parse_dropping_unknown_keys(piped, { a: 1, b: 2, c: 3 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1 });
	});
});

describe('safe_parse_dropping_unknown_keys with fuz_schema', () => {
	const schema = object({
		a: number,
		nested: optional(object({ b: string })),
		list: optional(array(object({ c: boolean })))
	});

	test('passes a matching value through', () => {
		const result = safe_parse_dropping_unknown_keys(schema, { a: 1 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1 });
	});

	test('drops undeclared keys at every depth without mutating the input', () => {
		const value = { a: 1, x: 0, nested: { b: 'b', y: 0 }, list: [{ c: true, z: 0 }] };
		const snapshot = structuredClone(value);
		const result = safe_parse_dropping_unknown_keys(schema, value);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, nested: { b: 'b' }, list: [{ c: true }] });
		assert.deepStrictEqual(value, snapshot);
	});

	test('drops more unknown keys than one parse reports', () => {
		const value: Record<string, unknown> = { a: 1 };
		for (let i = 0; i < 250; i++) value[`k${i}`] = i;
		const result = safe_parse_dropping_unknown_keys(schema, value);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1 });
	});

	// counts parses: `a` is checked once per parse
	const create_counted = () => {
		const counter = { parses: 0 };
		const counted = object({
			a: pipe(
				number,
				check(() => ++counter.parses > 0)
			),
			nested: optional(object({ b: string })),
			list: optional(array(object({ c: boolean })))
		});
		return { counter, counted };
	};

	test('strips every unknown key of a strict object in one pass', () => {
		const { counter, counted } = create_counted();
		const value: Record<string, unknown> = { a: 1, nested: { b: 'b' } };
		const nested = value.nested as Record<string, unknown>;
		for (let i = 0; i < 2000; i++) {
			value[`k${i}`] = i;
			nested[`n${i}`] = i;
		}
		const result = safe_parse_dropping_unknown_keys(counted, value);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, nested: { b: 'b' } });
		// the first parse reports a hundred root keys, the schema-guided strip
		// takes every unknown key at every depth, the second parse succeeds
		assert.strictEqual(counter.parses, 2);
	});

	test('strips an unknown key on every array item in one pass', () => {
		const { counter, counted } = create_counted();
		const list = Array.from({ length: 1000 }, (_, i) => ({ c: true, [`x${i}`]: i }));
		const result = safe_parse_dropping_unknown_keys(counted, { a: 1, list });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, list: list.map(() => ({ c: true })) });
		assert.strictEqual(counter.parses, 2);
	});

	// counts parses of `schema` at `{a, value}`: `a` is checked once per parse
	const create_counted_at = (schema: AnySchema) => {
		const counter = { parses: 0 };
		const counted = object({
			a: pipe(
				number,
				check(() => ++counter.parses > 0)
			),
			value: schema
		});
		return { counter, counted };
	};

	test('strips an unknown key on every record value in one pass', () => {
		const { counter, counted } = create_counted_at(record(object({ c: boolean })));
		const value: Record<string, unknown> = {};
		const expected: Record<string, unknown> = {};
		for (let i = 0; i < 1000; i++) {
			value[`r${i}`] = { c: true, [`x${i}`]: i };
			expected[`r${i}`] = { c: true };
		}
		const result = safe_parse_dropping_unknown_keys(counted, { a: 1, value });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, value: expected });
		assert.strictEqual(counter.parses, 2);
	});

	test("strips an unknown key on every variant item's option in one pass", () => {
		const { counter, counted } = create_counted_at(
			array(
				variant('type', [
					object({ type: literal('a'), a: number }),
					object({ type: literal('b'), b: number })
				])
			)
		);
		const value = Array.from({ length: 1000 }, (_, i) =>
			i % 2 ? { type: 'b', b: i, [`x${i}`]: i } : { type: 'a', a: i, [`x${i}`]: i }
		);
		const result = safe_parse_dropping_unknown_keys(counted, { a: 1, value });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, {
			a: 1,
			value: Array.from({ length: 1000 }, (_, i) =>
				i % 2 ? { type: 'b', b: i } : { type: 'a', a: i }
			)
		});
		assert.strictEqual(counter.parses, 2);
	});

	test("a variant's last option of a discriminator wins, as in the variant's own map", () => {
		const { counter, counted } = create_counted_at(
			variant('t', [object({ t: literal('a'), p: number }), object({ t: literal('a'), q: number })])
		);
		const result = safe_parse_dropping_unknown_keys(counted, {
			a: 1,
			value: { t: 'a', q: 1, z: 1 }
		});
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, value: { t: 'a', q: 1 } });
		assert.strictEqual(counter.parses, 2);
	});

	test("the strip calls a lazy's function once, not once per value it reaches", () => {
		let calls = 0;
		const Counted: AnySchema = lazy(() => {
			calls++;
			return object({ n: number, next: optional(Counted) });
		});
		const { counted } = create_counted_at(array(Counted));
		const value = Array.from({ length: 300 }, (_, i) => ({ n: i, [`x${i}`]: i }));
		const result = safe_parse_dropping_unknown_keys(counted, { a: 1, value });
		assert.ok(result.ok);
		// one call from the lazy's own `run`, one from the walk
		assert.strictEqual(calls, 2);
	});

	test('an own `__proto__` under an `object_with_rest` is not walked as a rest value', () => {
		const shared = { k: 1 };
		const v: Record<string, unknown> = { a: shared };
		// a `__proto__` sharing an object another key holds: `structuredClone` keeps the sharing
		Object.defineProperty(v, '__proto__', {
			value: shared,
			enumerable: true,
			writable: true,
			configurable: true
		});
		const result = safe_parse_dropping_unknown_keys(
			object({ v: object_with_rest({ a: object({ k: number }) }, object({})) }),
			{ v, extra: 1 }
		);
		assert.ok(result.ok);
	});

	interface TreeNode {
		n: number;
		children?: Array<TreeNode>;
	}
	const Tree: AnySchema = lazy(() => object({ n: number, children: optional(array(Tree)) }));

	test('strips an unknown key on every node of a lazy tree in one pass', () => {
		const { counter, counted } = create_counted_at(Tree);
		// a root of 20 children of 30 grandchildren each, every node with an unknown key
		const leaf = (n: number): Record<string, unknown> => ({ n, [`x${n}`]: n });
		const value = {
			...leaf(0),
			children: Array.from({ length: 20 }, (_, i) => ({
				...leaf(i),
				children: Array.from({ length: 30 }, (_, j) => leaf(j))
			}))
		};
		const expected: TreeNode = {
			n: 0,
			children: Array.from({ length: 20 }, (_, i) => ({
				n: i,
				children: Array.from({ length: 30 }, (_, j) => ({ n: j }))
			}))
		};
		const result = safe_parse_dropping_unknown_keys(counted, { a: 1, value });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, value: expected });
		assert.strictEqual(counter.parses, 2);
	});

	test('strips an unknown key at every link of a 500-deep lazy chain in one pass', () => {
		const Chain: AnySchema = lazy(() => object({ n: number, next: optional(Chain) }));
		const { counter, counted } = create_counted_at(Chain);
		let value: Record<string, unknown> | undefined;
		let expected: Record<string, unknown> | undefined;
		for (let i = 499; i >= 0; i--) {
			value = { n: i, [`x${i}`]: i, ...(value && { next: value }) };
			expected = { n: i, ...(expected && { next: expected }) };
		}
		const result = safe_parse_dropping_unknown_keys(counted, { a: 1, value });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1, value: expected });
		assert.strictEqual(counter.parses, 2);
	});

	test("a union keeps every option's keys", () => {
		const either = object({ x: union([object({ a: number }), object({ a: number, b: number })]) });
		const result = safe_parse_dropping_unknown_keys(either, { x: { a: 1, b: 2 }, y: 0 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { x: { a: 1, b: 2 } });
	});

	test('never mutates the input', () => {
		const { counted } = create_counted_at(array(object({ c: boolean })));
		const value = {
			a: 1,
			k: 0,
			value: Array.from({ length: 300 }, (_, i) => ({ c: true, [`x${i}`]: i }))
		};
		const snapshot = structuredClone(value);
		const result = safe_parse_dropping_unknown_keys(counted, value);
		assert.ok(result.ok);
		assert.deepStrictEqual(value, snapshot);
	});

	test('deletes an own `__proto__` key as any other unknown key', () => {
		const value = JSON.parse(
			'{"a": 1, "__proto__": {"p": 1}, "nested": {"b": "b", "__proto__": 0}}'
		);
		const result = safe_parse_dropping_unknown_keys(schema, value);
		assert.ok(result.ok);
		assert.ok(!Object.hasOwn(result.value, '__proto__'));
		assert.ok(!Object.hasOwn(result.value.nested!, '__proto__'));
		assert.strictEqual(Object.getPrototypeOf(result.value), Object.prototype);
		assert.deepStrictEqual(result.value, { a: 1, nested: { b: 'b' } });
	});

	test('returns a real failure behind many unknown keys as that failure', () => {
		const { counter, counted } = create_counted_at(array(object({ c: boolean })));
		const value = Array.from({ length: 300 }, (_, i) => ({ c: true, [`x${i}`]: i }));
		value[299]!.c = 'nope' as unknown as boolean;
		const result = safe_parse_dropping_unknown_keys(counted, { a: 1, value });
		assert.ok(!result.ok);
		assert.strictEqual(counter.parses, 2);
		assert.strictEqual(result.issues.length, 1);
		const issue = result.issues[0]!;
		assert.ok('kind' in issue);
		assert.strictEqual(issue.kind, 'boolean');
		assert.deepStrictEqual(issue.path, ['value', 299, 'c']);
	});

	test("drops a later pipe stage's unknown keys an earlier stage names", () => {
		const piped = pipe(object({ a: number, b: optional(number) }), object({ a: number }));
		const result = safe_parse_dropping_unknown_keys(piped, { a: 1, b: 2, c: 3 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { a: 1 });
	});

	test('stops after the pass cap, returning the last failure', () => {
		const counter = { parses: 0 };
		// a later pipe stage's unknown keys go only as reported, a hundred per
		// parse: the first stage names `b`, so the schema-guided strip keeps it
		const counted = object({
			a: pipe(
				number,
				check(() => ++counter.parses > 0)
			),
			list: array(pipe(object({ c: boolean, b: optional(number) }), object({ c: boolean })))
		});
		const list = Array.from({ length: 100 * (UNKNOWN_KEY_PASSES_MAX + 2) }, () => ({
			c: true,
			b: 1
		}));
		const value = { a: 1, list };
		const result = safe_parse_dropping_unknown_keys(counted, value);
		assert.ok(!result.ok);
		assert.strictEqual(counter.parses, 1 + UNKNOWN_KEY_PASSES_MAX);
		assert.ok(result.issues.every((issue) => 'kind' in issue && issue.kind === 'unknown_key'));
		// the last pass's issues: the first parse reported the first hundred items
		const first_index = result.issues[0]!.path[1];
		assert.strictEqual(first_index, 100 * UNKNOWN_KEY_PASSES_MAX);
	});

	test('still fails on any other issue, with the original issues', () => {
		const result = safe_parse_dropping_unknown_keys(schema, { a: 'nope', x: 0 });
		assert.ok(!result.ok);
		const kinds = result.issues.map((issue) => ('kind' in issue ? issue.kind : issue.code)).sort();
		assert.deepStrictEqual(kinds, ['number', 'unknown_key']);
	});

	test('a union of strict objects is one issue of its own, not stripped', () => {
		const either = union([object({ a: number }), object({ b: number })]);
		const result = safe_parse_dropping_unknown_keys(either, { a: 1, x: 1 });
		assert.ok(!result.ok);
		assert.deepStrictEqual(
			result.issues.map((issue) => ('kind' in issue ? issue.kind : issue.code)),
			['union']
		);
	});

	test("a variant's matched option's unknown keys are stripped", () => {
		const tagged = variant('type', [
			object({ type: literal('a'), a: number }),
			object({ type: literal('b'), b: number })
		]);
		const result = safe_parse_dropping_unknown_keys(tagged, { type: 'a', a: 1, x: 1 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { type: 'a', a: 1 });
	});
});

describe('is_strict_object_schema', () => {
	test('returns true for a fuz_schema object, false for strip and loose objects', () => {
		assert.strictEqual(is_strict_object_schema(object({ name: string })), true);
		assert.strictEqual(is_strict_object_schema(strip_object({ name: string })), false);
		assert.strictEqual(is_strict_object_schema(loose_object({ name: string })), false);
		assert.strictEqual(is_strict_object_schema(string), false);
	});

	test('reads a refined fuz_schema object strict, as a refined z.strictObject() is', () => {
		const refined = pipe(
			object({ name: string }),
			check((v) => v.name !== '')
		);
		assert.strictEqual(is_strict_object_schema(refined), true);
		assert.strictEqual(
			is_strict_object_schema(
				pipe(
					refined,
					check((v) => v.name !== 'x')
				)
			),
			true
		);
		assert.strictEqual(is_strict_object_schema(message(refined, 'bad thing')), true);
		assert.strictEqual(
			is_strict_object_schema(z.strictObject({ name: z.string() }).refine((v) => v.name !== '')),
			true
		);
		assert.strictEqual(
			is_strict_object_schema(
				pipe(
					strip_object({ name: string }),
					check(() => true)
				)
			),
			false
		);
	});

	test('reads a transformed object not strict in either library', () => {
		assert.strictEqual(
			is_strict_object_schema(
				pipe(
					object({ name: string }),
					transform((v) => v)
				)
			),
			false
		);
		assert.strictEqual(
			is_strict_object_schema(
				pipe(
					pipe(
						object({ name: string }),
						transform((v) => v)
					),
					check(() => true)
				)
			),
			false
		);
		assert.strictEqual(
			is_strict_object_schema(z.strictObject({ name: z.string() }).transform((v) => v)),
			false
		);
	});

	test('returns true for z.strictObject()', () => {
		assert.strictEqual(is_strict_object_schema(z.strictObject({ name: z.string() })), true);
	});

	test('returns false for z.object()', () => {
		assert.strictEqual(is_strict_object_schema(z.object({ name: z.string() })), false);
	});

	test('returns false for z.looseObject()', () => {
		assert.strictEqual(is_strict_object_schema(z.looseObject({ name: z.string() })), false);
	});

	test('returns false for z.string()', () => {
		assert.strictEqual(is_strict_object_schema(z.string()), false);
	});

	test('returns false for z.null()', () => {
		assert.strictEqual(is_strict_object_schema(z.null()), false);
	});
});

describe('schema_to_surface', () => {
	test('returns null for null schema', () => {
		assert.strictEqual(schema_to_surface(z.null()), null);
	});

	test('returns JSON Schema for object schema', () => {
		const schema = z.strictObject({ name: z.string() });
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual(result.type, 'object');
		assert.ok(result.properties);
	});

	test('strips $schema from output', () => {
		const schema = z.strictObject({ id: z.number() });
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual('$schema' in result, false);
	});

	test('returns JSON Schema for string schema', () => {
		const result = schema_to_surface(z.string()) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual(result.type, 'string');
	});

	test('strips default from output to avoid non-deterministic function defaults', () => {
		const schema = z.strictObject({
			created: z.string().default(() => new Date().toISOString()),
			name: z.string()
		});
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		const props = result.properties as Record<string, Record<string, unknown>>;
		assert.ok(props.created);
		assert.ok(props.name);
		assert.strictEqual('default' in props.created, false);
		// structural fields preserved
		assert.strictEqual(props.created.type, 'string');
		assert.strictEqual(props.name.type, 'string');
	});

	test('strips default from nested schemas', () => {
		const schema = z.strictObject({
			outer: z.strictObject({
				inner: z.number().default(42)
			})
		});
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		const outer = (result.properties as Record<string, Record<string, unknown>>).outer;
		assert.ok(outer);
		const inner_props = outer.properties as Record<string, Record<string, unknown>>;
		assert.ok(inner_props);
		const inner = inner_props.inner;
		assert.ok(inner);
		assert.strictEqual('default' in inner, false);
		assert.strictEqual(inner.type, 'number');
	});

	test('surface is deterministic with function defaults', () => {
		const schema = z.strictObject({
			ts: z.string().default(() => new Date().toISOString())
		});
		const a = schema_to_surface(schema);
		const b = schema_to_surface(schema);
		assert.deepStrictEqual(a, b);
	});

	test('returns null for z.void()', () => {
		assert.strictEqual(schema_to_surface(z.void()), null);
	});

	test('describes the input side with io input, through a transform', () => {
		const schema = z.strictObject({
			name: z
				.string()
				.min(2)
				.transform((s) => s.toLowerCase())
		});
		const gaps: Array<string> = [];
		const result = schema_to_surface(schema, {
			io: 'input',
			on_unrepresentable: (m) => gaps.push(m)
		}) as Record<string, any>;
		assert.deepStrictEqual(result.properties.name, { type: 'string', minLength: 2 });
		assert.deepStrictEqual(gaps, []);
	});

	test('writes an output-side transform as {} and reports the gap', () => {
		const schema = z.strictObject({
			name: z.string().transform((s) => s.toLowerCase()),
			id: z.number()
		});
		const gaps: Array<string> = [];
		const result = schema_to_surface(schema, {
			on_unrepresentable: (m) => gaps.push(m)
		}) as Record<string, any>;
		assert.deepStrictEqual(result.properties.name, {});
		assert.deepStrictEqual(result.properties.id, { type: 'number' });
		assert.deepStrictEqual(result.required, ['name', 'id']);
		assert.strictEqual(gaps.length, 1);
		assert.include(gaps[0], 'Transforms');
	});

	test('throws naming the source for a schema with no JSON Schema form', () => {
		// a `z.custom()` that refuses null, so `is_null_schema` is false — this
		// was a silent `null`, reading as "no input"
		const unconvertible = z.custom<unknown>((v) => v !== null && v !== undefined);
		assert.throws(
			() => schema_to_surface(unconvertible, { source: 'POST /api/thing input' }),
			/^POST \/api\/thing input: has no JSON Schema form: Custom types/
		);
	});

	test('z.unknown() is the declared "anything", written as {}', () => {
		assert.deepStrictEqual(schema_to_surface(z.unknown()), {});
	});
});

describe('schema_to_surface — fuz_schema', () => {
	test('returns null for literal(null)', () => {
		assert.strictEqual(schema_to_surface(literal(null)), null);
	});

	test('returns null for s.void on either side, as for z.void()', () => {
		for (const io of ['input', 'output'] as const) {
			assert.strictEqual(schema_to_surface(z.void(), { io }), null);
			assert.strictEqual(schema_to_surface(fuz_void, { io }), null);
			assert.strictEqual(
				schema_to_surface(meta(fuz_void, { description: 'no params' }), { io }),
				null
			);
		}
	});

	test('writes an object with $schema and default stripped at every depth', () => {
		const schema = object({
			name: pipe(string, min_length(2)),
			inner: object({ n: with_default(number, 42) })
		});
		assert.deepStrictEqual(schema_to_surface(schema, { io: 'input' }), {
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 2 },
				inner: {
					type: 'object',
					properties: { n: { type: 'number' } },
					additionalProperties: false
				}
			},
			required: ['name', 'inner'],
			additionalProperties: false
		});
	});

	test('the output side requires a defaulted key, the input side does not', () => {
		const schema = object({ n: with_default(number, 1) });
		const output = schema_to_surface(schema, { io: 'output' }) as Record<string, unknown>;
		const input = schema_to_surface(schema, { io: 'input' }) as Record<string, unknown>;
		assert.deepStrictEqual(output.required, ['n']);
		assert.strictEqual('required' in input, false);
	});

	test('writes a check as nothing and a transform output as {}, reporting each', () => {
		const schema = object({
			code: pipe(
				string,
				min_length(3),
				check((s: string) => s !== 'bad')
			),
			size: pipe(
				string,
				transform((s: string) => s.length)
			)
		});
		const gaps: Array<string> = [];
		const result = schema_to_surface(schema, {
			on_unrepresentable: (m) => gaps.push(m)
		}) as Record<string, any>;
		assert.deepStrictEqual(result.properties.code, { type: 'string', minLength: 3 });
		assert.deepStrictEqual(result.properties.size, {});
		// the emitter names the first thing it can't write, where it is
		assert.strictEqual(gaps.length, 1);
		assert.include(gaps[0], '#/properties/');
	});

	test('throws naming the source for a schema with no JSON Schema form', () => {
		assert.throws(
			() => schema_to_surface(bigint, { source: 'thing_get output' }),
			/^thing_get output: has no JSON Schema form: .*bigint/
		);
	});

	test('throws naming the source for a schema the emitter refuses in either mode', () => {
		assert.throws(
			() => schema_to_surface(object({ toString: string }), { source: 'thing_get input' }),
			/^thing_get input: cannot be written as JSON Schema: .*Object\.prototype/
		);
	});
});

describe('middleware_applies', () => {
	test('exact match', () => {
		assert.strictEqual(middleware_applies('/health', '/health'), true);
	});

	test('wildcard matches subpath', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api/account/login'), true);
	});

	test('wildcard matches exact prefix without trailing slash', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api'), true);
	});

	test('wildcard does not match different prefix', () => {
		assert.strictEqual(middleware_applies('/api/zap/*', '/api/account/login'), false);
	});

	test('scoped wildcard matches within scope', () => {
		assert.strictEqual(middleware_applies('/api/zap/*', '/api/zap/runs'), true);
	});

	test('no match for unrelated paths', () => {
		assert.strictEqual(middleware_applies('/foo', '/bar'), false);
	});

	test('root wildcard matches any path', () => {
		assert.strictEqual(middleware_applies('/*', '/anything'), true);
		assert.strictEqual(middleware_applies('/*', '/deep/nested/path'), true);
	});

	test('bare star matches everything', () => {
		assert.strictEqual(middleware_applies('*', '/anything'), true);
		assert.strictEqual(middleware_applies('*', '/api/deep/path'), true);
		assert.strictEqual(middleware_applies('*', '/'), true);
	});

	test('wildcard does not match partial prefix', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api2/foo'), false);
	});

	test('exact match does not match subpath', () => {
		assert.strictEqual(middleware_applies('/api', '/api/foo'), false);
	});
});
