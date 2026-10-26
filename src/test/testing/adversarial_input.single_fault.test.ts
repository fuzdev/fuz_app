/**
 * Every per-field case `generate_input_test_cases` builds is single-fault:
 * valid except for the field it breaks. A field the base omits gets a body
 * that carries it (`generate_valid_object_with_field`) — joined to the base
 * for a pair rule, in place of the base's optional fields for an
 * exactly-one-of rule — so a case on it can't also break an object-level
 * rule, and with no such body its value cases are not built.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import {
	generate_input_test_cases,
	type InputTestCase
} from '#lib/testing/adversarial_input_cases.ts';
import {
	generate_valid_body,
	generate_valid_object_with_field,
	generate_valid_value
} from '#lib/testing/schema_generators.ts';
import { zod_extract_fields, zod_unwrap_to_object, type ZodFieldInfo } from '#lib/zod.ts';
import { create_spine_live_rpc_endpoints } from '#lib/testing/cross_backend/full_spine_mount.ts';

const NIL = '00000000-0000-0000-0000-000000000000';

// exactly one of `id` / `slug` — the generated base fills `id`
const ExactlyOne = z
	.strictObject({
		id: z.uuid().optional(),
		slug: z.string().min(3).max(40).optional(),
		note: z.string().max(20).optional()
	})
	.refine((v) => (v.id !== undefined) !== (v.slug !== undefined), {
		message: 'exactly one of id or slug'
	});

// both or neither — the generated base fills neither
const Paired = z
	.strictObject({
		to: z.uuid(),
		scope_kind: z.string().min(1).max(64).nullish(),
		scope_id: z.uuid().nullish()
	})
	.refine((v) => (v.scope_kind == null) === (v.scope_id == null), {
		message: 'scope_kind and scope_id together'
	});

// `code` is valid on no body: the refine refuses every value of it
const NeverWithCode = z
	.strictObject({ id: z.uuid(), code: z.string().min(2).max(8).optional() })
	.refine((v) => v.code === undefined, { message: 'code is not accepted' });

const field_of = (schema: z.ZodType, name: string): ZodFieldInfo => {
	const object_schema = zod_unwrap_to_object(schema)!;
	return zod_extract_fields(object_schema).find((f) => f.name === name)!;
};

const cases_on = (cases: Array<InputTestCase>, field: string): Array<InputTestCase> =>
	cases.filter((c) => c.field === field);

const body_of = (cases: Array<InputTestCase>, label: string): Record<string, unknown> => {
	const found = cases.find((c) => c.label === label);
	assert.ok(found, `no case '${label}'`);
	return found.body as Record<string, unknown>;
};

/**
 * Whether a per-field case is valid but for its field: with the field set to
 * its generated valid value, or (a type case on a field no valid body carries)
 * dropped, the whole input parses.
 */
const is_single_fault = (input: z.ZodType, c: InputTestCase): boolean => {
	const object_schema = zod_unwrap_to_object(input)!;
	const field = c.field!;
	const info = zod_extract_fields(object_schema).find((f) => f.name === field)!;
	const body = c.body as Record<string, unknown>;
	const restored = {
		...body,
		[field]: generate_valid_value(info, object_schema.shape[field] as z.ZodType)
	};
	if (input.safeParse(restored).success) return true;
	if (!/^(wrong type|null):/.test(c.label)) return false;
	const { [field]: _dropped, ...without } = body;
	return input.safeParse(without).success;
};

describe('generate_valid_object_with_field', () => {
	const object_of = (schema: z.ZodType) => zod_unwrap_to_object(schema)!;

	test('a field the base carries keeps the base', () => {
		const base = generate_valid_body(ExactlyOne)!;
		assert.strictEqual(
			generate_valid_object_with_field(
				object_of(ExactlyOne),
				ExactlyOne,
				base,
				field_of(ExactlyOne, 'id')
			),
			base
		);
	});

	test('a field joins the base when the rule allows it', () => {
		const base = generate_valid_body(ExactlyOne)!;
		assert.deepEqual(
			generate_valid_object_with_field(
				object_of(ExactlyOne),
				ExactlyOne,
				base,
				field_of(ExactlyOne, 'note')
			),
			{ id: NIL, note: 'xxxxxxxxxx' }
		);
	});

	test('a paired field brings its partner', () => {
		const base = generate_valid_body(Paired)!;
		assert.deepEqual(base, { to: NIL });
		assert.deepEqual(
			generate_valid_object_with_field(
				object_of(Paired),
				Paired,
				base,
				field_of(Paired, 'scope_kind')
			),
			{ to: NIL, scope_kind: 'xxxxxxxxxx', scope_id: NIL }
		);
	});

	test("a paired field brings its partner and keeps the base's other branch", () => {
		// exactly one of `id` / `slug`, and `kind` with `scope` — the base's `id`
		// must stay, since dropping it leaves neither branch
		const Both = z
			.strictObject({
				id: z.uuid().optional(),
				slug: z.string().min(3).optional(),
				kind: z.string().optional(),
				scope: z.uuid().optional()
			})
			.refine((v) => (v.id !== undefined) !== (v.slug !== undefined))
			.refine((v) => (v.kind === undefined) === (v.scope === undefined));
		const base = generate_valid_body(Both)!;
		assert.deepEqual(base, { id: NIL });
		assert.deepEqual(
			generate_valid_object_with_field(object_of(Both), Both, base, field_of(Both, 'kind')),
			{ id: NIL, kind: 'xxxxxxxxxx', scope: NIL }
		);
	});

	test('an exactly-one-of field replaces the other branch', () => {
		const base = generate_valid_body(ExactlyOne)!;
		assert.deepEqual(
			generate_valid_object_with_field(
				object_of(ExactlyOne),
				ExactlyOne,
				base,
				field_of(ExactlyOne, 'slug')
			),
			{ slug: 'xxxxxxxxxx' }
		);
	});

	test('a field no valid object carries is null', () => {
		const base = generate_valid_body(NeverWithCode)!;
		assert.isNull(
			generate_valid_object_with_field(
				object_of(NeverWithCode),
				NeverWithCode,
				base,
				field_of(NeverWithCode, 'code')
			)
		);
	});

	test('a seeded base keeps its required values when the field replaces a branch', () => {
		const Seeded = z
			.strictObject({
				id: z.uuid().optional(),
				slug: z.string().min(3).optional(),
				count: z.number()
			})
			.refine((v) => (v.id !== undefined) !== (v.slug !== undefined));
		const base = { id: NIL, count: 7 };
		assert.deepEqual(
			generate_valid_object_with_field(object_of(Seeded), Seeded, base, field_of(Seeded, 'slug')),
			{ count: 7, slug: 'xxxxxxxxxx' }
		);
	});
});

describe('generate_input_test_cases — single-fault bodies', () => {
	test('cases on an exactly-one-of field drop the other branch', () => {
		const cases = generate_input_test_cases(ExactlyOne);
		for (const label of [
			'wrong type: slug (number instead of string)',
			'empty string: slug',
			'under minLength: slug (2 chars)',
			'over maxLength: slug (41 chars)'
		]) {
			assert.notProperty(body_of(cases, label), 'id', label);
		}
		assert.deepEqual(body_of(cases, 'over maxLength: slug (41 chars)'), {
			slug: 'x'.repeat(41)
		});
	});

	test('cases on a paired field carry its partner', () => {
		const cases = generate_input_test_cases(Paired);
		assert.deepEqual(body_of(cases, 'over maxLength: scope_kind (65 chars)'), {
			to: NIL,
			scope_kind: 'x'.repeat(65),
			scope_id: NIL
		});
		assert.deepEqual(body_of(cases, 'format: scope_id (malformed uuid)'), {
			to: NIL,
			scope_kind: 'xxxxxxxxxx',
			scope_id: 'not-a-uuid'
		});
	});

	test('a field no valid body carries gets type cases on the base and no value cases', () => {
		const cases = generate_input_test_cases(NeverWithCode);
		assert.deepEqual(
			cases_on(cases, 'code').map((c) => c.label),
			['wrong type: code (number instead of string)']
		);
		assert.deepEqual(body_of(cases, 'wrong type: code (number instead of string)'), {
			id: NIL,
			code: 42
		});
	});

	test('every per-field case of the fixtures is single-fault', () => {
		for (const input of [ExactlyOne, Paired, NeverWithCode]) {
			for (const c of generate_input_test_cases(input)) {
				if (c.field === undefined) continue;
				assert.ok(is_single_fault(input, c), `${c.label}: ${JSON.stringify(c.body)}`);
			}
		}
	});

	test("every per-field case over the spine's live mount is single-fault", () => {
		let checked = 0;
		for (const endpoint of create_spine_live_rpc_endpoints()) {
			for (const action of endpoint.actions) {
				const { method, input } = action.spec;
				for (const c of generate_input_test_cases(input, { label: method })) {
					if (c.field === undefined) continue;
					checked++;
					assert.ok(is_single_fault(input, c), `${method} ${c.label}: ${JSON.stringify(c.body)}`);
				}
			}
		}
		assert.ok(checked > 0);
	});
});

describe('generate_valid_value — two-segment path', () => {
	test('a slug of two segments is synthesized', () => {
		const Slug = z.string().regex(/^[a-z0-9]+\/[a-z0-9]+$/);
		const value = generate_valid_value(
			{ name: 'slug', base_type: 'string', required: true, has_default: false, nullable: false },
			Slug
		);
		assert.strictEqual(value, 'xxxxxxxxxx/xxxxxxxxxx');
	});
});
