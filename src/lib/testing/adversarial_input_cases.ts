import './assert_dev_env.ts';

/**
 * Schema-walk generation of adversarial inputs — payloads that must fail
 * validation.
 *
 * Focused cases: one representative wrong-type value per field, one format
 * violation per constrained field, one null and one missing case per required
 * field, plus whole-body structural attacks (non-object body, extra unknown
 * keys). Hono-free, so the cross-process suites reuse the generators the
 * in-process `describe_adversarial_input` and `describe_rpc_attack_surface_tests`
 * run.
 *
 * @module
 */

import { z } from 'zod';

import { zod_unwrap_to_object, zod_extract_fields } from '../zod.ts';
import { resolve_invalid_reason } from '../schema_meta.ts';
import { is_null_schema } from '../http/schema_helpers.ts';
import { ERROR_INVALID_REQUEST_BODY, ERROR_INVALID_JSON_BODY } from '../http/error_schemas.ts';
import {
	detect_format,
	detect_json_schema_format,
	format_zod_issues,
	generate_valid_object,
	generate_valid_object_with_field,
	generate_valid_string_param,
	to_field_json_schema
} from './schema_generators.ts';

// --- Payload generation ---

/** One wrong-type value per base type — one representative is sufficient. */
const wrong_type_for = (base_type: string): { label: string; value: unknown } | null => {
	switch (base_type) {
		case 'string':
		case 'uuid':
		case 'email':
			return { label: 'number instead of string', value: 42 };
		case 'number':
		case 'int':
			return { label: 'string instead of number', value: 'not_a_number' };
		case 'boolean':
			return { label: 'number instead of boolean', value: 42 };
		case 'array':
			return { label: 'string instead of array', value: 'not_an_array' };
		case 'object':
			return { label: 'string instead of object', value: 'not_an_object' };
		case 'enum':
			return { label: 'number instead of enum', value: 42 };
		default:
			return null;
	}
};

/** Format violation payloads — one per constraint type. */
const format_violation = (format: string): { label: string; value: string } | null => {
	switch (format) {
		case 'uuid':
			return { label: 'malformed uuid', value: 'not-a-uuid' };
		case 'email':
			return { label: 'malformed email', value: 'not-an-email' };
		case 'date-time':
			return { label: 'malformed datetime', value: 'not-a-date' };
		case 'pattern':
			return { label: 'pattern violation', value: "'; DROP TABLE --" };
		default:
			return null;
	}
};

/**
 * `value` moved by `step`, up when that stays inside the field's numeric range
 * and down otherwise — a number off the integer or `multipleOf` grid that
 * still meets the range, so the grid check is the one a refusal names.
 */
const off_grid_in_range = (json: Record<string, unknown>, value: number, step: number): number => {
	const up = value + step;
	const over =
		(typeof json.maximum === 'number' && up > json.maximum) ||
		(typeof json.exclusiveMaximum === 'number' && up >= json.exclusiveMaximum);
	return over ? value - step : up;
};

// --- Test case types ---

/** One adversarial body for an input schema, and the error code it owes. */
export interface InputTestCase {
	label: string;
	body: unknown;
	/**
	 * The one top-level field the case breaks; absent on a whole-body case (a
	 * non-object body, an extra unknown key). An RPC refusal of the case owes
	 * the field's declared `invalid_reason` (`expected_invalid_reason`).
	 */
	field?: string;
	expected_error: typeof ERROR_INVALID_REQUEST_BODY | typeof ERROR_INVALID_JSON_BODY;
}

/** One adversarial params set for a route's params schema. */
export interface ParamsTestCase {
	label: string;
	params: Record<string, string>;
}

/** One adversarial query for a route's query schema. */
export interface QueryTestCase {
	label: string;
	query: Record<string, string>;
}

// --- Input test case generation ---

/** Options for `generate_input_test_cases`. */
export interface InputTestCaseOptions {
	/**
	 * A valid body to build the cases from, in place of the generated one —
	 * for an input whose valid shape the generator can't reach, or one whose
	 * generated body the handler can't run. Each case is this body with one
	 * field broken, so it must pass the input schema itself: one that doesn't
	 * throws.
	 */
	base?: Record<string, unknown>;
	/** Names the input in error messages — the RPC method or route it belongs to. */
	label?: string;
}

/**
 * Generate adversarial test cases for a route's input schema.
 *
 * Produces focused, non-redundant cases:
 * - Whole-body: send array instead of object, extra unknown key
 * - Missing required fields (without defaults)
 * - One wrong-type value per field
 * - Null for required non-nullable fields
 * - One format violation per constrained field
 * - String length (empty, one under `minLength`, one over `maxLength`), numeric
 *   (out of range, non-integer, off a `multipleOf` grid) and array-length
 *   (empty, one under `minItems`, one over `maxItems`) boundaries
 *
 * Format and boundaries come from the field's input-side JSON Schema
 * (`to_field_json_schema`), so a field carrying a `.transform()` or pipe and a
 * `.nullable()` / `.nullish()` field get them too. A bound only a `.refine()`
 * enforces generates nothing — JSON Schema can't express it.
 *
 * Each per-field case is single-fault: valid except for the field it breaks.
 * It changes one field of a valid base body — `options.base` when given, else
 * one built by `generate_valid_object` — or, for a field that base omits, of
 * the valid body `generate_valid_object_with_field` builds around it, so a case
 * can't also break an object-level rule (adding `scope_kind` without its
 * paired `scope_id`, or `slug` beside an exactly-one-of `id`). A field no valid
 * body carries keeps its wrong-type and null cases on the base and gets no
 * format or boundary cases, which would test no bound. A per-field case is
 * emitted only when the field refuses its value, so no case is accidentally
 * valid.
 *
 * @param input_schema - the input schema to attack
 * @param options - a base body to seed the cases, and a label for errors
 * @throws Error if the base body fails `input_schema.safeParse` — a seeded
 *   base the schema refuses, or a generated one that surfaces broken
 *   generation logic — naming the issues rather than producing nonsense
 *   adversarial cases.
 */
export const generate_input_test_cases = (
	input_schema: z.ZodType,
	options?: InputTestCaseOptions
): Array<InputTestCase> => {
	if (is_null_schema(input_schema)) return [];

	const object_schema = zod_unwrap_to_object(input_schema);
	if (!object_schema) return [];

	const fields = zod_extract_fields(object_schema);
	const cases: Array<InputTestCase> = [];
	const for_label = options?.label === undefined ? '' : ` for '${options.label}'`;

	// the base object every case breaks one field of — must pass validation itself
	let base: Record<string, unknown>;
	if (options?.base) {
		base = { ...options.base };
		const base_result = input_schema.safeParse(base);
		if (!base_result.success) {
			throw new Error(
				`adversarial_input: the seeded base${for_label} fails validation — ` +
					`fix the base for: ${format_zod_issues(base_result.error)}`
			);
		}
	} else {
		const generated = generate_valid_object(object_schema, input_schema);
		if (!generated.result.success) {
			throw new Error(
				`adversarial_input: generated base object fails validation${for_label} — ` +
					`fix generate_valid_value for: ${format_zod_issues(generated.result.error)}`
			);
		}
		base = generated.value;
	}

	// whole-body structural: send array instead of object
	cases.push({
		label: 'non-object body (array)',
		body: [1, 2, 3],
		expected_error: ERROR_INVALID_JSON_BODY
	});

	// whole-body structural: extra unknown key (enforces strictObject)
	// only emit if the schema rejects unknown keys (i.e. uses z.strictObject)
	const extra_key_result = input_schema.safeParse({ ...base, __adversarial_extra: 'rejected' });
	if (!extra_key_result.success) {
		cases.push({
			label: 'extra unknown key',
			body: { ...base, __adversarial_extra: 'should_be_rejected' },
			expected_error: ERROR_INVALID_REQUEST_BODY
		});
	}

	for (const field of fields) {
		const field_schema = object_schema.shape[field.name] as z.ZodType;

		// the valid body every case on this field changes only the field of: the
		// base, or for a field the base omits, one that carries it — so the case
		// can't also break an object-level rule (exactly one of, both or neither)
		const field_base = generate_valid_object_with_field(object_schema, input_schema, base, field);

		// every per-field case breaks the field, so the field itself must refuse
		// its value — a candidate it accepts (a `z.coerce` field given a wrong
		// type, a pattern that admits the violation string) is no invalid case.
		// A type case (wrong type, null) on a field no valid body carries falls
		// back to the base; a value case — a format or a bound — is built only on
		// a body that is valid but for the field, or it tests no bound at all
		const push_field_case = (label: string, value: unknown, kind: 'type' | 'value'): void => {
			if (field_schema.safeParse(value).success) return;
			const body_base = field_base ?? (kind === 'type' ? base : null);
			if (!body_base) return;
			cases.push({
				label,
				body: { ...body_base, [field.name]: value },
				field: field.name,
				expected_error: ERROR_INVALID_REQUEST_BODY
			});
		};
		// the field's valid value the value cases start from
		const valid_value = field_base?.[field.name];

		// missing required field (skip fields with defaults — Zod fills them)
		if (field.required && !field.has_default && !field_schema.safeParse(undefined).success) {
			const without: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(base)) {
				if (k !== field.name) without[k] = v;
			}
			cases.push({
				label: `missing: ${field.name}`,
				body: without,
				field: field.name,
				expected_error: ERROR_INVALID_REQUEST_BODY
			});
		}

		// one wrong-type value
		const wrong = wrong_type_for(field.base_type);
		if (wrong) push_field_case(`wrong type: ${field.name} (${wrong.label})`, wrong.value, 'type');

		// null for required non-nullable fields
		if (field.required && !field.nullable && field.base_type !== 'null') {
			push_field_case(`null: ${field.name}`, null, 'type');
		}

		// the field's input-side JSON Schema — format, pattern and bounds, read
		// through a transform or pipe and under a nullable's `anyOf`
		const json = to_field_json_schema(field_schema);
		if (!json || !field_base) continue; // no constraints, or no body to break them on

		// format violation for constrained string fields
		const format = detect_json_schema_format(json);
		if (format) {
			const violation = format_violation(format);
			if (violation) {
				push_field_case(`format: ${field.name} (${violation.label})`, violation.value, 'value');
			}
		}

		// string length boundaries — `x`s are one UTF-16 unit and one code point
		// each, so the over-`maxLength` string is over in either count
		if (field.base_type === 'string' || field.base_type === 'uuid' || field.base_type === 'email') {
			if (typeof json.minLength === 'number' && json.minLength > 0) {
				push_field_case(`empty string: ${field.name}`, '', 'value');
			}
			// one short of the minimum, distinct from the empty string — a prefix of
			// the valid value where there is one, so a pattern it met still holds
			if (typeof json.minLength === 'number' && json.minLength > 1) {
				const under = json.minLength - 1;
				push_field_case(
					`under minLength: ${field.name} (${under} chars)`,
					typeof valid_value === 'string' && valid_value.length >= under
						? valid_value.slice(0, under)
						: 'x'.repeat(under),
					'value'
				);
			}
			if (typeof json.maxLength === 'number') {
				push_field_case(
					`over maxLength: ${field.name} (${json.maxLength + 1} chars)`,
					'x'.repeat(json.maxLength + 1),
					'value'
				);
			}
		}

		// numeric boundaries
		if (field.base_type === 'number' || field.base_type === 'int') {
			if (typeof json.minimum === 'number') {
				push_field_case(
					`below minimum: ${field.name} (${json.minimum - 1})`,
					json.minimum - 1,
					'value'
				);
			}
			if (typeof json.maximum === 'number') {
				push_field_case(
					`above maximum: ${field.name} (${json.maximum + 1})`,
					json.maximum + 1,
					'value'
				);
			}
			if (typeof json.exclusiveMinimum === 'number') {
				push_field_case(
					`at exclusive minimum: ${field.name} (${json.exclusiveMinimum})`,
					json.exclusiveMinimum,
					'value'
				);
			}
			if (typeof json.exclusiveMaximum === 'number') {
				push_field_case(
					`at exclusive maximum: ${field.name} (${json.exclusiveMaximum})`,
					json.exclusiveMaximum,
					'value'
				);
			}
			// 0 and negative for positive-only fields
			if (typeof json.minimum === 'number' && json.minimum > 0) {
				push_field_case(`zero for positive-only: ${field.name}`, 0, 'value');
				push_field_case(`negative for positive-only: ${field.name}`, -1, 'value');
			}
			// off the grid by half a step from the valid value, inside the range,
			// so the integer or `multipleOf` check is the one that refuses
			const valid_number = typeof valid_value === 'number' ? valid_value : 1;
			if (json.type === 'integer') {
				const value = off_grid_in_range(json, valid_number, 0.5);
				push_field_case(`non-integer: ${field.name} (${value})`, value, 'value');
			}
			if (typeof json.multipleOf === 'number' && json.multipleOf > 0) {
				// a whole step for an integer field, so the integer check still holds
				const step = json.type === 'integer' && json.multipleOf > 1 ? 1 : json.multipleOf / 2;
				const value = off_grid_in_range(json, valid_number, step);
				push_field_case(
					`not multipleOf: ${field.name} (${value}, multipleOf ${json.multipleOf})`,
					value,
					'value'
				);
			}
		}

		// array length boundaries
		if (field.base_type === 'array') {
			if (typeof json.minItems === 'number' && json.minItems > 0) {
				push_field_case(`empty array for minItems > 0: ${field.name}`, [], 'value');
			}
			// one short of the minimum, distinct from the empty array — the valid
			// value's own items, so only the count is wrong
			if (
				typeof json.minItems === 'number' &&
				json.minItems > 1 &&
				Array.isArray(valid_value) &&
				valid_value.length >= json.minItems - 1
			) {
				push_field_case(
					`under minItems: ${field.name} (${json.minItems - 1} items)`,
					valid_value.slice(0, json.minItems - 1),
					'value'
				);
			}
			if (typeof json.maxItems === 'number') {
				// one item over the max (items are null — schema-agnostic)
				push_field_case(
					`over maxItems: ${field.name} (${json.maxItems + 1} items)`,
					Array.from({ length: json.maxItems + 1 }, () => null),
					'value'
				);
			}
		}
	}

	return cases;
};

/**
 * The `error.data.reason` an RPC refusal of `test_case` owes: the declared
 * `invalid_reason` of the field it breaks, resolved as the dispatcher resolves
 * a failure on that field (`resolve_invalid_reason`), or `undefined` — no
 * reason — for an undeclared field or a whole-body case.
 *
 * @param input_schema - the input schema the case was generated from
 * @param test_case - a case `generate_input_test_cases` produced from it
 * @returns the owed reason, or `undefined` when the refusal carries none
 */
export const expected_invalid_reason = (
	input_schema: z.ZodType,
	test_case: InputTestCase
): string | undefined =>
	test_case.field === undefined
		? undefined
		: resolve_invalid_reason(input_schema, [test_case.field]);

// --- Params and query test case generation ---

/**
 * A valid string record for a route's params or query schema — each field the
 * string `generate_valid_string_param` finds for it — checked against the
 * whole schema, so a case changing one field breaks that field only.
 *
 * @throws Error if a field has no string it accepts, or the record fails the
 *   schema, naming the issues
 */
const generate_string_record_base = (
	schema: z.ZodObject,
	kind: 'params' | 'query'
): Record<string, string> => {
	const base: Record<string, string> = {};
	for (const field of zod_extract_fields(schema)) {
		const value = generate_valid_string_param(field, schema.shape[field.name] as z.ZodType);
		if (value === null) {
			throw new Error(`adversarial_input: no generated ${kind} value passes field '${field.name}'`);
		}
		base[field.name] = value;
	}
	const result = schema.safeParse(base);
	if (!result.success) {
		throw new Error(
			`adversarial_input: generated ${kind} base fails validation — ` +
				`fix generate_valid_string_param for: ${format_zod_issues(result.error)}`
		);
	}
	return base;
};

/**
 * Generate adversarial test cases for a route's params schema.
 *
 * Params are always strings from URL segments. Only generates cases for
 * format-constrained fields (uuid, pattern) since unconstrained string
 * params accept any string value, and only a violation the field refuses.
 * Each case breaks one field of a valid params record.
 *
 * @throws Error if no valid params record can be generated
 */
export const generate_params_test_cases = (params_schema: z.ZodObject): Array<ParamsTestCase> => {
	const fields = zod_extract_fields(params_schema);
	const cases: Array<ParamsTestCase> = [];
	const base_params = generate_string_record_base(params_schema, 'params');

	for (const field of fields) {
		const field_schema = params_schema.shape[field.name] as z.ZodType;
		const format = detect_format(field_schema);
		if (!format) continue; // unconstrained string — any value passes

		const violation = format_violation(format);
		if (violation && !field_schema.safeParse(violation.value).success) {
			cases.push({
				label: `${violation.label}: param ${field.name}`,
				params: { ...base_params, [field.name]: violation.value }
			});
		}
	}

	return cases;
};

/**
 * Generate adversarial test cases for a route's query schema.
 *
 * Query params are always strings from the URL. Generates cases for:
 * - Missing required fields the field refuses to go without (a preprocessed
 *   field with a default accepts its absence)
 * - Format violations on constrained fields (uuid, pattern) the field refuses
 *
 * Each case breaks one field of a valid query record.
 *
 * @throws Error if no valid query record can be generated
 */
export const generate_query_test_cases = (query_schema: z.ZodObject): Array<QueryTestCase> => {
	const fields = zod_extract_fields(query_schema);
	const cases: Array<QueryTestCase> = [];
	const base_query = generate_string_record_base(query_schema, 'query');

	for (const field of fields) {
		const field_schema = query_schema.shape[field.name] as z.ZodType;

		// missing required field
		if (field.required && !field.has_default && !field_schema.safeParse(undefined).success) {
			const without: Record<string, string> = {};
			for (const [k, v] of Object.entries(base_query)) {
				if (k !== field.name) without[k] = v;
			}
			cases.push({
				label: `missing query: ${field.name}`,
				query: without
			});
		}

		// format violation for constrained string fields
		const format = detect_format(field_schema);
		if (!format) continue;

		const violation = format_violation(format);
		if (violation && !field_schema.safeParse(violation.value).success) {
			cases.push({
				label: `${violation.label}: query ${field.name}`,
				query: { ...base_query, [field.name]: violation.value }
			});
		}
	}

	return cases;
};
