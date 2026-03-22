import './assert_dev_env.js';

/**
 * Schema-driven value generation helpers for testing.
 *
 * Walks Zod schemas to generate valid values for route params, request bodies,
 * and URL paths. Used by adversarial input, adversarial 404, and round-trip
 * validation test suites.
 *
 * @module
 */

import {z} from 'zod';
import {
	zod_unwrap_def,
	zod_get_base_type,
	zod_unwrap_to_object,
	zod_extract_fields,
	type ZodFieldInfo,
} from '@fuzdev/fuz_util/zod.js';

import {is_null_schema} from '../http/schema_helpers.js';

/**
 * Detect format constraints on a field by converting to JSON Schema.
 * Returns format string (e.g. 'uuid', 'email') or null.
 */
export const detect_format = (field_schema: z.ZodType): string | null => {
	try {
		const json = z.toJSONSchema(field_schema) as Record<string, unknown>;
		if (typeof json.format === 'string') return json.format;
		if (typeof json.pattern === 'string') return 'pattern';
	} catch {
		// schema can't be converted, no format
	}
	return null;
};

/** Generate a string that satisfies minLength/maxLength constraints via JSON Schema. */
const generate_valid_string = (field_schema: z.ZodType): string => {
	let min_length = 0;
	let max_length = Infinity;
	try {
		const json = z.toJSONSchema(field_schema) as Record<string, unknown>;
		if (typeof json.minLength === 'number') min_length = json.minLength;
		if (typeof json.maxLength === 'number') max_length = json.maxLength;
	} catch {
		// no constraints
	}
	const target = Math.max(min_length, Math.min(10, max_length));
	return 'x'.repeat(target) || 'test_value';
};

/** Generate a valid-ish value for a field based on its base type. */
export const generate_valid_value = (field: ZodFieldInfo, field_schema: z.ZodType): unknown => {
	const format = detect_format(field_schema);
	switch (field.base_type) {
		case 'uuid':
			return '00000000-0000-0000-0000-000000000000';
		case 'email':
			return 'test@example.com';
		case 'string':
			if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
			if (format === 'email') return 'test@example.com';
			return generate_valid_string(field_schema);
		case 'number':
		case 'int':
			return 1;
		case 'boolean':
			return true;
		case 'array':
			return [];
		case 'object':
			return {};
		case 'null':
			return null;
		case 'enum': {
			const enum_def = zod_unwrap_def(field_schema);
			if ('entries' in enum_def) {
				const entries = (enum_def as {entries: unknown}).entries;
				// Zod 4 enum entries is an object {key: value}, not an array
				if (entries && typeof entries === 'object') {
					const values = Object.values(entries as Record<string, unknown>);
					if (values.length > 0) return values[0];
				}
			}
			return 'test';
		}
		default:
			return 'test_value';
	}
};

/**
 * Resolve a route path with valid-ish param values so params validation passes.
 * Used when testing input on routes that also have params.
 */
export const resolve_valid_path = (path: string, params_schema?: z.ZodObject): string => {
	if (!params_schema) {
		return path.replace(/:(\w+)/g, 'test_$1');
	}
	return path.replace(/:(\w+)/g, (_match, name) => {
		const field_schema = params_schema.shape[name] as z.ZodType | undefined;
		if (!field_schema) return `test_${name}`;
		const base_type = zod_get_base_type(field_schema);
		if (base_type === 'uuid') return '00000000-0000-0000-0000-000000000000';
		const format = detect_format(field_schema);
		if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
		return `test_${name}`;
	});
};

/**
 * Generate a valid request body for a route's input schema.
 *
 * Returns `undefined` for null schemas or schemas that can't be unwrapped to objects.
 * Throws if the generated body fails validation — catches broken generation logic
 * early with a descriptive error instead of a confusing 400 in downstream tests.
 */
export const generate_valid_body = (
	input_schema: z.ZodType,
): Record<string, unknown> | undefined => {
	if (is_null_schema(input_schema)) return undefined;
	const object_schema = zod_unwrap_to_object(input_schema);
	if (!object_schema) return undefined;
	const fields = zod_extract_fields(object_schema);
	const body: Record<string, unknown> = {};
	for (const field of fields) {
		if (!field.required && !field.has_default) continue;
		body[field.name] = generate_valid_value(field, object_schema.shape[field.name] as z.ZodType);
	}
	const result = input_schema.safeParse(body);
	if (!result.success) {
		throw new Error(
			`generate_valid_body: generated body fails validation — ` +
				`fix generate_valid_value for: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
		);
	}
	return body;
};
