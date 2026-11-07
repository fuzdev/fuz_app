import './assert_dev_env.ts';

/**
 * Schema-driven value generation helpers for testing.
 *
 * Walks Zod and `@fuzdev/fuz_schema` schemas to generate valid values for
 * route params, request bodies, and URL paths. Used by adversarial input,
 * adversarial 404, and round-trip validation test suites. A schema of
 * neither library throws, and so does an input no body can be generated
 * for, rather than yielding no body.
 *
 * @module
 */

import type { z } from 'zod';
import { is_schema, type AnySchema, type SchemaNode } from '@fuzdev/fuz_schema/schema.ts';
import {
	get_schema_entries,
	get_schema_fields,
	unwrap_schema
} from '@fuzdev/fuz_schema/introspect.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';
import {
	zod_unwrap_def,
	zod_get_base_type,
	zod_unwrap_to_object,
	zod_extract_fields,
	type SchemaFieldInfo
} from '../zod.ts';

import { is_null_schema, is_void_schema } from '../http/schema_helpers.ts';
import {
	compile_route_param_pattern,
	decode_route_path,
	parse_route_param,
	split_route_template
} from '../http/route_error_check.ts';
import {
	assert_zod_schema,
	format_issues,
	parse_any,
	type ParseAnyResult,
	type ValidationSchema
} from '../schema_issues.ts';

/**
 * The JSON Schema of a field's input side — where its format, pattern and
 * bounds live. Takes a Zod or a `@fuzdev/fuz_schema` field.
 *
 * Rendered with `io: 'input'`, so a field carrying a `.transform()` or a pipe
 * (`Username`) still yields the constraints its input is checked against;
 * the default output side throws on a transform. A pipe yields its input
 * side only, so constraints of the stage after it are not here. A
 * `.nullable()` / `.nullish()` field renders as
 * `anyOf: [{…}, {type: 'null'}]`, or a bare type as `type: [type, 'null']`;
 * its one non-null branch or type is returned, so the bounds, pattern and
 * `type` read the same as on the bare field. A union of two or more non-null
 * branches returns the whole schema — its branches' bounds are no single
 * field's bounds.
 *
 * Either library renders with `unrepresentable: 'any'`: a part JSON Schema
 * can't say (a `z.date()`, a `z.custom()`, a fuz_schema `check` or `bigint`)
 * is left out or `{}`, and the bounds around it still read, so a
 * `pipe(string, max_length(n), check(…))` keeps its `maxLength` and a union
 * with a `z.date()` branch keeps its other branches — every case the
 * generators build from it is checked against the field itself before it's
 * used. What an emitter refuses even then (a fuz_schema entry named like a
 * member of `Object.prototype`, metadata that isn't JSON) throws: a mistake in
 * the schema, not a gap in JSON Schema.
 *
 * A `.refine()` is never here: JSON Schema can't express one, so a bound a
 * refinement enforces (a code-point length, a cross-field rule) generates no
 * boundary case.
 *
 * @param field_schema - the field to read
 * @returns the field's input-side JSON Schema
 * @throws Error when the emitter refuses `field_schema` with `unrepresentable: 'any'`
 */
export const to_field_json_schema = (field_schema: ValidationSchema): Record<string, unknown> => {
	const json: Record<string, unknown> = is_schema(field_schema)
		? to_json_schema(field_schema, { io: 'input', unrepresentable: 'any' })
		: (field_schema as z.ZodType).toJSONSchema({ io: 'input', unrepresentable: 'any' });
	if (Array.isArray(json.anyOf)) {
		const branches = (json.anyOf as Array<Record<string, unknown>>).filter(
			(branch) => branch.type !== 'null'
		);
		if (branches.length === 1) return branches[0]!;
	}
	if (Array.isArray(json.type)) {
		const types = (json.type as Array<unknown>).filter((t) => t !== 'null');
		if (types.length === 1) return { ...json, type: types[0] };
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
export const detect_format = (field_schema: ValidationSchema): string | null =>
	detect_json_schema_format(to_field_json_schema(field_schema));

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

// --- reading a schema of either library ---

/** Whether `schema` accepts `value`, a parse of either library (`parse_any`). */
const accepts = (schema: ValidationSchema, value: unknown): boolean => parse_any(schema, value).ok;

/**
 * Every layer of a `@fuzdev/fuz_schema` schema, from the schema itself through
 * each `optional`, `nullable`, `with_default`, `with_default_fn`, the first
 * schema of a `pipe`, and a `lazy`'s schema, to what the value is — the
 * layers `unwrap_schema` walks.
 */
const fuz_schema_layers = (schema: AnySchema): Array<SchemaNode> => {
	const layers: Array<SchemaNode> = [];
	const seen: Set<SchemaNode> = new Set();
	let s = schema as SchemaNode;
	while (!seen.has(s)) {
		seen.add(s);
		layers.push(s);
		if (
			s.kind === 'optional' ||
			s.kind === 'nullable' ||
			s.kind === 'with_default' ||
			s.kind === 'with_default_fn'
		) {
			s = s.def.schema;
		} else if (s.kind === 'pipe') {
			s = s.def[0]!;
		} else if (s.kind === 'lazy') {
			s = s.def();
		} else {
			break;
		}
	}
	return layers;
};

/**
 * The type name the generators switch on for a `@fuzdev/fuz_schema` schema,
 * in Zod's vocabulary (`zod_get_base_type`): its innermost layer's kind, with
 * an object schema of any strictness `'object'`, a `literal(null)` `'null'`,
 * a `literal(undefined)` (`s.void`) `'void'`, a `one_of` `'enum'`, and a
 * `variant` `'union'`.
 */
const fuz_schema_base_type = (schema: AnySchema): string => {
	const base = unwrap_schema(schema);
	switch (base.kind) {
		case 'object':
		case 'loose_object':
		case 'strip_object':
		case 'object_with_rest':
			return 'object';
		case 'literal':
			return base.def === null ? 'null' : base.def === undefined ? 'void' : 'literal';
		case 'one_of':
			return 'enum';
		case 'variant':
			return 'union';
		default:
			return base.kind;
	}
};

// the type name the generators switch on, of either library
const to_base_type = (schema: ValidationSchema): string =>
	is_schema(schema) ? fuz_schema_base_type(schema) : zod_get_base_type(schema as z.ZodType);

/** An object schema's fields and the schema of each, of either library. */
export interface ObjectSchemaView {
	/** The fields, in declaration order. */
	fields: Array<SchemaFieldInfo>;
	/** The schema of the field named `name`, or `undefined` when there is none. */
	field_schema: (name: string) => ValidationSchema | undefined;
}

// the fields of `schema` when its innermost layer is an object schema, else `null`;
// throws for a schema of neither library
const to_object_view = (schema: ValidationSchema, label: string): ObjectSchemaView | null => {
	if (is_schema(schema)) {
		const entries = get_schema_entries(schema);
		if (!entries) return null;
		return {
			fields: get_schema_fields(schema).map((field) => {
				const layers = fuz_schema_layers(field.schema);
				return {
					name: field.name,
					base_type: fuz_schema_base_type(field.schema),
					required: !layers.some((l) => l.kind === 'optional'),
					has_default: field.has_default,
					nullable: layers.some((l) => l.kind === 'nullable')
				};
			}),
			field_schema: (name) => (Object.hasOwn(entries, name) ? entries[name] : undefined)
		};
	}
	assert_zod_schema(schema, label);
	const object_schema = zod_unwrap_to_object(schema);
	if (!object_schema) return null;
	const shape = object_schema.shape as Record<string, z.ZodType>;
	return {
		fields: zod_extract_fields(object_schema),
		field_schema: (name) => (Object.hasOwn(shape, name) ? shape[name] : undefined)
	};
};

/**
 * The fields of an object schema of either library and the schema of each,
 * through its wrappers: the `ZodObject` inside a Zod schema
 * (`zod_unwrap_to_object`, `zod_extract_fields`), or a `@fuzdev/fuz_schema`
 * schema whose innermost layer is an object schema (`get_schema_entries`,
 * `get_schema_fields`).
 *
 * @param schema - an object schema, possibly wrapped, Zod or fuz_schema
 * @param label - names the schema in the error
 * @throws Error naming `label` when `schema` is no object schema, or of neither library
 */
export const to_object_schema_view = (
	schema: ValidationSchema,
	label: string
): ObjectSchemaView => {
	const view = to_object_view(schema, label);
	if (!view) {
		throw new Error(
			`${label} is not an object schema (its innermost type is '${to_base_type(schema)}')`
		);
	}
	return view;
};

// --- generating values ---

/** Generate a string that satisfies minLength/maxLength/pattern constraints via JSON Schema. */
const generate_valid_string = (field_schema: ValidationSchema): string => {
	let min_length = 0;
	let max_length = Infinity;
	let pattern: string | null = null;
	const json = to_field_json_schema(field_schema);
	if (typeof json.minLength === 'number') min_length = json.minLength;
	if (typeof json.maxLength === 'number') max_length = json.maxLength;
	if (typeof json.pattern === 'string') pattern = json.pattern;
	const target = Math.max(min_length, Math.min(10, max_length));
	const base = 'x'.repeat(target) || 'test_value';

	// Validate against the full schema (including refinements/brands).
	// If the base string fails, try common patterns before giving up.
	if (accepts(field_schema, base)) return base;

	// Fixed-length hex refinement (blake3, sha256, etc.)
	if (pattern) {
		const hex = generate_hex_pattern_value(pattern);
		if (hex !== null && accepts(field_schema, hex)) return hex;
	}

	// Prefix-lengthed slug refinement (e.g. ApiTokenId: tok_[A-Za-z0-9_-]{12})
	if (pattern) {
		const slug = generate_prefix_slug_pattern_value(pattern);
		if (slug !== null && accepts(field_schema, slug)) return slug;
	}

	// Email-shaped refinement (the `Email` primitive: loose `local@domain.tld`).
	// The base `x`-fill has no `@`, so an email-pattern field needs a shaped
	// candidate — the `z.string().regex()` form exposes a `pattern`, not the
	// `format: 'email'` the `case 'email'` switch arm keys on.
	const as_email = 'test@example.com';
	if (accepts(field_schema, as_email)) return as_email;

	// Absolute path refinement (e.g. DiskfilePath)
	const with_slash = '/' + base;
	if (accepts(field_schema, with_slash)) return with_slash;

	// URL refinement
	const as_url = 'https://example.com/' + base;
	if (accepts(field_schema, as_url)) return as_url;

	// Two-segment path refinement (an `owner/name` repo slug)
	const segments = `${base}/${base}`;
	if (accepts(field_schema, segments)) return segments;

	return base; // fall through — generate_valid_body will report the failure
};

// the element schema of an array field, of either library
const to_array_element = (field_schema: ValidationSchema): ValidationSchema | undefined => {
	if (is_schema(field_schema)) {
		const base = unwrap_schema(field_schema);
		return base.kind === 'array' ? base.def : undefined;
	}
	return (zod_unwrap_def(field_schema as z.ZodType) as { element?: z.ZodType }).element;
};

// the first option of a union field, of either library
const to_first_union_option = (field_schema: ValidationSchema): ValidationSchema | undefined => {
	if (is_schema(field_schema)) {
		const base = unwrap_schema(field_schema);
		if (base.kind === 'union') return base.def[0];
		if (base.kind === 'variant') return base.def.options[0];
		return undefined;
	}
	// Zod 4 represents `z.union` and `z.discriminatedUnion` alike, `def.type ===
	// 'union'` with a `def.options` array
	return (zod_unwrap_def(field_schema as z.ZodType) as { options?: Array<z.ZodType> }).options?.[0];
};

// the values a literal or enum field accepts, of either library, in declared order
const to_literal_values = (field_schema: ValidationSchema): ReadonlyArray<unknown> => {
	if (is_schema(field_schema)) {
		const base = unwrap_schema(field_schema);
		if (base.kind === 'literal') return [base.def];
		if (base.kind === 'one_of') return base.def;
		return [];
	}
	const def = zod_unwrap_def(field_schema as z.ZodType);
	// Zod 4 stores literal values on `def.values` (always an array, even for
	// single-valued literals), and enum entries as an object `{key: value}`
	if ('values' in def && Array.isArray(def.values)) return def.values as ReadonlyArray<unknown>;
	if ('entries' in def) {
		const entries = (def as { entries: unknown }).entries;
		if (entries && typeof entries === 'object') {
			return Object.values(entries as Record<string, unknown>);
		}
	}
	return [];
};

/**
 * Generate a valid-ish value for a field based on its base type.
 *
 * @param field - the field's info, from `to_object_schema_view` or `zod_extract_fields`
 * @param field_schema - the field's schema, Zod or `@fuzdev/fuz_schema`
 * @returns the value, checked by the caller against the whole schema
 */
export const generate_valid_value = (
	field: SchemaFieldInfo,
	field_schema: ValidationSchema
): unknown => {
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
				if (accepts(field_schema, candidate)) return candidate;
			}
			const json = to_field_json_schema(field_schema);
			if (typeof json.minimum === 'number') return Math.ceil(json.minimum);
			if (typeof json.exclusiveMinimum === 'number') return Math.floor(json.exclusiveMinimum) + 1;
			if (typeof json.maximum === 'number') return Math.floor(json.maximum);
			if (typeof json.exclusiveMaximum === 'number') return Math.ceil(json.exclusiveMaximum) - 1;
			return 1; // fall through — generate_valid_body will report the failure
		}
		case 'boolean':
			return true;
		case 'array': {
			const json = to_field_json_schema(field_schema);
			const min_items = typeof json.minItems === 'number' ? json.minItems : 0;
			if (min_items === 0) return [];
			const element_schema = to_array_element(field_schema);
			if (!element_schema) return [];
			const element_field: SchemaFieldInfo = { ...field, base_type: to_base_type(element_schema) };
			const item = generate_valid_value(element_field, element_schema);
			return Array.from({ length: min_items }, () => item);
		}
		case 'object': {
			// recurse with the same optional-field fallback as the top level, so a
			// nested refine over optional fields (exactly-one-of) is satisfied;
			// a nested object that still fails is returned as built, and the
			// top-level parse reports it
			const view = to_object_view(field_schema, `generate_valid_value: field '${field.name}'`);
			if (view) return generate_valid_object_from_view(view, field_schema).value;
			return {};
		}
		case 'null':
			return null;
		case 'void':
		case 'undefined':
			return undefined;
		case 'record':
			return {};
		case 'union': {
			// Pick the first variant and recurse. Picking the first option is a
			// pragmatic default; consumers needing a specific branch can pass
			// an override via the relevant test helper.
			const first = to_first_union_option(field_schema);
			if (first) {
				return generate_valid_value({ ...field, base_type: to_base_type(first) }, first);
			}
			return 'test_value';
		}
		case 'literal': {
			// the first literal satisfies a literal field as well as a required
			// discriminator of a discriminated union's variant — without this
			// branch the literal would fall through to the default and break parse
			const values = to_literal_values(field_schema);
			return values.length > 0 ? values[0] : 'test_value';
		}
		case 'enum': {
			const values = to_literal_values(field_schema);
			return values.length > 0 ? values[0] : 'test';
		}
		default:
			return 'test_value';
	}
};

/** What `generate_valid_object` returns: the object and its last parse. */
export interface GeneratedObject {
	value: Record<string, unknown>;
	/** The last `parse_any` of `value` against the schema — the caller decides whether a failure throws. */
	result: ParseAnyResult<unknown>;
}

/**
 * Generate a valid object for an object schema: its required and defaulted
 * fields first; when `schema` still refuses it, each optional field alone on
 * top of those, in declaration order, taking the first that parses; and
 * failing that, the optional fields added one at a time, in declaration
 * order, until it parses. The fill covers a refine over optional fields
 * (at least one of, exactly one of, both of), which the required-only object
 * can't satisfy, and the single-field pass keeps an unrelated optional field
 * declared ahead of the refined ones (an `acting`, a note) out of the object.
 *
 * Shared by the top-level body generators and `generate_valid_value`'s
 * nested-object case, so a refined object validates the same way at any depth.
 *
 * @param object_schema - the object whose fields are generated: a Zod or
 *   `@fuzdev/fuz_schema` object schema, possibly wrapped
 * @param schema - the schema the object must satisfy, refinements included
 *   (`object_schema` or a schema wrapping it)
 * @returns the generated object and its last `parse_any` result — the caller
 *   decides whether a failure throws
 * @throws Error when `object_schema` is no object schema, or either schema is
 *   of neither library
 */
export const generate_valid_object = (
	object_schema: ValidationSchema,
	schema: ValidationSchema
): GeneratedObject =>
	generate_valid_object_from_view(
		to_object_schema_view(object_schema, 'generate_valid_object: the object schema'),
		schema
	);

const generate_valid_object_from_view = (
	view: ObjectSchemaView,
	schema: ValidationSchema
): GeneratedObject => {
	const base: Record<string, unknown> = {};
	const optional: Array<[string, unknown]> = [];
	for (const field of view.fields) {
		const value = generate_valid_value(field, view.field_schema(field.name)!);
		if (is_optional_field(field)) optional.push([field.name, value]);
		else base[field.name] = value;
	}
	return fill_optional_fields(schema, base, optional);
};

/** A field the object may omit — optional and without a default the parse fills. */
const is_optional_field = (field: SchemaFieldInfo): boolean =>
	!field.required && !field.has_default;

/**
 * `start` as is when `schema` accepts it; else `start` plus each candidate
 * alone, in order, taking the first that parses; else the candidates added
 * one at a time, in order, until it parses.
 *
 * @param schema - the schema the object must satisfy
 * @param start - the fields every result keeps
 * @param candidates - optional fields and their values, in declaration order
 * @returns the object and its last parse
 */
const fill_optional_fields = (
	schema: ValidationSchema,
	start: Record<string, unknown>,
	candidates: ReadonlyArray<readonly [string, unknown]>
): GeneratedObject => {
	let result = parse_any(schema, start);
	if (result.ok) return { value: start, result };
	// each optional field alone, so one the refinement doesn't need stays out
	for (const [name, field_value] of candidates) {
		const value = { ...start, [name]: field_value };
		const single_result = parse_any(schema, value);
		if (single_result.ok) return { value, result: single_result };
	}
	// then cumulatively, for a refinement needing several
	const value = { ...start };
	for (const [name, field_value] of candidates) {
		value[name] = field_value;
		result = parse_any(schema, value);
		if (result.ok) break;
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
 * @param object_schema - the object schema `base` is an instance of, Zod or
 *   `@fuzdev/fuz_schema`, possibly wrapped
 * @param schema - the schema the object must satisfy, refinements included
 * @param base - a valid object, the generated or seeded base
 * @param field - the field the object must carry
 * @returns the object, or `null` when no object the generator can build
 *   carries the field and passes `schema`
 * @throws Error when `object_schema` is no object schema, or either schema is
 *   of neither library
 */
export const generate_valid_object_with_field = (
	object_schema: ValidationSchema,
	schema: ValidationSchema,
	base: Record<string, unknown>,
	field: SchemaFieldInfo
): Record<string, unknown> | null => {
	if (Object.hasOwn(base, field.name)) return base;
	const view = to_object_schema_view(
		object_schema,
		'generate_valid_object_with_field: the object schema'
	);
	const fields = view.fields;
	const value_of = (f: SchemaFieldInfo): unknown =>
		Object.hasOwn(base, f.name)
			? base[f.name]
			: generate_valid_value(f, view.field_schema(f.name)!);
	const field_value = value_of(field);
	// the field joins the base, which keeps its optional fields
	const absent: Array<[string, unknown]> = fields
		.filter((f) => f.name !== field.name && is_optional_field(f) && !Object.hasOwn(base, f.name))
		.map((f) => [f.name, value_of(f)]);
	const joined = fill_optional_fields(schema, { ...base, [field.name]: field_value }, absent);
	if (joined.result.ok) return joined.value;
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
	return replaced.result.ok ? replaced.value : null;
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
 * @param field - the field's info, from `to_object_schema_view` or `zod_extract_fields`
 * @param field_schema - the field's schema, Zod or `@fuzdev/fuz_schema`
 * @returns the string, or `null` when no candidate passes
 */
export const generate_valid_string_param = (
	field: SchemaFieldInfo,
	field_schema: ValidationSchema
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
	const fallback = json.default;
	if (typeof fallback === 'number' || typeof fallback === 'string') {
		candidates.push(String(fallback));
	}
	if (typeof json.minimum === 'number') candidates.push(String(Math.ceil(json.minimum)));
	if (typeof json.exclusiveMinimum === 'number') {
		candidates.push(String(Math.floor(json.exclusiveMinimum) + 1));
	}
	candidates.push(generate_valid_string(field_schema));
	return candidates.find((c) => accepts(field_schema, c)) ?? null;
};

/**
 * The input a body is generated for: `null` for a void or null input
 * (`is_void_schema`, `is_null_schema`), which takes no body, else its object
 * view (`to_object_schema_view`).
 *
 * @param input_schema - a route's or action's input schema, Zod or `@fuzdev/fuz_schema`
 * @param label - names the input in the error
 * @throws Error naming `label` when the input is of neither library, or is
 *   neither void, null, nor an object schema — no body can be generated for
 *   it, and no body is not the same as one the generator can't build
 */
export const to_body_input = (
	input_schema: ValidationSchema,
	label: string
): ObjectSchemaView | null => {
	if (is_null_schema(input_schema) || is_void_schema(input_schema)) return null;
	const view = to_object_view(input_schema, label);
	if (!view) {
		if (to_base_type(input_schema) === 'void') {
			throw new Error(
				`${label} is a void under wrappers, which dispatch does not read as void (\`is_void_schema\` is exact): absent params reach it as \`{}\`, which it refuses — declare the input as a bare \`z.void()\` or \`s.void\``
			);
		}
		throw new Error(
			`${label} is no object, void or null schema (its innermost type is '${to_base_type(
				input_schema
			)}'), so no body can be generated for it`
		);
	}
	return view;
};

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
 * Caller-supplied path param values, keyed by route key (`format_route_key`,
 * `'METHOD /path'`) and then by param name — what the suites that resolve a
 * route's path (`resolve_valid_path`) fill a param with before generating
 * one. A route needs an entry when a param of it is a `:name{re}` whose
 * pattern refuses every value the generator reaches, as a `{.+\.git}` refuses
 * `test_<name>`. Each value is the param as the handler reads it, unencoded.
 * Values are always percent-encoded, so a `{re}` that needs a literal `/` can't
 * be met by a supplied value: its `/` arrives as `%2F`.
 */
export type RouteParamValues = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Resolve a route path with valid-ish param values so params validation passes.
 * Used when testing input on routes that also have params.
 *
 * The template is read as Hono reads it (`split_route_template`,
 * `parse_route_param`): only a whole param segment — `:name` or `:name{re}`,
 * optional or not — is filled, so a `:` inside a literal segment
 * (`/v1/files:upload`) stays, and a `{re}` goes with its param. An optional
 * param is filled too.
 *
 * A value in `param_values` is used first, percent-encoded. Otherwise,
 * without a params schema (or for a param the schema doesn't name) each
 * param becomes `test_<name>` — fine for an unconstrained segment. With
 * one, `test_<name>` is still preferred wherever the field schema accepts
 * it, because the param name in the URL is what makes a failure message
 * readable. Only a segment that refuses it falls through: a `uuid` param
 * takes the nil UUID (the fast path — by far the most common shape), and
 * anything else is synthesized by `generate_valid_string`, so a
 * format-constrained segment (a `blake3:…` fact hash, a `tok_…` id)
 * resolves to a value its schema accepts instead of a `test_<name>` that
 * 400s before the route's real gates run. The synthesized value is
 * percent-encoded, and a value containing `/` is refused (it would silently
 * add a path segment and route elsewhere) — both fall back to `test_<name>`.
 *
 * A `{re}` param's value, supplied or not, must match its pattern, grouped
 * and anchored as Hono's RegExpRouter reads it — the stricter of its
 * routers' readings, as TrieRouter leaves a top-level alternation ungrouped
 * (`compile_route_param_pattern`, over the value as Hono decodes it,
 * `decode_route_path`) — or the request would reach no route; no value is
 * guessed from the pattern. A supplied value the URL would normalize away
 * (`''`, `.`, `..`) is refused by name.
 *
 * @param path - the route's path template
 * @param params_schema - the route's params schema, a Zod or `@fuzdev/fuz_schema` object schema
 * @param param_values - the route's supplied param values by name, its entry of `RouteParamValues`
 * @throws Error when `params_schema` is no object schema, or of neither library;
 *   when `param_values` names no param of the path; when a supplied value is
 *   `''`, `.` or `..`, or holds a lone surrogate, which can't be encoded; and
 *   when a `{re}` param's value is one its pattern refuses, naming the route
 *   and the param
 */
export const resolve_valid_path = (
	path: string,
	params_schema?: ValidationSchema,
	param_values?: Readonly<Record<string, string>>
): string => {
	const view = params_schema
		? to_object_schema_view(params_schema, `resolve_valid_path(${path}): the params schema`)
		: null;
	const generate = (name: string): string => {
		const fallback = encodeURIComponent(`test_${name}`);
		const field_schema = view?.field_schema(name);
		if (!field_schema) return fallback;
		if (accepts(field_schema, `test_${name}`)) return fallback;
		if (to_base_type(field_schema) === 'uuid') return NIL_UUID;
		const format = detect_format(field_schema);
		if (format === 'uuid') return NIL_UUID;
		const generated = generate_valid_string(field_schema);
		if (generated.includes('/')) return fallback;
		return encodeURIComponent(generated);
	};
	const encode_supplied = (name: string, supplied: string): string => {
		// the URL drops an empty segment's meaning and resolves `.` and `..` away
		if (supplied === '' || supplied === '.' || supplied === '..') {
			throw new Error(
				`resolve_valid_path: the value supplied for the param \`${name}\` of \`${path}\` is ${JSON.stringify(
					supplied
				)}, which the URL normalizes away, so the request would not reach the route`
			);
		}
		try {
			return encodeURIComponent(supplied);
		} catch (error) {
			if (!(error instanceof URIError)) throw error;
			throw new Error(
				`resolve_valid_path: the value supplied for the param \`${name}\` of \`${path}\` holds a lone surrogate, which can't be percent-encoded`
			);
		}
	};
	const names: Set<string> = new Set();
	const segments = split_route_template(path).map((segment) => {
		const param = parse_route_param(segment);
		if (!param) return segment;
		const { name, pattern } = param;
		names.add(name);
		const supplied =
			param_values && Object.hasOwn(param_values, name) ? param_values[name] : undefined;
		const value = supplied === undefined ? generate(name) : encode_supplied(name, supplied);
		if (pattern !== null && !compile_route_param_pattern(pattern).test(decode_route_path(value))) {
			throw new Error(
				`resolve_valid_path: the param \`${name}\` of \`${path}\` resolves to ${JSON.stringify(
					value
				)}${
					supplied === undefined ? ',' : ', the value supplied for it,'
				} which its pattern \`{${pattern}}\` refuses, so the request would reach no route — supply a value the pattern accepts in the suite's \`param_values\`, under the route's key (\`'METHOD ${path}'\`) and then \`${name}\``
			);
		}
		return value;
	});
	if (param_values) {
		for (const name of Object.keys(param_values)) {
			if (!names.has(name)) {
				throw new Error(
					`resolve_valid_path: \`param_values\` names \`${name}\`, which is no param of \`${path}\``
				);
			}
		}
	}
	return (path.startsWith('/') ? '/' : '') + segments.join('/');
};

/**
 * Generate a valid request body for a route's or action's input schema.
 *
 * @param input_schema - the input schema, Zod or `@fuzdev/fuz_schema`
 * @returns a generated body that passes the schema, or `undefined` for a void
 *   or null input, which takes no body
 * @throws Error if the input is of neither library, or is neither void, null,
 *   nor an object schema, or if the generated body fails the input — catching
 *   broken `generate_valid_value` logic early with the parse's issues instead
 *   of a confusing 400 in downstream tests
 */
export const generate_valid_body = (
	input_schema: ValidationSchema
): Record<string, unknown> | undefined => {
	const view = to_body_input(input_schema, 'generate_valid_body: the input');
	if (!view) return undefined;
	const { value, result } = generate_valid_object_from_view(view, input_schema);
	if (!result.ok) {
		throw new Error(
			`generate_valid_body: generated body fails validation — ` +
				`fix generate_valid_value for: ${format_issues(result.issues)}`
		);
	}
	return value;
};
