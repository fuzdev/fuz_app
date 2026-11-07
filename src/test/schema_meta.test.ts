/**
 * Tests for `schema_meta.ts` — an input's sensitive fields at any depth, its
 * handler-guarded marker, and the declared `invalid_reason` along a
 * validation issue's path and over a failed parse's issues.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import {
	array,
	integer,
	lazy,
	max_value,
	literal,
	min_value,
	nullable,
	number,
	object,
	object_with_rest,
	optional,
	parse,
	pipe,
	record,
	string,
	transform,
	union,
	variant,
	void as void_schema,
	with_default,
	type AnySchema,
	type Schema
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import {
	is_empty_input_handler_guarded,
	resolve_invalid_reason,
	resolve_issues_invalid_reason,
	schema_has_sensitive_field
} from '#lib/schema_meta.ts';

const Inner = object({
	days: meta(pipe(number, integer, min_value(1)), { invalid_reason: 'days_invalid' }),
	note: string
});

const Input = with_default(
	object({
		limit: meta(optional(nullable(pipe(number, integer, min_value(1), max_value(10)))), {
			invalid_reason: 'limit_bad'
		}),
		// the declaration on an inner layer, wrapped after
		offset: optional(
			nullable(meta(pipe(number, integer, min_value(0)), { invalid_reason: 'offset_bad' }))
		),
		lifetime: meta(Inner, { invalid_reason: 'lifetime_bad' }),
		scope: meta(
			variant('kind', [
				object({ kind: literal('full') }),
				object({ kind: literal('methods'), methods: array(string) })
			]),
			{ invalid_reason: 'scope_bad' }
		),
		name: with_default(string, 'x'),
		// the outermost of two declarations wins
		both: optional(
			meta(optional(meta(number, { invalid_reason: 'inner' })), { invalid_reason: 'outer' })
		)
	}),
	{ lifetime: { days: 1, note: '' }, scope: { kind: 'full' }, name: 'x' }
);

/** The first issue's path for `params` against `Input`. */
const first_path = (params: unknown): ReadonlyArray<PropertyKey> => {
	const result = parse(Input, params);
	assert.ok(!result.ok, 'the params must be refused');
	return result.issues[0]!.path;
};

const VALID = { lifetime: { days: 1, note: '' }, scope: { kind: 'full' } };

describe('schema_has_sensitive_field', () => {
	const secret = meta(string, { sensitivity: 'secret' });
	const personal = meta(string, { sensitivity: 'personal' });

	test('finds a secret or personal value at any depth', () => {
		for (const sensitive of [secret, personal]) {
			const cases: Array<[string, AnySchema]> = [
				['root', sensitive],
				['root field', object({ a: sensitive })],
				['optional field', object({ a: optional(sensitive) })],
				['nullable field', object({ a: nullable(sensitive) })],
				['default field', object({ a: with_default(sensitive, 'x') })],
				['optional input', optional(object({ a: sensitive }))],
				['nested object', object({ a: object({ b: sensitive }) })],
				['array of objects', object({ a: array(object({ b: sensitive })) })],
				[
					'union of objects',
					object({ a: union([object({ b: number }), object({ c: sensitive })]) })
				],
				[
					'variant',
					variant('kind', [
						object({ kind: literal('a') }),
						object({ kind: literal('b'), q: sensitive })
					])
				],
				['record value', object({ a: record(sensitive) })],
				['rest', object_with_rest({ a: number }, sensitive)],
				[
					'pipe step',
					object({
						a: pipe(
							string,
							transform((v: string) => v),
							sensitive
						)
					})
				],
				['lazy', object({ a: lazy(() => object({ b: sensitive })) })]
			];
			for (const [label, schema] of cases) {
				assert.isTrue(schema_has_sensitive_field(schema), label);
			}
		}
	});

	test('an input with no sensitive value has none', () => {
		for (const schema of [
			literal(null),
			object({ a: string, b: optional(array(object({ c: number }))) }),
			union([object({ a: string }), object({ b: number })]),
			object({ a: record(string) })
		]) {
			assert.isFalse(schema_has_sensitive_field(schema));
		}
	});

	test('a recursive lazy input terminates, with or without a sensitive value', () => {
		interface Node {
			next?: Node;
		}
		const node: Schema<Node> = lazy(() => object({ next: optional(node) }));
		assert.isFalse(schema_has_sensitive_field(node));
		assert.isFalse(schema_has_sensitive_field(object({ n: node })));
		interface SecretNode {
			token: string;
			next?: SecretNode;
		}
		const secret_node: Schema<SecretNode> = lazy(() =>
			object({ token: meta(string, { sensitivity: 'secret' }), next: optional(secret_node) })
		);
		assert.isTrue(schema_has_sensitive_field(object({ n: secret_node })));
	});

	test('a value that is not a schema throws', () => {
		assert.throws(
			() => schema_has_sensitive_field({} as unknown as AnySchema),
			/^schema_has_sensitive_field: the input is .*a @fuzdev\/fuz_schema schema$/
		);
	});
});

describe('is_empty_input_handler_guarded', () => {
	test('reads the marker on the input itself', () => {
		const guarded = meta(object({ a: optional(string) }), { empty_input_handler_guarded: true });
		assert.isTrue(is_empty_input_handler_guarded(guarded));
		assert.isFalse(is_empty_input_handler_guarded(optional(guarded)), 'a wrapper drops it');
		assert.isFalse(is_empty_input_handler_guarded(object({})));
	});

	test('a value that is not a schema throws', () => {
		assert.throws(
			() => is_empty_input_handler_guarded({} as unknown as AnySchema),
			/^is_empty_input_handler_guarded: the input is .*a @fuzdev\/fuz_schema schema$/
		);
	});
});

describe('resolve_invalid_reason', () => {
	test('a declared field answers its reason on every fault kind', () => {
		for (const limit of ['not_a_number', 1.5, 0, 11, 1e16, true]) {
			const path = first_path({ ...VALID, limit });
			assert.strictEqual(resolve_invalid_reason(Input, path), 'limit_bad', String(limit));
		}
	});

	test('a missing or null required field answers its reason', () => {
		assert.strictEqual(
			resolve_invalid_reason(Input, first_path({ scope: VALID.scope })),
			'lifetime_bad'
		);
		assert.strictEqual(
			resolve_invalid_reason(Input, first_path({ ...VALID, scope: null })),
			'scope_bad'
		);
	});

	test('a field declared under its wrappers resolves', () => {
		assert.strictEqual(
			resolve_invalid_reason(Input, first_path({ ...VALID, offset: -1 })),
			'offset_bad'
		);
	});

	test('a fault inside a declared field takes the deepest declaration on the path', () => {
		// `days` declares its own, overriding `lifetime`'s
		assert.deepStrictEqual(first_path({ ...VALID, lifetime: { days: 0, note: '' } }), [
			'lifetime',
			'days'
		]);
		assert.strictEqual(
			resolve_invalid_reason(Input, first_path({ ...VALID, lifetime: { days: 0, note: '' } })),
			'days_invalid'
		);
		// `note` declares none, so `lifetime`'s answers
		assert.strictEqual(
			resolve_invalid_reason(Input, first_path({ ...VALID, lifetime: { days: 1, note: 4 } })),
			'lifetime_bad'
		);
		// an unknown key inside `lifetime` is off its shape, so `lifetime`'s answers
		assert.strictEqual(
			resolve_invalid_reason(
				Input,
				first_path({ ...VALID, lifetime: { days: 1, note: '', extra: 1 } })
			),
			'lifetime_bad'
		);
	});

	test('a fault inside a union member resolves to the union field', () => {
		const path = first_path({ ...VALID, scope: { kind: 'methods', methods: 5 } });
		assert.deepStrictEqual(path, ['scope', 'methods']);
		assert.strictEqual(resolve_invalid_reason(Input, path), 'scope_bad');
		assert.strictEqual(
			resolve_invalid_reason(Input, first_path({ ...VALID, scope: { kind: 'nope' } })),
			'scope_bad'
		);
	});

	test('an undeclared field answers none', () => {
		assert.strictEqual(resolve_invalid_reason(Input, first_path({ ...VALID, name: 4 })), undefined);
	});

	test('the outermost of several declarations on one field wins', () => {
		assert.strictEqual(resolve_invalid_reason(Input, first_path({ ...VALID, both: 'x' })), 'outer');
	});

	test('a whole-input fault answers none', () => {
		// an unknown key on the input is off the shape
		const path = first_path({ ...VALID, __extra: 1 });
		assert.deepStrictEqual(path, ['__extra']);
		assert.strictEqual(resolve_invalid_reason(Input, path), undefined);
		assert.strictEqual(resolve_invalid_reason(Input, first_path([1, 2])), undefined);
	});

	test('a key off the shape ends the walk, prototype keys included', () => {
		assert.strictEqual(resolve_invalid_reason(Input, ['nope']), undefined);
		assert.strictEqual(resolve_invalid_reason(Input, ['toString']), undefined);
		assert.strictEqual(resolve_invalid_reason(Input, ['limit', 0, 'x']), 'limit_bad');
		assert.strictEqual(resolve_invalid_reason(Input, ['constructor']), undefined);
		assert.strictEqual(resolve_invalid_reason(Input, ['__proto__']), undefined);
	});

	test('a non-object input answers none', () => {
		assert.strictEqual(resolve_invalid_reason(void_schema, ['limit']), undefined);
		assert.strictEqual(
			resolve_invalid_reason(meta(number, { invalid_reason: 'top' }), []),
			undefined
		);
	});
});

describe('resolve_issues_invalid_reason', () => {
	const FuzInner = object({
		days: meta(pipe(number, integer, min_value(1)), { invalid_reason: 'days_invalid' }),
		note: string
	});
	const FuzInput = object({
		limit: meta(optional(nullable(pipe(number, integer, min_value(1)))), {
			invalid_reason: 'limit_bad'
		}),
		// the declaration on an inner layer, wrapped after
		offset: optional(meta(pipe(number, integer, min_value(0)), { invalid_reason: 'offset_bad' })),
		lifetime: meta(FuzInner, { invalid_reason: 'lifetime_bad' }),
		ids: optional(meta(array(number), { invalid_reason: 'ids_bad' })),
		name: optional(string)
	});
	const FUZ_VALID = { lifetime: { days: 1, note: '' } };

	const reason_of = (params: unknown): string | undefined => {
		const result = parse(FuzInput, params);
		assert.ok(!result.ok, `the params must be refused: ${JSON.stringify(params)}`);
		return resolve_issues_invalid_reason(FuzInput, result.issues, params);
	};

	test("a field fault answers its field's reason, through its wrappers", () => {
		for (const limit of ['x', 1.5, 0, true]) {
			assert.strictEqual(reason_of({ ...FUZ_VALID, limit }), 'limit_bad', String(limit));
		}
		assert.strictEqual(reason_of({ ...FUZ_VALID, offset: -1 }), 'offset_bad');
		// a missing required field is its own `missing_key` issue, or a refusal of `undefined`
		assert.strictEqual(reason_of({}), 'lifetime_bad');
		assert.strictEqual(reason_of({ ...FUZ_VALID, name: 4 }), undefined);
	});

	test("several field faults answer the first issue's reason", () => {
		const params = { ...FUZ_VALID, limit: 0, offset: -1 };
		const result = parse(FuzInput, params);
		assert.ok(!result.ok);
		assert.ok(result.issues.length > 1);
		assert.strictEqual(
			resolve_issues_invalid_reason(FuzInput, result.issues, params),
			resolve_invalid_reason(FuzInput, result.issues[0]!.path)
		);
	});

	test('a fault inside a declared field takes the deepest declaration', () => {
		assert.strictEqual(reason_of({ lifetime: { days: 0, note: '' } }), 'days_invalid');
		assert.strictEqual(reason_of({ lifetime: { days: 1, note: 4 } }), 'lifetime_bad');
	});

	test('an unknown key on the input answers none, whatever else is wrong', () => {
		for (const params of [
			{ ...FUZ_VALID, extra: 1 },
			{ ...FUZ_VALID, limit: 0, extra: 1 },
			{ extra: 1, ...FUZ_VALID, offset: 'x' }
		]) {
			assert.strictEqual(reason_of(params), undefined, JSON.stringify(params));
		}
	});

	test("an unknown key inside a declared field answers that field's reason", () => {
		const result = parse(FuzInput, { lifetime: { days: 1, note: '', extra: 1 } });
		assert.ok(!result.ok);
		assert.deepStrictEqual(
			result.issues.map((issue) => [issue.kind, issue.path]),
			[['unknown_key', ['lifetime', 'extra']]]
		);
		assert.strictEqual(
			resolve_issues_invalid_reason(FuzInput, result.issues, { lifetime: {} }),
			'lifetime_bad'
		);
	});

	test('a non-object input answers none', () => {
		for (const params of [[1, 2], 'x', null, 4]) {
			assert.strictEqual(reason_of(params), undefined, JSON.stringify(params));
		}
	});

	test('an unknown key the issue cap crowds out still answers none', () => {
		// more failing items than a parse reports issues, then an unknown key
		const params = { ...FUZ_VALID, ids: Array.from({ length: 101 }, () => 'x'), extra: 1 };
		const result = parse(FuzInput, params);
		assert.ok(!result.ok);
		assert.strictEqual(result.issues.length, 100);
		assert.ok(result.issues.every((issue) => issue.kind !== 'unknown_key'));
		assert.strictEqual(resolve_issues_invalid_reason(FuzInput, result.issues, params), undefined);
		// without the extra key, the crowded field answers its own reason
		const { extra: _, ...without } = params;
		assert.strictEqual(reason_of(without), 'ids_bad');
	});

	test('no issues answer none', () => {
		assert.strictEqual(resolve_issues_invalid_reason(FuzInput, [], {}), undefined);
	});
});
