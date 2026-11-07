/**
 * The params and query bases — a valid string record, each field the string
 * `generate_valid_string_param` finds for it — and the query missing-field
 * filter, so every params and query case is valid but for the field it breaks.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import type { AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import {
	generate_params_test_cases,
	generate_query_test_cases
} from '#lib/testing/adversarial_input_cases.ts';
import {
	generate_valid_string_param,
	to_object_schema_view
} from '#lib/testing/schema_generators.ts';
import { ActingActor, FactHashSchema, Uuid } from '#lib/primitive_schemas.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// the URL-sourced integer `db_routes` reads its pagination through
const query_int = (min: number, max: number, fallback: number) =>
	s.with_default(
		s.pipe(
			s.pipe(s.string, s.regex(/^[+-]?\d+$/), s.transform(Number)),
			s.safe_integer,
			s.min_value(min),
			s.max_value(max)
		),
		fallback
	);

const TableRowsQuery = s.object({
	acting: ActingActor,
	offset: query_int(0, Number.MAX_SAFE_INTEGER, 0),
	limit: query_int(1, 500, 50)
});

// the generated valid string of each field of `schema`, by name
const string_param_of = (schema: AnySchema, name: string): string | null => {
	const view = to_object_schema_view(schema, 'string_param_of');
	return generate_valid_string_param(
		view.fields.find((f) => f.name === name)!,
		view.field_schema(name)!
	);
};

describe('generate_valid_string_param', () => {
	const string_of = string_param_of;

	test('a URL-sourced integer gets a numeric string', () => {
		assert.strictEqual(string_of(TableRowsQuery, 'limit'), '1');
	});

	test('a uuid gets the nil UUID, an unconstrained string test_value', () => {
		const Params = s.object({ id: Uuid, name: s.string });
		assert.strictEqual(string_of(Params, 'id'), NIL_UUID);
		assert.strictEqual(string_of(Params, 'name'), 'test_value');
	});

	test('a patterned field gets a synthesized value', () => {
		const Params = s.object({ hash: FactHashSchema });
		const value = string_of(Params, 'hash');
		assert.ok(value);
		assert.ok(s.parse(FactHashSchema, value).ok);
	});

	test('a field no candidate passes is null', () => {
		const Params = s.object({
			never: s.pipe(
				s.string,
				s.check(() => false)
			)
		});
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
			},
			{
				label: 'pattern violation: query offset',
				query: { acting: NIL_UUID, offset: "'; DROP TABLE --", limit: '1' }
			},
			{
				label: 'pattern violation: query limit',
				query: { acting: NIL_UUID, offset: '1', limit: "'; DROP TABLE --" }
			}
		]);
	});

	test('a field whose absence a default fills gets no missing case', () => {
		const labels = generate_query_test_cases(TableRowsQuery).map((c) => c.label);
		assert.notInclude(labels, 'missing query: offset');
		assert.notInclude(labels, 'missing query: limit');
	});

	test('a required field gets its missing case', () => {
		const Query = s.object({ name: s.string });
		assert.deepEqual(generate_query_test_cases(Query), [
			{ label: 'missing query: name', query: {} }
		]);
	});

	test('every query case fails the schema with its field restored valid but for it', () => {
		const Query = s.object({ cell_id: Uuid, hash: FactHashSchema });
		const cases = generate_query_test_cases(Query);
		assert.ok(cases.length > 0);
		const base: Record<string, string | null> = {
			cell_id: string_param_of(Query, 'cell_id'),
			hash: string_param_of(Query, 'hash')
		};
		for (const c of cases) {
			assert.isFalse(s.parse(Query, c.query).ok, c.label);
			// every key the case kept is the base's valid value but the broken one
			const changed = Object.keys(base).filter((k) => c.query[k] !== base[k]);
			assert.strictEqual(changed.length, 1, c.label);
		}
	});

	test('an unreachable base throws', () => {
		const Query = s.object({
			never: s.pipe(
				s.string,
				s.check(() => false)
			)
		});
		assert.throws(
			() => generate_query_test_cases(Query),
			/no generated query value passes field 'never'/
		);
	});

	test('a base its object rule refuses throws, naming the issues', () => {
		const Query = s.pipe(
			s.object({ a: s.string }),
			s.check((v) => v.a === 'only_this', 'a must be only_this')
		);
		assert.throws(
			() => generate_query_test_cases(Query),
			/generated query base fails validation.*a must be only_this/
		);
	});
});

describe('generate_params_test_cases — valid base', () => {
	test('a format case on one param carries a valid value for the other', () => {
		const Params = s.object({ cell_id: Uuid, hash: FactHashSchema });
		const cases = generate_params_test_cases(Params);
		const cell_case = cases.find((c) => c.label === 'malformed uuid: param cell_id');
		assert.ok(cell_case);
		assert.ok(s.parse(FactHashSchema, cell_case.params.hash).ok);
	});
});
