/**
 * The params and query bases — a valid string record, each field the string
 * `generate_valid_string_param` finds for it — and the query missing-field
 * filter, so every params and query case is valid but for the field it breaks.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import {
	generate_params_test_cases,
	generate_query_test_cases
} from '#lib/testing/adversarial_input_cases.ts';
import { generate_valid_string_param } from '#lib/testing/schema_generators.ts';
import { zod_extract_fields } from '#lib/zod.ts';
import { ActingActor } from '#lib/http/auth_shape.ts';
import { FactHashSchema, Uuid } from '#lib/primitive_schemas.ts';

// the URL-sourced integer `db_routes` reads its pagination through
const query_int = (bounds: z.ZodNumber, fallback: number) =>
	z.preprocess(
		(v) =>
			v === undefined
				? undefined
				: typeof v === 'string' && /^[+-]?\d+$/.test(v)
					? Number(v)
					: Number.NaN,
		bounds.default(fallback)
	);

const TableRowsQuery = z.strictObject({
	acting: ActingActor,
	offset: query_int(z.number().int().min(0), 0),
	limit: query_int(z.number().int().min(1).max(500), 50)
});

describe('generate_valid_string_param', () => {
	const string_of = (schema: z.ZodObject, name: string): string | null =>
		generate_valid_string_param(
			zod_extract_fields(schema).find((f) => f.name === name)!,
			schema.shape[name] as z.ZodType
		);

	test('a URL-sourced integer gets a numeric string', () => {
		assert.strictEqual(string_of(TableRowsQuery, 'limit'), '1');
	});

	test('a URL-sourced number with a minimum above one gets its default or its lower bound', () => {
		const to_number = (bounds: z.ZodNumber) =>
			z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), bounds);
		const Query = z.strictObject({
			defaulted: query_int(z.number().int().min(5).max(500), 50),
			bounded: to_number(z.number().int().min(7)),
			fractional: to_number(z.number().min(2.5)),
			exclusive: to_number(z.number().int().gt(5.5))
		});
		assert.strictEqual(string_of(Query, 'defaulted'), '50');
		assert.strictEqual(string_of(Query, 'bounded'), '7');
		assert.strictEqual(string_of(Query, 'fractional'), '3');
		assert.strictEqual(string_of(Query, 'exclusive'), '6');
	});

	test('a uuid gets the nil UUID, an unconstrained string test_value', () => {
		const Params = z.strictObject({ id: Uuid, name: z.string() });
		assert.strictEqual(string_of(Params, 'id'), '00000000-0000-0000-0000-000000000000');
		assert.strictEqual(string_of(Params, 'name'), 'test_value');
	});

	test('a patterned field gets a synthesized value', () => {
		const Params = z.strictObject({ hash: FactHashSchema });
		const value = string_of(Params, 'hash');
		assert.ok(value);
		assert.ok(FactHashSchema.safeParse(value).success);
	});

	test('a field no candidate passes is null', () => {
		const Params = z.strictObject({ never: z.string().refine(() => false) });
		assert.isNull(string_of(Params, 'never'));
	});
});

describe('generate_query_test_cases — valid base', () => {
	test('the query base passes the schema, so a case breaks only its field', () => {
		const cases = generate_query_test_cases(TableRowsQuery);
		assert.deepEqual(cases, [
			{
				label: 'malformed uuid: query acting',
				query: { acting: 'not-a-uuid', offset: '1', limit: '1' }
			}
		]);
	});

	test('a field whose absence a default fills gets no missing case', () => {
		const labels = generate_query_test_cases(TableRowsQuery).map((c) => c.label);
		assert.notInclude(labels, 'missing query: offset');
		assert.notInclude(labels, 'missing query: limit');
	});

	test('a required field gets its missing case', () => {
		const Query = z.strictObject({ name: z.string() });
		assert.deepEqual(generate_query_test_cases(Query), [
			{ label: 'missing query: name', query: {} }
		]);
	});

	test('every query case fails the schema with its field restored valid but for it', () => {
		const Query = z.strictObject({ cell_id: Uuid, hash: FactHashSchema });
		const cases = generate_query_test_cases(Query);
		assert.ok(cases.length > 0);
		const base = Object.fromEntries(
			zod_extract_fields(Query).map((f) => [
				f.name,
				generate_valid_string_param(f, (Query.shape as Record<string, z.ZodType>)[f.name]!)
			])
		);
		for (const c of cases) {
			assert.isFalse(Query.safeParse(c.query).success, c.label);
			// every key the case kept is the base's valid value but the broken one
			const changed = Object.keys(base).filter((k) => c.query[k] !== base[k]);
			assert.strictEqual(changed.length, 1, c.label);
		}
	});

	test('an unreachable base throws', () => {
		const Query = z.strictObject({ never: z.string().refine(() => false) });
		assert.throws(
			() => generate_query_test_cases(Query),
			/no generated query value passes field 'never'/
		);
	});

	test('a base its object rule refuses throws, naming the issues', () => {
		const Query = z
			.strictObject({ a: z.string() })
			.refine((v) => v.a === 'only_this', { message: 'a must be only_this' });
		assert.throws(
			() => generate_query_test_cases(Query),
			/generated query base fails validation.*a must be only_this/
		);
	});
});

describe('generate_params_test_cases — valid base', () => {
	test('a format case on one param carries a valid value for the other', () => {
		const Params = z.strictObject({ cell_id: Uuid, hash: FactHashSchema });
		const cases = generate_params_test_cases(Params);
		const cell_case = cases.find((c) => c.label === 'malformed uuid: param cell_id');
		assert.ok(cell_case);
		assert.ok(FactHashSchema.safeParse(cell_case.params.hash).success);
	});
});
