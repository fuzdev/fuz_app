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
		// `.nullish()` / `.nullable()` produce `anyOf: [{format, …}, {type: 'null'}]`
		// — descend into the first non-null branch so format/pattern surface.
		if (Array.isArray(json.anyOf)) {
			for (const branch of json.anyOf as Array<Record<string, unknown>>) {
				if (branch.type === 'null') continue;
				if (typeof branch.format === 'string') return branch.format;
				if (typeof branch.pattern === 'string') return 'pattern';
			}
		}
	} catch {
		// schema can't be converted, no format
	}
	return null;
};

/**
 * Extract a candidate value from a JSON Schema `pattern` when the shape is
 * a fixed-length hex character class — covers blake3 (64-char lowercase hex),
 * sha256, md5, and similar digest refinements. Returns `null` when the
 * pattern doesn't match the expected shape.
 */
const generate_hex_pattern_value = (pattern: string): string | null => {
	const match = /^\^\[0-9a-f(?:A-F)?\]\{(\d+)\}\$$/.exec(pattern);
	if (!match) return null;
	const n = Number(match[1]);
	if (!Number.isInteger(n) || n <= 0) return null;
	return '0'.repeat(n);
};

/**
 * Extract a candidate value from a JSON Schema `pattern` when the shape is a
 * prefix-lengthed slug — a fixed literal prefix followed by `_` and a
 * base64url-style character class of fixed length. Covers `ApiTokenId`
 * (`tok_[A-Za-z0-9_-]{12}`) and any similarly-shaped branded id.
 *
 * Returns the prefix followed by the right number of `x` characters (which
 * satisfy every base64url-style character class). Returns `null` when the
 * pattern doesn't match the expected shape.
 *
 * Coverage today:
 * - Prefix must start with a letter and be alphanumeric (e.g. `tok_`, `ses_`).
 * - Character class must be exactly `[A-Za-z0-9_-]` (Zod passes the regex
 *   source through verbatim — no character-class reordering).
 * - Fixed-length quantifier `{N}`.
 *
 * Known gaps (will fall through to the absolute-path / URL candidates or
 * the base `xxxxxxxxxx` string — may or may not satisfy the refinement):
 * - Digit-only classes (e.g. `^ord_\d{8}$`) — `x`-fill fails.
 * - Base64 with `+/=` (e.g. `^b64_[A-Za-z0-9+/=]{N}$`) — character class
 *   doesn't match the detection regex. `x`-fill would still satisfy the
 *   refinement if the detection were widened.
 * - No-prefix fixed-length slugs (e.g. `^[A-Za-z0-9_-]{43}$` — daemon
 *   token shape) are not matched here; see `generate_hex_pattern_value`
 *   for the hex variant.
 * Widen the detection regex when a new branded shape surfaces.
 */
const generate_prefix_slug_pattern_value = (pattern: string): string | null => {
	const match = /^\^([A-Za-z][A-Za-z0-9]*)_\[A-Za-z0-9_-\]\{(\d+)\}\$$/.exec(pattern);
	if (!match) return null;
	const prefix = match[1]!;
	const n = Number(match[2]);
	if (!Number.isInteger(n) || n <= 0) return null;
	return `${prefix}_${'x'.repeat(n)}`;
};

/** Generate a string that satisfies minLength/maxLength/pattern constraints via JSON Schema. */
const generate_valid_string = (field_schema: z.ZodType): string => {
	let min_length = 0;
	let max_length = Infinity;
	let pattern: string | null = null;
	try {
		const json = z.toJSONSchema(field_schema) as Record<string, unknown>;
		if (typeof json.minLength === 'number') min_length = json.minLength;
		if (typeof json.maxLength === 'number') max_length = json.maxLength;
		if (typeof json.pattern === 'string') pattern = json.pattern;
	} catch {
		// no constraints
	}
	const target = Math.max(min_length, Math.min(10, max_length));
	const base = 'x'.repeat(target) || 'test_value';

	// Validate against the full schema (including refinements/brands).
	// If the base string fails, try common patterns before giving up.
	if (field_schema.safeParse(base).success) return base;

	// Fixed-length hex refinement (blake3, sha256, etc.)
	if (pattern) {
		const hex = generate_hex_pattern_value(pattern);
		if (hex !== null && field_schema.safeParse(hex).success) return hex;
	}

	// Prefix-lengthed slug refinement (e.g. ApiTokenId: tok_[A-Za-z0-9_-]{12})
	if (pattern) {
		const slug = generate_prefix_slug_pattern_value(pattern);
		if (slug !== null && field_schema.safeParse(slug).success) return slug;
	}

	// Email-shaped refinement (the `Email` primitive: loose `local@domain.tld`).
	// The base `x`-fill has no `@`, so an email-pattern field needs a shaped
	// candidate — the `z.string().regex()` form exposes a `pattern`, not the
	// `format: 'email'` the `case 'email'` switch arm keys on.
	const as_email = 'test@example.com';
	if (field_schema.safeParse(as_email).success) return as_email;

	// Absolute path refinement (e.g. DiskfilePath)
	const with_slash = '/' + base;
	if (field_schema.safeParse(with_slash).success) return with_slash;

	// URL refinement
	const as_url = 'https://example.com/' + base;
	if (field_schema.safeParse(as_url).success) return as_url;

	return base; // fall through — generate_valid_body will report the failure
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
			if (format === 'date-time') return '2020-01-01T00:00:00.000Z';
			return generate_valid_string(field_schema);
		case 'number':
		case 'int':
			return 1;
		case 'boolean':
			return true;
		case 'array': {
			let min_items = 0;
			try {
				const json = z.toJSONSchema(field_schema) as Record<string, unknown>;
				if (typeof json.minItems === 'number') min_items = json.minItems;
			} catch {
				// no constraint
			}
			if (min_items === 0) return [];
			const def = zod_unwrap_def(field_schema) as {element?: z.ZodType};
			const element_schema = def.element;
			if (!element_schema) return [];
			const element_field: ZodFieldInfo = {
				...field,
				base_type: zod_get_base_type(element_schema),
			};
			const item = generate_valid_value(element_field, element_schema);
			return Array.from({length: min_items}, () => item);
		}
		case 'object': {
			// Recursively generate valid nested objects
			const nested_schema = zod_unwrap_to_object(field_schema);
			if (nested_schema) {
				const nested_fields = zod_extract_fields(nested_schema);
				const nested: Record<string, unknown> = {};
				for (const nf of nested_fields) {
					if (!nf.required && !nf.has_default) continue;
					nested[nf.name] = generate_valid_value(nf, nested_schema.shape[nf.name] as z.ZodType);
				}
				return nested;
			}
			return {};
		}
		case 'null':
			return null;
		case 'union': {
			// Pick the first variant and recurse. Works for both `z.union` and
			// `z.discriminatedUnion` — Zod 4 represents both as `def.type ===
			// 'union'` with a `def.options` array. Picking `options[0]` is a
			// pragmatic default; consumers needing a specific branch can pass
			// an override via the relevant test helper.
			const def = zod_unwrap_def(field_schema) as {options?: Array<z.ZodType>};
			const first = def.options?.[0];
			if (first) {
				const inner_field: ZodFieldInfo = {
					...field,
					base_type: zod_get_base_type(first),
				};
				return generate_valid_value(inner_field, first);
			}
			return 'test_value';
		}
		case 'literal': {
			// Zod 4 stores literal values on `def.values` (always an array, even
			// for single-valued literals). Returning the first literal satisfies
			// `z.literal('foo')` as well as required discriminator fields in
			// `z.discriminatedUnion` variants — without this branch the literal
			// would fall through to the default and break parse.
			const literal_def = zod_unwrap_def(field_schema) as {values?: ReadonlyArray<unknown>};
			if (literal_def.values && literal_def.values.length > 0) {
				return literal_def.values[0];
			}
			return 'test_value';
		}
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
 * @returns a generated body that passes `safeParse`, or `undefined` for null /
 *   non-object schemas
 * @throws Error if the generated body fails `input_schema.safeParse` — catches
 *   broken `generate_valid_value` logic early with a descriptive Zod-issues
 *   summary instead of a confusing 400 in downstream tests.
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
	let result = input_schema.safeParse(body);
	if (!result.success) {
		// Fallback for schemas with a top-level `.refine()` that requires at
		// least one of N optional fields. Fill optional fields until the body
		// satisfies validation.
		for (const field of fields) {
			if (field.required || field.has_default || field.name in body) continue;
			body[field.name] = generate_valid_value(field, object_schema.shape[field.name] as z.ZodType);
			result = input_schema.safeParse(body);
			if (result.success) break;
		}
	}
	if (!result.success) {
		throw new Error(
			`generate_valid_body: generated body fails validation — ` +
				`fix generate_valid_value for: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
		);
	}
	return body;
};
