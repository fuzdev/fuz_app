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
import { detect_format, format_zod_issues, generate_valid_object } from './schema_generators.ts';

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
 *
 * Each case breaks one field of a valid base body: `options.base` when given,
 * else one built by `generate_valid_object`.
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

		// missing required field (skip fields with defaults — Zod fills them)
		if (field.required && !field.has_default) {
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
		if (wrong) {
			cases.push({
				label: `wrong type: ${field.name} (${wrong.label})`,
				body: { ...base, [field.name]: wrong.value },
				field: field.name,
				expected_error: ERROR_INVALID_REQUEST_BODY
			});
		}

		// null for required non-nullable fields
		if (field.required && !field.nullable && field.base_type !== 'null') {
			cases.push({
				label: `null: ${field.name}`,
				body: { ...base, [field.name]: null },
				field: field.name,
				expected_error: ERROR_INVALID_REQUEST_BODY
			});
		}

		// format violation for constrained string fields
		const format = detect_format(field_schema);
		if (format) {
			const violation = format_violation(format);
			if (violation) {
				cases.push({
					label: `format: ${field.name} (${violation.label})`,
					body: { ...base, [field.name]: violation.value },
					field: field.name,
					expected_error: ERROR_INVALID_REQUEST_BODY
				});
			}
		}

		// --- Boundary cases via JSON Schema introspection ---
		try {
			const json = z.toJSONSchema(field_schema) as Record<string, unknown>;

			// string length boundaries
			if (
				field.base_type === 'string' ||
				field.base_type === 'uuid' ||
				field.base_type === 'email'
			) {
				if (typeof json.minLength === 'number' && json.minLength > 0) {
					cases.push({
						label: `empty string: ${field.name}`,
						body: { ...base, [field.name]: '' },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
				if (typeof json.maxLength === 'number') {
					cases.push({
						label: `over maxLength: ${field.name} (${json.maxLength + 1} chars)`,
						body: { ...base, [field.name]: 'x'.repeat(json.maxLength + 1) },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
			}

			// numeric boundaries
			if (field.base_type === 'number' || field.base_type === 'int') {
				if (typeof json.minimum === 'number') {
					cases.push({
						label: `below minimum: ${field.name} (${json.minimum - 1})`,
						body: { ...base, [field.name]: json.minimum - 1 },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
				if (typeof json.maximum === 'number') {
					cases.push({
						label: `above maximum: ${field.name} (${json.maximum + 1})`,
						body: { ...base, [field.name]: json.maximum + 1 },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
				if (typeof json.exclusiveMinimum === 'number') {
					cases.push({
						label: `at exclusive minimum: ${field.name} (${json.exclusiveMinimum})`,
						body: { ...base, [field.name]: json.exclusiveMinimum },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
				if (typeof json.exclusiveMaximum === 'number') {
					cases.push({
						label: `at exclusive maximum: ${field.name} (${json.exclusiveMaximum})`,
						body: { ...base, [field.name]: json.exclusiveMaximum },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
				// 0 and negative for positive-only fields
				if (typeof json.minimum === 'number' && json.minimum > 0) {
					cases.push({
						label: `zero for positive-only: ${field.name}`,
						body: { ...base, [field.name]: 0 },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
					cases.push({
						label: `negative for positive-only: ${field.name}`,
						body: { ...base, [field.name]: -1 },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
			}

			// array length boundaries
			if (field.base_type === 'array') {
				if (typeof json.minItems === 'number' && json.minItems > 0) {
					cases.push({
						label: `empty array for minItems > 0: ${field.name}`,
						body: { ...base, [field.name]: [] },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
				if (typeof json.maxItems === 'number') {
					// generate an array one item over the max (items are null — schema-agnostic)
					cases.push({
						label: `over maxItems: ${field.name} (${json.maxItems + 1} items)`,
						body: { ...base, [field.name]: Array.from({ length: json.maxItems + 1 }, () => null) },
						field: field.name,
						expected_error: ERROR_INVALID_REQUEST_BODY
					});
				}
			}
		} catch {
			// schema can't be converted to JSON Schema, skip boundary cases
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

// --- Params test case generation ---

/**
 * Generate adversarial test cases for a route's params schema.
 *
 * Params are always strings from URL segments. Only generates cases for
 * format-constrained fields (uuid, pattern) since unconstrained string
 * params accept any string value.
 */
export const generate_params_test_cases = (params_schema: z.ZodObject): Array<ParamsTestCase> => {
	const fields = zod_extract_fields(params_schema);
	const cases: Array<ParamsTestCase> = [];

	// build base params with valid-ish values
	const base_params: Record<string, string> = {};
	for (const field of fields) {
		const field_schema = params_schema.shape[field.name] as z.ZodType;
		const format = detect_format(field_schema);
		if (format === 'uuid' || field.base_type === 'uuid') {
			base_params[field.name] = '00000000-0000-0000-0000-000000000000';
		} else {
			base_params[field.name] = 'test_value';
		}
	}

	for (const field of fields) {
		const field_schema = params_schema.shape[field.name] as z.ZodType;
		const format = detect_format(field_schema);
		if (!format) continue; // unconstrained string — any value passes

		const violation = format_violation(format);
		if (violation) {
			cases.push({
				label: `${violation.label}: param ${field.name}`,
				params: { ...base_params, [field.name]: violation.value }
			});
		}
	}

	return cases;
};

// --- Query test case generation ---

/**
 * Generate adversarial test cases for a route's query schema.
 *
 * Query params are always strings from the URL. Generates cases for:
 * - Missing required fields
 * - Format violations on constrained fields (uuid, pattern)
 */
export const generate_query_test_cases = (query_schema: z.ZodObject): Array<QueryTestCase> => {
	const fields = zod_extract_fields(query_schema);
	const cases: Array<QueryTestCase> = [];

	// build base query with valid-ish values
	const base_query: Record<string, string> = {};
	for (const field of fields) {
		const field_schema = query_schema.shape[field.name] as z.ZodType;
		const format = detect_format(field_schema);
		if (format === 'uuid' || field.base_type === 'uuid') {
			base_query[field.name] = '00000000-0000-0000-0000-000000000000';
		} else {
			base_query[field.name] = 'test_value';
		}
	}

	for (const field of fields) {
		// missing required field
		if (field.required && !field.has_default) {
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
		const field_schema = query_schema.shape[field.name] as z.ZodType;
		const format = detect_format(field_schema);
		if (!format) continue;

		const violation = format_violation(format);
		if (violation) {
			cases.push({
				label: `${violation.label}: query ${field.name}`,
				query: { ...base_query, [field.name]: violation.value }
			});
		}
	}

	return cases;
};
