/**
 * Tests for `schema_meta.ts` — reading a field's declared `invalid_reason`
 * through its wrappers, along a validation issue's path, and over a failed
 * parse's issues.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import {
	resolve_invalid_reason,
	resolve_issues_invalid_reason,
	schema_invalid_reason
} from '#lib/schema_meta.ts';

const Inner = z.strictObject({
	days: z.number().int().min(1).meta({ invalid_reason: 'days_invalid' }),
	note: z.string()
});

const Input = z
	.strictObject({
		limit: z.number().int().min(1).max(10).nullish().meta({ invalid_reason: 'limit_bad' }),
		// the declaration on an inner layer, wrapped after
		offset: z.number().int().min(0).meta({ invalid_reason: 'offset_bad' }).nullish(),
		lifetime: Inner.meta({ invalid_reason: 'lifetime_bad' }),
		scope: z
			.discriminatedUnion('kind', [
				z.strictObject({ kind: z.literal('full') }),
				z.strictObject({ kind: z.literal('methods'), methods: z.array(z.string()) })
			])
			.meta({ invalid_reason: 'scope_bad' }),
		name: z.string().default('x')
	})
	.default({ lifetime: { days: 1, note: '' }, scope: { kind: 'full' }, name: 'x' });

/** The first issue's path for `params` against `Input`. */
const first_path = (params: unknown): ReadonlyArray<PropertyKey> => {
	const result = Input.safeParse(params);
	assert.ok(!result.success, 'the params must be refused');
	return result.error.issues[0]!.path;
};

const VALID = { lifetime: { days: 1, note: '' }, scope: { kind: 'full' } };

describe('schema_invalid_reason', () => {
	test('reads the declaration on the outermost layer', () => {
		assert.strictEqual(schema_invalid_reason(Input.unwrap().shape.limit), 'limit_bad');
	});

	test('reads a declaration under wrappers', () => {
		assert.strictEqual(schema_invalid_reason(Input.unwrap().shape.offset), 'offset_bad');
	});

	test('an undeclared field has none', () => {
		assert.strictEqual(schema_invalid_reason(Input.unwrap().shape.name), undefined);
	});

	test('the outermost declaration wins', () => {
		const schema = z.number().meta({ invalid_reason: 'inner' }).optional().meta({
			invalid_reason: 'outer'
		});
		assert.strictEqual(schema_invalid_reason(schema), 'outer');
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
		// an unknown key inside `lifetime` lands on `lifetime` itself
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

	test('a whole-input fault answers none', () => {
		const path = first_path({ ...VALID, __extra: 1 });
		assert.deepStrictEqual(path, []);
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
		assert.strictEqual(resolve_invalid_reason(z.void(), ['limit']), undefined);
		assert.strictEqual(
			resolve_invalid_reason(z.number().meta({ invalid_reason: 'top' }), []),
			undefined
		);
	});
});

describe('resolve_issues_invalid_reason', () => {
	const issues_of = (params: unknown): ReadonlyArray<z.core.$ZodIssue> => {
		const result = Input.safeParse(params);
		assert.ok(!result.success, 'the params must be refused');
		return result.error.issues;
	};

	test("a single fault answers its field's reason", () => {
		assert.strictEqual(
			resolve_issues_invalid_reason(Input, issues_of({ ...VALID, limit: 0 })),
			'limit_bad'
		);
	});

	test("several field faults answer the first issue's reason", () => {
		const issues = issues_of({ ...VALID, limit: 0, offset: -1 });
		assert.ok(issues.length > 1);
		assert.strictEqual(
			resolve_issues_invalid_reason(Input, issues),
			resolve_invalid_reason(Input, issues[0]!.path)
		);
	});

	test('an unknown key on the input answers none, whatever else is wrong', () => {
		for (const params of [
			{ ...VALID, extra: 1 },
			{ ...VALID, limit: 0, extra: 1 },
			{ extra: 1, ...VALID, offset: 'x' }
		]) {
			const issues = issues_of(params);
			assert.ok(
				issues.some((issue) => issue.code === 'unrecognized_keys' && issue.path.length === 0),
				JSON.stringify(params)
			);
			assert.strictEqual(
				resolve_issues_invalid_reason(Input, issues),
				undefined,
				JSON.stringify(params)
			);
		}
	});

	test('an unknown key inside a declared field keeps its reason', () => {
		assert.strictEqual(
			resolve_issues_invalid_reason(
				Input,
				issues_of({ ...VALID, lifetime: { days: 1, note: '', extra: 1 } })
			),
			'lifetime_bad'
		);
	});

	test('no issues answer none', () => {
		assert.strictEqual(resolve_issues_invalid_reason(Input, []), undefined);
	});
});
