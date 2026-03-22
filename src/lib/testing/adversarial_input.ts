import './assert_dev_env.js';

/**
 * Adversarial input validation testing for route specs.
 *
 * Walks Zod schemas directly to generate payloads that must fail validation.
 * Fires requests against a test app and asserts 400 responses before handlers
 * are reached.
 *
 * Tests are focused: one representative wrong-type value per field, one format
 * violation per constrained field, one null and one missing test per required
 * field, plus whole-body structural attacks (non-object body, extra unknown keys).
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import {z} from 'zod';
import {zod_unwrap_to_object, zod_extract_fields} from '@fuzdev/fuz_util/zod.js';

import type {RouteSpec} from '../http/route_spec.js';
import {is_null_schema} from '../http/schema_helpers.js';
import {
	filter_routes_with_input,
	filter_routes_with_params,
	filter_routes_with_query,
} from '../http/surface_query.js';
import {
	ValidationError,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_INVALID_QUERY_PARAMS,
} from '../http/error_schemas.js';
import {create_auth_test_apps, select_auth_app} from './auth_apps.js';
import type {AdversarialTestOptions} from './attack_surface.js';
import {detect_format, generate_valid_value, resolve_valid_path} from './schema_generators.js';

// --- Payload generation ---

/** One wrong-type value per base type — one representative is sufficient. */
const wrong_type_for = (base_type: string): {label: string; value: unknown} | null => {
	switch (base_type) {
		case 'string':
		case 'uuid':
		case 'email':
			return {label: 'number instead of string', value: 42};
		case 'number':
		case 'int':
			return {label: 'string instead of number', value: 'not_a_number'};
		case 'boolean':
			return {label: 'number instead of boolean', value: 42};
		case 'array':
			return {label: 'string instead of array', value: 'not_an_array'};
		case 'object':
			return {label: 'string instead of object', value: 'not_an_object'};
		case 'enum':
			return {label: 'number instead of enum', value: 42};
		default:
			return null;
	}
};

/** Format violation payloads — one per constraint type. */
const format_violation = (format: string): {label: string; value: string} | null => {
	switch (format) {
		case 'uuid':
			return {label: 'malformed uuid', value: 'not-a-uuid'};
		case 'email':
			return {label: 'malformed email', value: 'not-an-email'};
		case 'date-time':
			return {label: 'malformed datetime', value: 'not-a-date'};
		case 'pattern':
			return {label: 'pattern violation', value: "'; DROP TABLE --"};
		default:
			return null;
	}
};

// --- Test case types ---

interface InputTestCase {
	label: string;
	body: unknown;
	expected_error: typeof ERROR_INVALID_REQUEST_BODY | typeof ERROR_INVALID_JSON_BODY;
}

interface ParamsTestCase {
	label: string;
	params: Record<string, string>;
}

interface QueryTestCase {
	label: string;
	query: Record<string, string>;
}

// --- Input test case generation ---

/**
 * Generate adversarial test cases for a route's input schema.
 *
 * Produces focused, non-redundant cases:
 * - Whole-body: send array instead of object, extra unknown key
 * - Missing required fields (without defaults)
 * - One wrong-type value per field
 * - Null for required non-nullable fields
 * - One format violation per constrained field
 */
export const generate_input_test_cases = (input_schema: z.ZodType): Array<InputTestCase> => {
	if (is_null_schema(input_schema)) return [];

	const object_schema = zod_unwrap_to_object(input_schema);
	if (!object_schema) return [];

	const fields = zod_extract_fields(object_schema);
	const cases: Array<InputTestCase> = [];

	// build a base object with valid-ish values — must pass validation itself
	// skip optional fields without defaults to avoid generating invalid nested values
	const base: Record<string, unknown> = {};
	for (const field of fields) {
		if (!field.required && !field.has_default) continue;
		base[field.name] = generate_valid_value(field, object_schema.shape[field.name] as z.ZodType);
	}
	const base_result = input_schema.safeParse(base);
	if (!base_result.success) {
		throw new Error(
			`adversarial_input: generated base object fails validation for schema — ` +
				`fix generate_valid_value for: ${base_result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
		);
	}

	// whole-body structural: send array instead of object
	cases.push({
		label: 'non-object body (array)',
		body: [1, 2, 3],
		expected_error: ERROR_INVALID_JSON_BODY,
	});

	// whole-body structural: extra unknown key (enforces strictObject)
	// only emit if the schema rejects unknown keys (i.e. uses z.strictObject)
	const extra_key_result = input_schema.safeParse({...base, __adversarial_extra: 'rejected'});
	if (!extra_key_result.success) {
		cases.push({
			label: 'extra unknown key',
			body: {...base, __adversarial_extra: 'should_be_rejected'},
			expected_error: ERROR_INVALID_REQUEST_BODY,
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
				expected_error: ERROR_INVALID_REQUEST_BODY,
			});
		}

		// one wrong-type value
		const wrong = wrong_type_for(field.base_type);
		if (wrong) {
			cases.push({
				label: `wrong type: ${field.name} (${wrong.label})`,
				body: {...base, [field.name]: wrong.value},
				expected_error: ERROR_INVALID_REQUEST_BODY,
			});
		}

		// null for required non-nullable fields
		if (field.required && !field.nullable && field.base_type !== 'null') {
			cases.push({
				label: `null: ${field.name}`,
				body: {...base, [field.name]: null},
				expected_error: ERROR_INVALID_REQUEST_BODY,
			});
		}

		// format violation for constrained string fields
		const format = detect_format(field_schema);
		if (format) {
			const violation = format_violation(format);
			if (violation) {
				cases.push({
					label: `format: ${field.name} (${violation.label})`,
					body: {...base, [field.name]: violation.value},
					expected_error: ERROR_INVALID_REQUEST_BODY,
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
						body: {...base, [field.name]: ''},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
				if (typeof json.maxLength === 'number') {
					cases.push({
						label: `over maxLength: ${field.name} (${json.maxLength + 1} chars)`,
						body: {...base, [field.name]: 'x'.repeat(json.maxLength + 1)},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
			}

			// numeric boundaries
			if (field.base_type === 'number' || field.base_type === 'int') {
				if (typeof json.minimum === 'number') {
					cases.push({
						label: `below minimum: ${field.name} (${json.minimum - 1})`,
						body: {...base, [field.name]: json.minimum - 1},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
				if (typeof json.maximum === 'number') {
					cases.push({
						label: `above maximum: ${field.name} (${json.maximum + 1})`,
						body: {...base, [field.name]: json.maximum + 1},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
				if (typeof json.exclusiveMinimum === 'number') {
					cases.push({
						label: `at exclusive minimum: ${field.name} (${json.exclusiveMinimum})`,
						body: {...base, [field.name]: json.exclusiveMinimum},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
				if (typeof json.exclusiveMaximum === 'number') {
					cases.push({
						label: `at exclusive maximum: ${field.name} (${json.exclusiveMaximum})`,
						body: {...base, [field.name]: json.exclusiveMaximum},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
				// 0 and negative for positive-only fields
				if (typeof json.minimum === 'number' && json.minimum > 0) {
					cases.push({
						label: `zero for positive-only: ${field.name}`,
						body: {...base, [field.name]: 0},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
					cases.push({
						label: `negative for positive-only: ${field.name}`,
						body: {...base, [field.name]: -1},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
			}

			// array length boundaries
			if (field.base_type === 'array') {
				if (typeof json.minItems === 'number' && json.minItems > 0) {
					cases.push({
						label: `empty array for minItems > 0: ${field.name}`,
						body: {...base, [field.name]: []},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
				if (typeof json.maxItems === 'number') {
					// generate an array one item over the max (items are null — schema-agnostic)
					cases.push({
						label: `over maxItems: ${field.name} (${json.maxItems + 1} items)`,
						body: {...base, [field.name]: Array.from({length: json.maxItems + 1}, () => null)},
						expected_error: ERROR_INVALID_REQUEST_BODY,
					});
				}
			}
		} catch {
			// schema can't be converted to JSON Schema, skip boundary cases
		}
	}

	return cases;
};

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
				params: {...base_params, [field.name]: violation.value},
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
				query: without,
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
				query: {...base_query, [field.name]: violation.value},
			});
		}
	}

	return cases;
};

// --- URL helpers ---

/** Build a URL path with adversarial param values. */
const build_fuzz_url = (route_path: string, params: Record<string, string>): string => {
	let url = route_path;
	for (const [key, value] of Object.entries(params)) {
		url = url.replace(`:${key}`, encodeURIComponent(value));
	}
	return url;
};

/** Build a URL with query string parameters. */
const build_query_url = (path: string, query: Record<string, string>): string => {
	const search = new URLSearchParams(query).toString();
	return search ? `${path}?${search}` : path;
};

// --- Test runner ---

/**
 * Generate adversarial input validation test suites.
 *
 * Tests input body validation and params validation for all routes.
 * Uses correct auth credentials so auth guards pass and validation
 * middleware is actually exercised.
 *
 * @param options - the test configuration
 */
export const describe_adversarial_input = (options: AdversarialTestOptions): void => {
	const {build, roles} = options;
	const {surface, route_specs} = build();

	const routes_with_input = filter_routes_with_input(surface);
	const routes_with_params = filter_routes_with_params(surface);
	const routes_with_query = filter_routes_with_query(surface);

	if (
		routes_with_input.length === 0 &&
		routes_with_params.length === 0 &&
		routes_with_query.length === 0
	)
		return;

	// lookup RouteSpec by method+path for Zod schema access
	const spec_lookup: Map<string, RouteSpec> = new Map();
	for (const spec of route_specs) {
		spec_lookup.set(`${spec.method} ${spec.path}`, spec);
	}

	const apps = create_auth_test_apps(route_specs, roles);

	describe('adversarial input validation', () => {
		// --- Input body tests ---

		if (routes_with_input.length > 0) {
			// every surface route with input must have a matching RouteSpec
			const missing_specs = routes_with_input
				.map((r) => `${r.method} ${r.path}`)
				.filter((key) => !spec_lookup.has(key));
			if (missing_specs.length > 0) {
				throw new Error(
					`adversarial_input: surface routes with input have no matching RouteSpec: ${missing_specs.join(', ')}`,
				);
			}

			let input_test_count = 0;

			describe('input body', () => {
				for (const route of routes_with_input) {
					const key = `${route.method} ${route.path}`;
					const spec = spec_lookup.get(key)!;

					const test_cases = generate_input_test_cases(spec.input);
					if (test_cases.length === 0) continue;
					input_test_count += test_cases.length;

					const app = select_auth_app(apps, route.auth);
					const url = resolve_valid_path(route.path, spec.params);

					describe(key, () => {
						for (const tc of test_cases) {
							test(tc.label, async () => {
								const res = await app.request(url, {
									method: route.method,
									headers: {'Content-Type': 'application/json'},
									body: JSON.stringify(tc.body),
								});
								assert.strictEqual(
									res.status,
									400,
									`Expected 400 for ${key} [${tc.label}], got ${res.status}`,
								);
								const body = await res.json();
								assert.strictEqual(
									body.error,
									tc.expected_error,
									`Expected ${tc.expected_error} for ${key} [${tc.label}], got: ${body.error}`,
								);
								// validate response body structure matches error schema
								if (tc.expected_error === 'invalid_request_body') {
									ValidationError.parse(body);
								}
							});
						}
					});
				}

				test('generated input test cases', () => {
					assert.ok(
						input_test_count > 0,
						'No input test cases generated — schema walking may be broken',
					);
				});
			});
		}

		// --- Params tests ---

		if (routes_with_params.length > 0) {
			let params_test_count = 0;

			describe('params', () => {
				for (const route of routes_with_params) {
					const key = `${route.method} ${route.path}`;
					const spec = spec_lookup.get(key);
					if (!spec?.params) continue;

					const test_cases = generate_params_test_cases(spec.params);
					if (test_cases.length === 0) continue;
					params_test_count += test_cases.length;

					const app = select_auth_app(apps, route.auth);

					describe(key, () => {
						for (const tc of test_cases) {
							test(tc.label, async () => {
								const url = build_fuzz_url(route.path, tc.params);
								const res = await app.request(url, {method: route.method});
								assert.strictEqual(
									res.status,
									400,
									`Expected 400 for ${key} [${tc.label}], got ${res.status}`,
								);
								const body = await res.json();
								assert.strictEqual(
									body.error,
									ERROR_INVALID_ROUTE_PARAMS,
									`Expected ${ERROR_INVALID_ROUTE_PARAMS} for ${key} [${tc.label}], got: ${body.error}`,
								);
								// validate response body structure matches error schema
								ValidationError.parse(body);
							});
						}
					});
				}

				// params coverage check is softer — not all param routes have format constraints
				if (params_test_count === 0) {
					test('no params test cases generated (all params unconstrained)', () => {
						// informational — unconstrained string params accept any value
						assert.ok(true);
					});
				}
			});
		}

		// --- Query tests ---

		if (routes_with_query.length > 0) {
			let query_test_count = 0;

			describe('query params', () => {
				for (const route of routes_with_query) {
					const key = `${route.method} ${route.path}`;
					const spec = spec_lookup.get(key);
					if (!spec?.query) continue;

					const test_cases = generate_query_test_cases(spec.query);
					if (test_cases.length === 0) continue;
					query_test_count += test_cases.length;

					const app = select_auth_app(apps, route.auth);
					const base_url = resolve_valid_path(route.path, spec.params);

					describe(key, () => {
						for (const tc of test_cases) {
							test(tc.label, async () => {
								const url = build_query_url(base_url, tc.query);
								const res = await app.request(url, {method: route.method});
								assert.strictEqual(
									res.status,
									400,
									`Expected 400 for ${key} [${tc.label}], got ${res.status}`,
								);
								const body = await res.json();
								assert.strictEqual(
									body.error,
									ERROR_INVALID_QUERY_PARAMS,
									`Expected ${ERROR_INVALID_QUERY_PARAMS} for ${key} [${tc.label}], got: ${body.error}`,
								);
								// validate response body structure matches error schema
								ValidationError.parse(body);
							});
						}
					});
				}

				// query coverage check is softer — not all query routes have format constraints
				if (query_test_count === 0) {
					test('no query test cases generated (all query params unconstrained)', () => {
						// informational — unconstrained string query params accept any value
						assert.ok(true);
					});
				}
			});
		}
	});
};
