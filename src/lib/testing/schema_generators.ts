import './assert_dev_env.ts';

/**
 * Schema-driven value generation helpers for testing.
 *
 * Walks Zod schemas to generate valid values for route params, request bodies,
 * and URL paths. Used by adversarial input, adversarial 404, and round-trip
 * validation test suites.
 *
 * @module
 */

import { z } from 'zod';
import {
	zod_unwrap_def,
	zod_get_base_type,
	zod_unwrap_to_object,
	zod_extract_fields,
	type ZodFieldInfo
} from '../zod.ts';

import { is_null_schema } from '../http/schema_helpers.ts';

/**
 * The JSON Schema of a field's input side — where its format, pattern and
 * bounds live — or `null` when JSON Schema can't render the field or any part
 * of it (`z.date()`, `z.custom()`, a union with a `z.date()` branch).
 *
 * Rendered with `io: 'input'`, so a field carrying a `.transform()` or a pipe
 * (`Username`) still yields the constraints its input is checked against;
 * the default output side throws on a transform. A pipe yields its input
 * side only, so constraints of the stage after it are not here. A
 * `.nullable()` / `.nullish()` field renders as
 * `anyOf: [{…}, {type: 'null'}]`; its one non-null branch is returned, so
 * the bounds and pattern read the same as on the bare field. A union of two
 * or more non-null branches returns the whole schema — its branches' bounds
 * are no single field's bounds.
 *
 * A `.refine()` is never here: JSON Schema can't express one, so a bound a
 * refinement enforces (a code-point length, a cross-field rule) generates no
 * boundary case.
 *
 * @param field_schema - the field to read
 * @returns the field's input-side JSON Schema, or `null` when it can't be rendered
 */
export const to_field_json_schema = (field_schema: z.ZodType): Record<string, unknown> | null => {
	let json: Record<string, unknown>;
	try {
		json = z.toJSONSchema(field_schema, { io: 'input' });
	} catch {
		return null; // a type JSON Schema can't represent
	}
	if (Array.isArray(json.anyOf)) {
		const branches = (json.anyOf as Array<Record<string, unknown>>).filter(
			(branch) => branch.type !== 'null'
		);
		if (branches.length === 1) return branches[0]!;
	}
	return json;
};

/**
 * The format constraint a field's input-side JSON Schema carries: its
 * `format` (e.g. `'uuid'`, `'email'`), `'pattern'` for a regex, or `null`.
 * A union (`anyOf` of several non-null branches) answers its first branch
 * carrying one — a value violating every branch is what the caller needs,
 * and the generators check the field refuses the candidate.
 *
 * @param json - a field's JSON Schema, as `to_field_json_schema` returns it
 * @returns the format, `'pattern'`, or `null`
 */
export const detect_json_schema_format = (json: Record<string, unknown>): string | null => {
	if (typeof json.format === 'string') return json.format;
	if (typeof json.pattern === 'string') return 'pattern';
	if (Array.isArray(json.anyOf)) {
		for (const branch of json.anyOf as Array<Record<string, unknown>>) {
			if (branch.type === 'null') continue;
			if (typeof branch.format === 'string') return branch.format;
			if (typeof branch.pattern === 'string') return 'pattern';
		}
	}
	return null;
};

/**
 * Detect format constraints on a field from its input-side JSON Schema
 * (`to_field_json_schema`). Returns the format string (e.g. `'uuid'`,
 * `'email'`), `'pattern'` for a regex, or `null`.
 */
export const detect_format = (field_schema: z.ZodType): string | null => {
	const json = to_field_json_schema(field_schema);
	return json && detect_json_schema_format(json);
};

/**
 * Extract a candidate value from a JSON Schema `pattern` when the shape is a
 * fixed-length hex character class, optionally behind a literal prefix —
 * covers bare digests (blake3 64-char lowercase hex, sha256, md5) and the
 * algorithm-tagged form the fact store addresses bytes by
 * (`^blake3:[0-9a-f]{64}$` → `blake3:` + 64 zeros).
 *
 * Coverage today:
 * - Optional prefix: alphanumeric, starting with a letter, ending in `:`
 *   (`blake3:`, `sha256:`). A `_`-joined prefix over a base64url class is
 *   the sibling shape — see `generate_prefix_slug_pattern_value`.
 * - Character class must be exactly `[0-9a-f]` or `[0-9a-fA-F]` (Zod passes
 *   the regex source through verbatim — no character-class reordering).
 * - Fixed-length quantifier `{N}`.
 *
 * Returns `null` when the pattern doesn't match the expected shape; the
 * caller then falls through to its other candidates.
 */
const generate_hex_pattern_value = (pattern: string): string | null => {
	const match = /^\^(?:([A-Za-z][A-Za-z0-9]*):)?\[0-9a-f(?:A-F)?\]\{(\d+)\}\$$/.exec(pattern);
	if (!match) return null;
	const n = Number(match[2]);
	if (!Number.isInteger(n) || n <= 0) return null;
	const prefix = match[1] === undefined ? '' : `${match[1]}:`;
	return prefix + '0'.repeat(n);
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
 *   token shape) are not matched here; `generate_hex_pattern_value` is the
 *   hex sibling, and it covers both the bare and the `prefix:`-tagged form.
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
	const json = to_field_json_schema(field_schema);
	if (json) {
		if (typeof json.minLength === 'number') min_length = json.minLength;
		if (typeof json.maxLength === 'number') max_length = json.maxLength;
		if (typeof json.pattern === 'string') pattern = json.pattern;
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

	// Two-segment path refinement (an `owner/name` repo slug)
	const segments = `${base}/${base}`;
	if (field_schema.safeParse(segments).success) return segments;

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
		case 'int': {
			// 1, unless the schema's bounds rule it out (`.negative()`, `.min(10)`)
			for (const candidate of [1, -1, 0]) {
				if (field_schema.safeParse(candidate).success) return candidate;
			}
			const json = to_field_json_schema(field_schema);
			if (json) {
				if (typeof json.minimum === 'number') return Math.ceil(json.minimum);
				if (typeof json.exclusiveMinimum === 'number') return Math.floor(json.exclusiveMinimum) + 1;
				if (typeof json.maximum === 'number') return Math.floor(json.maximum);
				if (typeof json.exclusiveMaximum === 'number') return Math.ceil(json.exclusiveMaximum) - 1;
			}
			return 1; // fall through — generate_valid_body will report the failure
		}
		case 'boolean':
			return true;
		case 'array': {
			const json = to_field_json_schema(field_schema);
			const min_items = typeof json?.minItems === 'number' ? json.minItems : 0;
			if (min_items === 0) return [];
			const def = zod_unwrap_def(field_schema) as { element?: z.ZodType };
			const element_schema = def.element;
			if (!element_schema) return [];
			const element_field: ZodFieldInfo = {
				...field,
				base_type: zod_get_base_type(element_schema)
			};
			const item = generate_valid_value(element_field, element_schema);
			return Array.from({ length: min_items }, () => item);
		}
		case 'object': {
			// recurse with the same optional-field fallback as the top level, so a
			// nested `.refine()` over optional fields (exactly-one-of) is satisfied;
			// a nested object that still fails is returned as built, and the
			// top-level parse reports it
			const nested_schema = zod_unwrap_to_object(field_schema);
			if (nested_schema) return generate_valid_object(nested_schema, field_schema).value;
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
			const def = zod_unwrap_def(field_schema) as { options?: Array<z.ZodType> };
			const first = def.options?.[0];
			if (first) {
				const inner_field: ZodFieldInfo = {
					...field,
					base_type: zod_get_base_type(first)
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
			const literal_def = zod_unwrap_def(field_schema) as { values?: ReadonlyArray<unknown> };
			if (literal_def.values && literal_def.values.length > 0) {
				return literal_def.values[0];
			}
			return 'test_value';
		}
		case 'enum': {
			const enum_def = zod_unwrap_def(field_schema);
			if ('entries' in enum_def) {
				const entries = (enum_def as { entries: unknown }).entries;
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
 * Generate a valid object for an object schema: its required and defaulted
 * fields first; when `schema` still refuses it, each optional field alone on
 * top of those, in declaration order, taking the first that parses; and
 * failing that, the optional fields added one at a time, in declaration
 * order, until it parses. The fill covers a `.refine()` over optional fields
 * (at least one of, exactly one of, both of), which the required-only object
 * can't satisfy, and the single-field pass keeps an unrelated optional field
 * declared ahead of the refined ones (an `acting`, a note) out of the object.
 *
 * Shared by the top-level body generators and `generate_valid_value`'s
 * nested-object case, so a refined object validates the same way at any depth.
 *
 * @param object_schema - the unwrapped object whose fields are generated
 * @param schema - the schema the object must satisfy, refinements included
 *   (`object_schema` or a schema wrapping it)
 * @returns the generated object and its last `safeParse` result — the caller
 *   decides whether a failure throws
 */
export const generate_valid_object = (
	object_schema: z.ZodObject,
	schema: z.ZodType
): { value: Record<string, unknown>; result: z.ZodSafeParseResult<unknown> } => {
	const base: Record<string, unknown> = {};
	const optional: Array<[string, unknown]> = [];
	for (const field of zod_extract_fields(object_schema)) {
		const value = generate_valid_value(field, object_schema.shape[field.name] as z.ZodType);
		if (is_optional_field(field)) optional.push([field.name, value]);
		else base[field.name] = value;
	}
	return fill_optional_fields(schema, base, optional);
};

/** A field the object may omit — optional and without a default Zod fills. */
const is_optional_field = (field: ZodFieldInfo): boolean => !field.required && !field.has_default;

/**
 * `start` as is when `schema` accepts it; else `start` plus each candidate
 * alone, in order, taking the first that parses; else the candidates added
 * one at a time, in order, until it parses.
 *
 * @param schema - the schema the object must satisfy
 * @param start - the fields every result keeps
 * @param candidates - optional fields and their values, in declaration order
 * @returns the object and its last `safeParse` result
 */
const fill_optional_fields = (
	schema: z.ZodType,
	start: Record<string, unknown>,
	candidates: ReadonlyArray<readonly [string, unknown]>
): { value: Record<string, unknown>; result: z.ZodSafeParseResult<unknown> } => {
	let result = schema.safeParse(start);
	if (result.success) return { value: start, result };
	// each optional field alone, so one the refinement doesn't need stays out
	for (const [name, field_value] of candidates) {
		const value = { ...start, [name]: field_value };
		const single_result = schema.safeParse(value);
		if (single_result.success) return { value, result: single_result };
	}
	// then cumulatively, for a refinement needing several
	const value = { ...start };
	for (const [name, field_value] of candidates) {
		value[name] = field_value;
		result = schema.safeParse(value);
		if (result.success) break;
	}
	return { value, result };
};

/**
 * A valid object that carries `field`, built from `base`, a valid object of
 * `object_schema` — the body a case breaking `field` changes, so the case
 * breaks that field and nothing else. `base` itself when it carries the
 * field. Otherwise the field takes a generated value and joins `base`, with
 * the optional fields `base` omits filled as `generate_valid_object` fills
 * them (a pair rule: adding `scope_kind` needs `scope_id`); failing that, it
 * replaces `base`'s optional fields, refilled the same way around it (an
 * exactly-one-of rule: adding `slug` means dropping `id`).
 *
 * @param object_schema - the unwrapped object `base` is an instance of
 * @param schema - the schema the object must satisfy, refinements included
 * @param base - a valid object, the generated or seeded base
 * @param field - the field the object must carry
 * @returns the object, or `null` when no object the generator can build
 *   carries the field and passes `schema`
 */
export const generate_valid_object_with_field = (
	object_schema: z.ZodObject,
	schema: z.ZodType,
	base: Record<string, unknown>,
	field: ZodFieldInfo
): Record<string, unknown> | null => {
	if (Object.hasOwn(base, field.name)) return base;
	const fields = zod_extract_fields(object_schema);
	const value_of = (f: ZodFieldInfo): unknown =>
		Object.hasOwn(base, f.name)
			? base[f.name]
			: generate_valid_value(f, object_schema.shape[f.name] as z.ZodType);
	const field_value = value_of(field);
	// the field joins the base, which keeps its optional fields
	const absent: Array<[string, unknown]> = fields
		.filter((f) => f.name !== field.name && is_optional_field(f) && !Object.hasOwn(base, f.name))
		.map((f) => [f.name, value_of(f)]);
	const joined = fill_optional_fields(schema, { ...base, [field.name]: field_value }, absent);
	if (joined.result.success) return joined.value;
	// the field in place of the base's optional fields, which are refilled around it
	const optional_names = new Set(fields.filter(is_optional_field).map((f) => f.name));
	const core: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(base)) {
		if (!optional_names.has(k)) core[k] = v;
	}
	core[field.name] = field_value;
	const others: Array<[string, unknown]> = fields
		.filter((f) => f.name !== field.name && is_optional_field(f))
		.map((f) => [f.name, value_of(f)]);
	const replaced = fill_optional_fields(schema, core, others);
	return replaced.result.success ? replaced.value : null;
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * A string a URL-sourced field accepts — a route param or a query value, which
 * arrive as strings whatever the schema parses them into. The nil UUID for a
 * UUID field; else the first the field accepts of `test_value`, the generated
 * valid value written as a string, `1`, `0`, `true` and `false`, the field's
 * JSON Schema `default` or lower bound written as a string (a preprocessed
 * integer whose minimum is above one), and a string synthesized from the
 * field's constraints.
 *
 * @param field - the field's info, from `zod_extract_fields`
 * @param field_schema - the field's schema
 * @returns the string, or `null` when no candidate passes
 */
export const generate_valid_string_param = (
	field: ZodFieldInfo,
	field_schema: z.ZodType
): string | null => {
	const candidates: Array<string> = [];
	if (field.base_type === 'uuid' || detect_format(field_schema) === 'uuid') {
		candidates.push(NIL_UUID);
	}
	candidates.push('test_value');
	const generated = generate_valid_value(field, field_schema);
	if (
		typeof generated === 'string' ||
		typeof generated === 'number' ||
		typeof generated === 'boolean'
	) {
		candidates.push(String(generated));
	}
	candidates.push('1', '0', 'true', 'false');
	// a number the URL string is preprocessed into: its default or its lower bound
	const json = to_field_json_schema(field_schema);
	if (json) {
		const fallback = json.default;
		if (typeof fallback === 'number' || typeof fallback === 'string') {
			candidates.push(String(fallback));
		}
		if (typeof json.minimum === 'number') candidates.push(String(Math.ceil(json.minimum)));
		if (typeof json.exclusiveMinimum === 'number') {
			candidates.push(String(Math.floor(json.exclusiveMinimum) + 1));
		}
	}
	candidates.push(generate_valid_string(field_schema));
	return candidates.find((c) => field_schema.safeParse(c).success) ?? null;
};

/**
 * Format Zod issues as `path: message` pairs for a generator's error message.
 *
 * @param error - the failed parse's error
 * @returns the issues, comma-separated
 */
export const format_zod_issues = (error: z.ZodError): string =>
	error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');

/**
 * The `Content-Type` a well-formed request to a route sends: `application/json`,
 * or `application/octet-stream` for a `raw_body` route. Every `POST` route
 * refuses anything else with 415 before its other gates run (see
 * `http/simple_request.ts`), so a probe of those gates must send it, body or
 * not. Other methods don't check it, so sending it there is harmless.
 *
 * @param route - the route spec or surface route (reads `raw_body`)
 */
export const to_route_content_type = (route: { raw_body?: boolean }): string =>
	route.raw_body ? 'application/octet-stream' : 'application/json';

/**
 * Resolve a route path with valid-ish param values so params validation passes.
 * Used when testing input on routes that also have params.
 *
 * Without a params schema (or for a param the schema doesn't name) each
 * `:name` becomes `test_<name>` — fine for an unconstrained segment. With
 * one, `test_<name>` is still preferred wherever the field schema accepts
 * it, because the param name in the URL is what makes a failure message
 * readable. Only a segment that refuses it falls through: a `uuid` param
 * takes the nil UUID (the fast path — by far the most common shape), and
 * anything else is synthesized by `generate_valid_string`, so a
 * format-constrained segment (a `blake3:…` fact hash, a `tok_…` id)
 * resolves to a value its schema accepts instead of a `test_<name>` that
 * 400s before the route's real gates run.
 *
 * The synthesized value is percent-encoded, and a value containing `/` is
 * refused (it would silently add a path segment and route elsewhere) —
 * both fall back to `test_<name>`.
 */
export const resolve_valid_path = (path: string, params_schema?: z.ZodObject): string => {
	if (!params_schema) {
		return path.replace(/:(\w+)/g, 'test_$1');
	}
	return path.replace(/:(\w+)/g, (_match, name) => {
		const fallback = `test_${name}`;
		const field_schema = params_schema.shape[name] as z.ZodType | undefined;
		if (!field_schema) return fallback;
		if (field_schema.safeParse(fallback).success) return fallback;
		const base_type = zod_get_base_type(field_schema);
		if (base_type === 'uuid') return '00000000-0000-0000-0000-000000000000';
		const format = detect_format(field_schema);
		if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
		const generated = generate_valid_string(field_schema);
		if (generated.includes('/')) return fallback;
		return encodeURIComponent(generated);
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
	input_schema: z.ZodType
): Record<string, unknown> | undefined => {
	if (is_null_schema(input_schema)) return undefined;
	const object_schema = zod_unwrap_to_object(input_schema);
	if (!object_schema) return undefined;
	const { value, result } = generate_valid_object(object_schema, input_schema);
	if (!result.success) {
		throw new Error(
			`generate_valid_body: generated body fails validation — ` +
				`fix generate_valid_value for: ${format_zod_issues(result.error)}`
		);
	}
	return value;
};
