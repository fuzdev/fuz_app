/**
 * Zod schema introspection utilities.
 *
 * Generic helpers for walking, unwrapping, and extracting field info from Zod schemas,
 * and `zod_has_trait`, the structural `instanceof`. Used by adversarial input
 * testing, test-data generation, auth-shape checks, and the dual-library layer
 * (`schema_issues.ts`, `http/schema_helpers.ts`). Imports Zod's types only, so
 * an importer loads no Zod.
 *
 * @module
 */

import type { z } from 'zod';

/**
 * Whether `value` carries the Zod trait `trait` — what Zod's own
 * `instanceof` reads (`value._zod.traits.has(trait)`), so it answers as
 * `value instanceof z[trait]` would, a schema made by another copy of Zod
 * included, without importing Zod at runtime. The classic API's names are the
 * classes' (`'ZodType'`, `'ZodObject'`, `'ZodNull'`, `'ZodError'`), the core's
 * `$`-prefixed (`'$ZodType'`).
 *
 * @param value - any value
 * @param trait - the Zod class name to test for
 * @returns whether `value` is an instance of that Zod class
 */
export const zod_has_trait = (value: unknown, trait: string): boolean => {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
	const internals: unknown = (value as { _zod?: unknown })._zod;
	if (internals === null || typeof internals !== 'object') return false;
	const traits: unknown = (internals as { traits?: unknown }).traits;
	return traits instanceof Set && traits.has(trait);
};

//
// Schema Introspection
//

/**
 * Unwrap nested schema types (optional, default, nullable, etc).
 *
 * @returns inner schema if wrapped, undefined otherwise
 */
const zod_to_subschema = (def: z.core.$ZodTypeDef): z.ZodType | undefined => {
	if ('innerType' in def) {
		return def.innerType as z.ZodType;
	} else if ('in' in def) {
		return def.in as z.ZodType;
	} else if ('schema' in def) {
		return def.schema as z.ZodType;
	}
	return undefined;
};

/** Zod wrapper type names that `zod_unwrap_def` traverses through. */
const ZOD_WRAPPER_TYPES = new Set([
	'optional',
	'nullable',
	'default',
	'transform',
	'pipe',
	'prefault'
]);

/**
 * Unwrap Zod wrappers (optional, default, nullable, pipe, transform)
 * to get the base type definition.
 *
 * @returns the innermost non-wrapper type definition
 */
export const zod_unwrap_def = (schema: z.ZodType): z.core.$ZodTypeDef => {
	const { def } = schema;
	if (ZOD_WRAPPER_TYPES.has(def.type)) {
		const sub = zod_to_subschema(def);
		if (sub) return zod_unwrap_def(sub);
	}
	return def;
};

/**
 * Get the base type name for a Zod schema, unwrapping all wrappers.
 *
 * @returns base type name (e.g. `'string'`, `'object'`, `'uuid'`)
 */
export const zod_get_base_type = (schema: z.ZodType): string => zod_unwrap_def(schema).type;

/**
 * Check if a schema is optional at the outermost level.
 */
const zod_is_optional = (schema: z.ZodType): boolean => schema.def.type === 'optional';

/**
 * Check if a schema accepts null at any wrapping level.
 */
const zod_is_nullable = (schema: z.ZodType): boolean => {
	const { def } = schema;
	if (def.type === 'nullable') return true;
	if (ZOD_WRAPPER_TYPES.has(def.type)) {
		const sub = zod_to_subschema(def);
		if (sub) return zod_is_nullable(sub);
	}
	return false;
};

/**
 * Check if a schema has a default value at any wrapping level.
 * Distinguishes "no default" from "default is undefined".
 */
const zod_has_default = (schema: z.ZodType): boolean => {
	const { def } = schema;
	if ('defaultValue' in def) return true;
	const sub = zod_to_subschema(def);
	if (sub) return zod_has_default(sub);
	return false;
};

/**
 * Unwrap a schema through every wrapper type (optional, nullable, default,
 * transform, pipe, prefault) to reach the innermost schema. Like `zod_unwrap_def`
 * but returns the schema (so callers can `.shape`, `instanceof`-check, etc.)
 * instead of the def.
 *
 * @returns the innermost non-wrapper schema
 */
export const zod_get_innermost_type = (schema: z.ZodType): z.ZodType => {
	if (ZOD_WRAPPER_TYPES.has(schema.def.type)) {
		const sub = zod_to_subschema(schema.def);
		if (sub) return zod_get_innermost_type(sub);
	}
	return schema;
};

/**
 * Every layer of a schema, from the schema itself through each wrapper
 * (optional, nullable, default, transform, pipe, prefault) to the innermost
 * non-wrapper — for reading `.meta()` a wrapper does not carry over from the
 * schema it wraps.
 *
 * @returns the layers, outermost first, ending at `zod_get_innermost_type(schema)`
 */
export const zod_get_schema_layers = (schema: z.ZodType): Array<z.ZodType> => {
	const layers: Array<z.ZodType> = [schema];
	let s = schema;
	while (ZOD_WRAPPER_TYPES.has(s.def.type)) {
		const sub = zod_to_subschema(s.def);
		if (!sub) break;
		layers.push(sub);
		s = sub;
	}
	return layers;
};

/**
 * Get all property keys from an object schema, unwrapping wrappers.
 * Returns an empty array if the innermost type is not an object.
 *
 * @param schema - Zod schema (typically a `ZodObject` with possible wrappers)
 */
export const zod_get_schema_keys = <T extends z.ZodType>(
	schema: T
): Array<keyof z.infer<T> & string> => {
	const obj = zod_unwrap_to_object(schema);
	return obj ? (Object.keys(obj.shape) as Array<keyof z.infer<T> & string>) : [];
};

/**
 * Get the field schema for a key in an object schema, returning `undefined` if
 * the schema is not an object or the key is not one of its own fields (a name
 * the shape only inherits, such as `constructor` or `toString`, included).
 *
 * @param schema - Zod schema (typically a `ZodObject` with possible wrappers)
 * @param key - the property name
 * @returns the field's schema, or `undefined`
 */
export const zod_maybe_get_field_schema = (
	schema: z.ZodType,
	key: string
): z.ZodType | undefined => {
	const shape = zod_unwrap_to_object(schema)?.shape;
	return shape && Object.hasOwn(shape, key) ? shape[key] : undefined;
};

/**
 * Get the field schema for a key in an object schema.
 *
 * @param schema - Zod schema (typically a `ZodObject` with possible wrappers)
 * @throws Error if the schema is not an object or the key is missing
 */
export const zod_get_field_schema = (schema: z.ZodType, key: string): z.ZodType => {
	const field = zod_maybe_get_field_schema(schema, key);
	if (!field) throw new Error(`Field "${key}" not found in schema`);
	return field;
};

/**
 * Unwrap a schema to find the inner `ZodObject`, or `null` if not an object schema.
 * Handles wrappers like `z.strictObject({...}).default({...})`.
 */
export const zod_unwrap_to_object = (schema: z.ZodType): z.ZodObject | null => {
	const def = zod_unwrap_def(schema);
	if (def.type !== 'object') return null;
	let s: z.ZodType = schema;
	while (s.def.type !== 'object') {
		const sub = zod_to_subschema(s.def);
		if (!sub) return null;
		s = sub;
	}
	return s as z.ZodObject;
};

// --- Field extraction ---

/**
 * What the testing generators read of one field of an object schema, of
 * either library: `zod_extract_fields` reads a `ZodObject`'s, and
 * `to_object_schema_view` (`testing/schema_generators.ts`) a schema's of
 * either library.
 */
export interface SchemaFieldInfo {
	/** The field's key. */
	name: string;
	/**
	 * The innermost type's name in Zod's vocabulary (`zod_get_base_type`):
	 * `'string'`, `'number'`, `'boolean'`, `'array'`, `'object'`, `'null'`,
	 * `'void'`, `'union'`, `'literal'`, `'enum'`, and so on. A
	 * `@fuzdev/fuz_schema` field reads its innermost kind, an object of any
	 * strictness as `'object'`, a `literal(null)` as `'null'`, a
	 * `literal(undefined)` (`s.void`) as `'void'`, a `one_of` as `'enum'`, and
	 * a `variant` as `'union'`.
	 */
	base_type: string;
	/** Whether the key must be present: no outermost `.optional()` in Zod, no `optional` layer in fuz_schema. */
	required: boolean;
	/** Whether the parse fills the key in when it is missing. */
	has_default: boolean;
	/** Whether a wrapping layer accepts `null`. */
	nullable: boolean;
}

/**
 * Extract field metadata from a Zod object schema.
 */
export const zod_extract_fields = (schema: z.ZodObject): Array<SchemaFieldInfo> => {
	const fields: Array<SchemaFieldInfo> = [];
	for (const [name, field_schema] of Object.entries(schema.shape)) {
		const field = field_schema as z.ZodType;
		fields.push({
			name,
			base_type: zod_get_base_type(field),
			required: !zod_is_optional(field),
			has_default: zod_has_default(field),
			nullable: zod_is_nullable(field)
		});
	}
	return fields;
};
