/**
 * Shared Zod `.meta()` conventions for fuz_app schemas.
 *
 * Cross-cutting metadata shape used by auth and action input schemas,
 * surface generation, and test helpers. The env schemas are
 * `@fuzdev/fuz_schema` and carry the same keys in its `meta`
 * (`sensitivity.ts`, `find_schema_sensitivity`); this module adds
 * `invalid_reason` and `empty_input_handler_guarded` to fuz_schema's
 * `SchemaMeta`, so the declared refusal reason of an action input, its
 * handler-guarded marker, and its sensitivity read the same whichever library
 * its schema is.
 *
 * @module
 */

import type { z } from 'zod';
import { is_schema, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import {
	find_schema_meta,
	get_schema_entries,
	get_schema_meta,
	unwrap_schema
} from '@fuzdev/fuz_schema/introspect.ts';
import { get_meta } from '@fuzdev/fuz_schema/meta.ts';

import type { Sensitivity } from './sensitivity.ts';
import { zod_get_schema_layers, zod_unwrap_to_object } from './zod.ts';
import {
	assert_zod_schema,
	issue_is_on_input,
	type AnyIssue,
	type ValidationSchema
} from './schema_issues.ts';

declare module '@fuzdev/fuz_schema/meta.ts' {
	interface SchemaMeta {
		/**
		 * The `error.data.reason` an action input refuses this field with, as
		 * `SchemaFieldMeta.invalid_reason` declares it on a Zod field. Read
		 * through the field's layers (`get_schema_meta`), the outermost
		 * declaration winning.
		 */
		invalid_reason?: string;
		/**
		 * Set on an action's input schema whose handler refuses the `{}` the
		 * schema admits, as `SchemaFieldMeta.empty_input_handler_guarded`
		 * declares it on a Zod input. Read from the input schema itself
		 * (`get_meta`), so a wrapper around it drops it, as in Zod.
		 */
		empty_input_handler_guarded?: boolean;
	}
}

/** Zod `.meta()` shape for fuz_app schema metadata conventions. */
export interface SchemaFieldMeta {
	description?: string;
	/**
	 * Sensitivity level (`Sensitivity`): `'secret'` masks the value,
	 * `'personal'` only keeps it out of URLs. Read through every wrapping
	 * layer (`schema_sensitivity`), so `.meta({sensitivity: 'secret'}).optional()`
	 * masks too.
	 */
	sensitivity?: Sensitivity;
	/**
	 * Set on an action's **input** schema that accepts `{}` by design while
	 * its handler refuses `{}` with a declared reason — an input taking one of
	 * several optional selectors, where the handler names the missing or
	 * conflicting one (a schema-level refine would answer a reason-less
	 * `invalid_params` first). A call with no input is never valid for such an
	 * action, so the typed surface keeps its input required
	 * (`action_input_is_optional`), and the input-shape invariant ("an input
	 * accepting `{}` accepts `undefined` too") exempts it. Read from the input
	 * schema itself, so a wrapper (`.optional()`, `.extend()`) drops it.
	 */
	empty_input_handler_guarded?: boolean;
	/**
	 * The `error.data.reason` an action input refuses this field with. On a
	 * field of an action's **input** schema, every `invalid_params` whose first
	 * Zod issue lands on the field — missing, wrong type, `null`, out of range,
	 * malformed, or a fault anywhere inside it — carries this reason, where an
	 * undeclared field's refusal carries none. The message stays the generic
	 * `invalid params`. A body with faults on several fields answers the first
	 * issue's reason in Zod's order, which a twin checking in another order
	 * need not match, so the reason is defined for a single-fault body only —
	 * except that an issue on the input itself (an unknown key) anywhere among
	 * the issues means no reason, as the Rust twin refuses unknown keys first.
	 * Declared reasons are named `<field>_invalid`.
	 *
	 * The declaration is the one source of the reason: the dispatcher reads it
	 * (`perform_action`), the adversarial suites expect it, and the Rust twin
	 * owes the same reason on every refusal of the field. Read through the
	 * field's optional, nullable, default, prefault, transform and pipe layers
	 * (not `.readonly()`, `.catch()` or `z.lazy()`), so it may sit on any of
	 * them; a declaration on a nested field overrides its parent's for a fault
	 * inside it, and an object-level refine whose issue names the field takes
	 * its reason too. See `resolve_issues_invalid_reason`.
	 */
	invalid_reason?: string;
}

/**
 * Whether `schema` carries `empty_input_handler_guarded: true` in its
 * metadata: a Zod schema's `.meta()`, a `@fuzdev/fuz_schema` schema's own
 * `meta` (`get_meta`), read from the schema itself in both.
 *
 * @param schema - an action's input schema, Zod or fuz_schema
 * @returns whether its handler refuses the `{}` the schema admits
 * @throws Error when `schema` is neither a Zod nor a fuz_schema schema
 */
export const is_empty_input_handler_guarded = (schema: ValidationSchema): boolean => {
	if (is_schema(schema)) return get_meta(schema)?.empty_input_handler_guarded === true;
	assert_zod_schema(schema, 'is_empty_input_handler_guarded: the input');
	return (schema.meta() as SchemaFieldMeta | undefined)?.empty_input_handler_guarded === true;
};

/**
 * A `SchemaFieldMeta` key's value as a schema declares it, read through its
 * optional, nullable, default, prefault, transform and pipe layers — Zod
 * keeps `.meta()` on the instance it was set on, so a wrapper added after it
 * carries none — the outermost declaration winning.
 *
 * @param schema - a field schema, possibly wrapped
 * @param key - the metadata key to read
 * @returns the declared value, or `undefined` when no layer declares one
 */
export const schema_meta_value = <TKey extends keyof SchemaFieldMeta>(
	schema: z.ZodType,
	key: TKey
): SchemaFieldMeta[TKey] | undefined => {
	for (const layer of zod_get_schema_layers(schema)) {
		const value = (layer.meta() as SchemaFieldMeta | undefined)?.[key];
		if (value !== undefined) return value;
	}
	return undefined;
};

/**
 * The `invalid_reason` a schema declares, read through its wrappers, the
 * outermost declaration winning.
 *
 * @param schema - a field schema, possibly wrapped
 * @returns the declared reason, or `undefined` when no layer declares one
 */
export const schema_invalid_reason = (schema: z.ZodType): string | undefined =>
	schema_meta_value(schema, 'invalid_reason');

/**
 * The strongest `sensitivity` declared on any schema `walk_sensitivity`
 * reaches from `schema` — `'secret'` over `'personal'` — visiting each schema
 * once, so a recursive `z.lazy()` terminates. It follows the `innerType` of
 * every wrapper that has one (optional, nullable, default, prefault,
 * nonoptional, catch, readonly, promise), both sides of a pipe and an
 * intersection, every member of a union (discriminated or not), a
 * template literal's schema parts, and a `z.lazy()` getter; with
 * `structural`, also an object's fields and catchall, an array's element, a
 * tuple's items and rest, and a record's, map's or set's keys and values.
 */
const walk_sensitivity = (schema: z.ZodType, structural: boolean): Sensitivity | undefined => {
	let found: Sensitivity | undefined;
	const seen: Set<z.ZodType> = new Set();
	const pending: Array<z.ZodType> = [schema];
	const push = (sub: unknown): void => {
		if (sub && typeof sub === 'object' && 'def' in sub) pending.push(sub as z.ZodType);
	};
	while (pending.length > 0) {
		const layer = pending.pop()!;
		if (seen.has(layer)) continue;
		seen.add(layer);
		const sensitivity = (layer.meta() as SchemaFieldMeta | undefined)?.sensitivity;
		if (sensitivity === 'secret') return 'secret';
		if (sensitivity === 'personal') found = 'personal';
		const def = layer.def as unknown as Record<string, unknown>;
		if (def.type === 'lazy') {
			push((layer as z.ZodLazy)._zod.innerType);
			continue;
		}
		if (def.type === 'union' && Array.isArray(def.options)) {
			for (const option of def.options) push(option);
			continue;
		}
		// the value is one string containing each part, so its schema parts count
		// like a wrapper's; `push` skips the literal parts (strings, numbers, …)
		if (def.type === 'template_literal' && Array.isArray(def.parts)) {
			for (const part of def.parts) push(part);
		}
		for (const key of ['innerType', 'in', 'out', 'left', 'right'] as const) push(def[key]);
		if (!structural) continue;
		if (def.type === 'object') {
			for (const field of Object.values((layer as z.ZodObject).shape)) push(field);
			push(def.catchall);
		} else if (def.type === 'array' || def.type === 'set') {
			push(def.element);
			push(def.valueType);
		} else if (def.type === 'tuple') {
			if (Array.isArray(def.items)) for (const item of def.items) push(item);
			push(def.rest);
		} else if (def.type === 'record' || def.type === 'map') {
			push(def.keyType);
			push(def.valueType);
		}
	}
	return found;
};

/**
 * The `sensitivity` a schema declares anywhere among its wrapping layers, so
 * a secret stays masked however the field is wrapped. Fail-safe where
 * `schema_meta_value` reads one chain: the walk follows the `innerType` of
 * every wrapper that has one (optional, nullable, default, prefault,
 * nonoptional, catch, readonly, promise), both sides of a pipe (so
 * `.transform()`, `z.preprocess()` and `.pipe(secret)` all reach the
 * secret), a `z.lazy()` getter, every member of a union (the value is one of
 * them), both sides of an intersection (it is both), and a template
 * literal's schema parts (the value contains them), visiting each schema
 * once, and answers the strongest level any layer reached declares —
 * `'secret'` over `'personal'`. It stops at structural schemas — an object's fields and an
 * array's element carry their own.
 *
 * @param schema - a field schema, possibly wrapped
 * @returns the strongest level any reachable layer declares, else `undefined`
 */
export const schema_sensitivity = (schema: z.ZodType): Sensitivity | undefined =>
	walk_sensitivity(schema, false);

/**
 * Whether an input schema carries a sensitive value at any depth — `'secret'`
 * or `'personal'` on the schema itself or anywhere inside it: through its
 * wrappers (as `schema_sensitivity`), and into object fields, array and set
 * elements, tuple items, record and map keys and values, template literal
 * parts, union members and intersection sides. A `@fuzdev/fuz_schema` schema
 * is read with `find_schema_meta` and `structural`: every layer, every step
 * of a pipe, every option of a union or variant, a `lazy`'s schema, and the
 * entries, rest, items and values of its objects, arrays and records.
 *
 * What keeps a read's input off the URL: `FrontendHttpTransport` sends a
 * read (`side_effects: false`) as a `GET` with the params in the query string,
 * which proxies and server logs record, unless its input carries a sensitive
 * value — that call goes as a `POST` (the transport walks each spec's input
 * once).
 *
 * @param schema - an action input schema, Zod or fuz_schema
 * @returns `true` when any value the schema admits may hold a sensitive field
 * @throws Error when `schema` is neither a Zod nor a fuz_schema schema
 */
export const schema_has_sensitive_field = (schema: ValidationSchema): boolean => {
	if (is_schema(schema)) {
		return find_schema_meta(schema, 'sensitivity', { structural: true }).length > 0;
	}
	assert_zod_schema(schema, 'schema_has_sensitive_field: the input');
	return walk_sensitivity(schema, true) !== undefined;
};

/**
 * The `error.data.reason` an input validation failure at `path` carries: the
 * `invalid_reason` of the deepest field along `path` that declares one.
 *
 * Walks object fields only, each through its wrappers: a segment that is not
 * a key of an object schema (an array index, a union member's key, an unknown
 * key) ends the walk, so a fault inside a declared field still resolves to
 * that field's reason. An empty path — a whole-input fault such as an
 * unrecognized key on the input object — resolves to none, as does a schema
 * that is not an object. A `@fuzdev/fuz_schema` schema is walked through its
 * entries (`get_schema_entries`) and reads the reason with `get_schema_meta`.
 *
 * @param input_schema - an action's input schema, Zod or fuz_schema
 * @param path - the failing issue's path
 * @returns the declared reason, or `undefined`
 */
export const resolve_invalid_reason = (
	input_schema: ValidationSchema,
	path: ReadonlyArray<PropertyKey>
): string | undefined => {
	if (is_schema(input_schema)) return resolve_schema_invalid_reason(input_schema, path);
	let reason: string | undefined;
	let schema = input_schema as z.ZodType;
	for (const segment of path) {
		if (typeof segment !== 'string') break;
		const shape = zod_unwrap_to_object(schema)?.shape;
		if (!shape || !Object.hasOwn(shape, segment)) break;
		const field = shape[segment] as z.ZodType;
		reason = schema_invalid_reason(field) ?? reason;
		schema = field;
	}
	return reason;
};

// the fuz_schema walk of `resolve_invalid_reason`
const resolve_schema_invalid_reason = (
	input_schema: AnySchema,
	path: ReadonlyArray<PropertyKey>
): string | undefined => {
	let reason: string | undefined;
	let schema = input_schema;
	for (const segment of path) {
		if (typeof segment !== 'string') break;
		const entries = get_schema_entries(schema);
		if (!entries || !Object.hasOwn(entries, segment)) break;
		const field = entries[segment]!;
		reason = get_schema_meta(field, 'invalid_reason') ?? reason;
		schema = field;
	}
	return reason;
};

/**
 * The `error.data.reason` a failed input parse answers: the declared reason
 * of the first issue's field (`resolve_invalid_reason`), or none when any
 * issue sits on the input itself (`issue_is_on_input`). Such an issue is an
 * unknown key on the input object (or a non-object input), which the Rust
 * twin refuses before reading any field, so a stale client sending an extra
 * key gets the same answer from both spines whatever else its body gets
 * wrong.
 *
 * A `@fuzdev/fuz_schema` parse reports at most a hundred issues, so faults on
 * the fields can crowd an unknown key out of them. For a strict `object`
 * input, `input` is checked for a key the schema doesn't name, as the Rust
 * twin checks it, whatever the issues hold. A Zod parse reports every issue
 * and `input` is not read.
 *
 * @param input_schema - an action's input schema, Zod or fuz_schema
 * @param issues - the failed parse's issues, in the library's order
 * @param input - the value that was parsed
 * @returns the declared reason, or `undefined`
 */
export const resolve_issues_invalid_reason = (
	input_schema: ValidationSchema,
	issues: ReadonlyArray<AnyIssue>,
	input: unknown
): string | undefined => {
	const first = issues[0];
	if (!first || issues.some(issue_is_on_input)) return undefined;
	if (is_schema(input_schema) && has_unknown_root_key(input_schema, input)) return undefined;
	return resolve_invalid_reason(input_schema, first.path);
};

// whether `input` has a key the strict `object` at the root of `schema` doesn't
// name, read as that object's own check reads it (`for in`, then `Object.hasOwn`)
const has_unknown_root_key = (schema: AnySchema, input: unknown): boolean => {
	const root = unwrap_schema(schema);
	if (root.kind !== 'object') return false;
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
	for (const key in input) {
		if (!Object.hasOwn(root.def, key)) return true;
	}
	return false;
};
