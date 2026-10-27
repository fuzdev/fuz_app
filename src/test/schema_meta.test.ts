/**
 * Tests for `schema_meta.ts` — reading a field's declared `invalid_reason`
 * and `sensitivity` through its wrappers, an input's sensitive fields at any
 * depth, and the reason along a validation issue's path and over a failed
 * parse's issues.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import {
	resolve_invalid_reason,
	resolve_issues_invalid_reason,
	schema_has_sensitive_field,
	schema_invalid_reason,
	schema_sensitivity
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

describe('schema_sensitivity', () => {
	test('reads a secret on any member of a union or intersection', () => {
		const secret = z.string().meta({ sensitivity: 'secret' });
		for (const schema of [
			z.union([secret, z.literal('')]),
			z.union([z.literal(''), secret]).optional(),
			z.intersection(secret, z.string().min(1)),
			z.intersection(z.string().min(1), secret)
		]) {
			assert.strictEqual(schema_sensitivity(schema), 'secret');
		}
		assert.strictEqual(schema_sensitivity(z.union([z.string(), z.literal('')])), undefined);
	});

	test('reads a secret under optional, nullable, and default wrappers', () => {
		const secret = z.string().meta({ sensitivity: 'secret' });
		for (const schema of [
			secret,
			secret.optional(),
			secret.nullable(),
			secret.default('x'),
			secret.optional().nullable()
		]) {
			assert.strictEqual(schema_sensitivity(schema), 'secret');
		}
	});

	test('reads a secret under every wrapping layer', () => {
		const secret = z.string().meta({ sensitivity: 'secret' });
		const cases: Array<[string, z.ZodType]> = [
			['optional', secret.optional()],
			['nullable + default', secret.nullable().default(null)],
			['transform', secret.transform((v) => v.trim())],
			['coerce + optional', z.coerce.string().meta({ sensitivity: 'secret' }).optional()],
			['outer meta', z.string().optional().meta({ sensitivity: 'secret' })],
			['catch', secret.catch('x')],
			['readonly', secret.readonly()],
			['nonoptional', secret.optional().nonoptional()],
			['preprocess', z.preprocess((v) => v, secret)],
			['pipe out', z.string().pipe(secret)],
			['catch under optional', secret.catch('x').optional()],
			['lazy', z.lazy(() => secret).optional()]
		];
		for (const [label, schema] of cases) {
			assert.strictEqual(schema_sensitivity(schema), 'secret', label);
		}
	});

	test('an undeclared field has none', () => {
		assert.strictEqual(schema_sensitivity(z.string().optional()), undefined);
		assert.strictEqual(schema_sensitivity(z.string().pipe(z.string()).catch('x')), undefined);
	});

	test('a secret inside a structural schema does not mark it', () => {
		const secret = z.string().meta({ sensitivity: 'secret' });
		assert.strictEqual(schema_sensitivity(z.strictObject({ token: secret })), undefined);
		assert.strictEqual(schema_sensitivity(z.array(secret)), undefined);
	});

	test("a template literal's schema part counts — the value contains it", () => {
		const secret = z.string().meta({ sensitivity: 'secret' });
		assert.strictEqual(schema_sensitivity(z.templateLiteral(['k_', secret])), 'secret');
		assert.strictEqual(schema_sensitivity(z.templateLiteral(['k_', z.string(), 1])), undefined);
	});

	test('a recursive lazy schema terminates', () => {
		interface Node {
			next?: Node;
		}
		const node: z.ZodType<Node> = z.lazy(() => z.strictObject({ next: node.optional() }));
		const self_lazy: z.ZodType = z.lazy(() => self_lazy.optional());
		assert.strictEqual(schema_sensitivity(node), undefined);
		assert.strictEqual(schema_sensitivity(self_lazy), undefined);
	});
	test('personal is read like secret, and secret wins over it', () => {
		const personal = z.string().meta({ sensitivity: 'personal' });
		const secret = z.string().meta({ sensitivity: 'secret' });
		assert.strictEqual(schema_sensitivity(personal.optional()), 'personal');
		assert.strictEqual(schema_sensitivity(z.union([personal, secret])), 'secret');
		assert.strictEqual(schema_sensitivity(z.union([secret, personal])), 'secret');
		assert.strictEqual(schema_sensitivity(personal.meta({ sensitivity: 'secret' })), 'secret');
	});
});

describe('schema_has_sensitive_field', () => {
	const secret = z.string().meta({ sensitivity: 'secret' });
	const personal = z.string().meta({ sensitivity: 'personal' });

	test('finds a secret or personal value at any depth', () => {
		for (const sensitive of [secret, personal]) {
			const cases: Array<[string, z.ZodType]> = [
				['root', sensitive],
				['root field', z.strictObject({ a: sensitive })],
				['optional field', z.strictObject({ a: sensitive.optional() })],
				['nullable field', z.strictObject({ a: sensitive.nullable() })],
				['default field', z.strictObject({ a: sensitive.default('x') })],
				['optional input', z.strictObject({ a: sensitive }).optional()],
				['nested object', z.strictObject({ a: z.strictObject({ b: sensitive }) })],
				['array of objects', z.strictObject({ a: z.array(z.strictObject({ b: sensitive })) })],
				[
					'union of objects',
					z.strictObject({
						a: z.union([z.strictObject({ b: z.number() }), z.strictObject({ c: sensitive })])
					})
				],
				[
					'discriminated union',
					z.discriminatedUnion('kind', [
						z.strictObject({ kind: z.literal('a') }),
						z.strictObject({ kind: z.literal('b'), q: sensitive })
					])
				],
				[
					'intersection',
					z.intersection(z.strictObject({ a: z.number() }), z.looseObject({ b: sensitive }))
				],
				['record value', z.strictObject({ a: z.record(z.string(), sensitive) })],
				['tuple item', z.strictObject({ a: z.tuple([z.number(), sensitive]) })],
				['template literal part', z.strictObject({ a: z.templateLiteral(['k_', sensitive]) })],
				['lazy', z.strictObject({ a: z.lazy(() => z.strictObject({ b: sensitive })) })]
			];
			for (const [label, schema] of cases) {
				assert.isTrue(
					schema_has_sensitive_field(schema),
					`${label}: ${schema_sensitivity(sensitive)}`
				);
			}
		}
	});

	test('an input with no sensitive value has none', () => {
		interface Node {
			next?: Node;
		}
		const node: z.ZodType<Node> = z.lazy(() => z.strictObject({ next: node.optional() }));
		for (const schema of [
			z.null(),
			z.strictObject({ a: z.string(), b: z.array(z.strictObject({ c: z.number() })).optional() }),
			z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.uuid() })]),
			z.strictObject({ a: z.record(z.string(), z.string()) }),
			z.templateLiteral(['k_', z.string(), 1]),
			node
		]) {
			assert.isFalse(schema_has_sensitive_field(schema));
		}
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
