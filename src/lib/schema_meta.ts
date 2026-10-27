/**
 * Shared Zod `.meta()` conventions for fuz_app schemas.
 *
 * Cross-cutting metadata shape used by env schemas, auth input schemas,
 * surface generation, and test helpers.
 *
 * @module
 */

import type { z } from 'zod';

import type { Sensitivity } from './sensitivity.ts';
import { zod_get_schema_layers, zod_unwrap_to_object } from './zod.ts';

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
 * Whether `schema` carries `empty_input_handler_guarded: true` in its `.meta()`.
 *
 * @param schema - an action's input schema
 * @returns whether its handler refuses the `{}` the schema admits
 */
export const is_empty_input_handler_guarded = (schema: z.ZodType): boolean =>
	(schema.meta() as SchemaFieldMeta | undefined)?.empty_input_handler_guarded === true;

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
 * parts, union members and intersection sides.
 *
 * What keeps a read's input off the URL: `FrontendHttpTransport` sends a
 * read (`side_effects: false`) as a `GET` with the params in the query string,
 * which proxies and server logs record, unless its input carries a sensitive
 * value — that call goes as a `POST` (the transport walks each spec's input
 * once).
 *
 * @param schema - an action input schema
 * @returns `true` when any value the schema admits may hold a sensitive field
 */
export const schema_has_sensitive_field = (schema: z.ZodType): boolean =>
	walk_sensitivity(schema, true) !== undefined;

/**
 * The `error.data.reason` an input validation failure at `path` carries: the
 * `invalid_reason` of the deepest field along `path` that declares one.
 *
 * Walks object fields only, each through its wrappers: a segment that is not
 * a key of an object schema (an array index, a union member's key, an unknown
 * key) ends the walk, so a fault inside a declared field still resolves to
 * that field's reason. An empty path — a whole-input fault such as an
 * unrecognized key on the input object — resolves to none, as does a schema
 * that is not an object.
 *
 * @param input_schema - an action's input schema
 * @param path - the failing issue's path (`ZodError.issues[0].path`)
 * @returns the declared reason, or `undefined`
 */
export const resolve_invalid_reason = (
	input_schema: z.ZodType,
	path: ReadonlyArray<PropertyKey>
): string | undefined => {
	let reason: string | undefined;
	let schema = input_schema;
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

/**
 * The `error.data.reason` a failed input parse answers: the declared reason
 * of the first issue's field (`resolve_invalid_reason`), or none when any
 * issue sits on the input itself. Such an issue is an unknown key on the
 * input object (or a non-object input), which the Rust twin refuses before
 * reading any field, so a stale client sending an extra key gets the same
 * answer from both spines whatever else its body gets wrong.
 *
 * @param input_schema - an action's input schema
 * @param issues - the failed parse's issues, in Zod's order
 * @returns the declared reason, or `undefined`
 */
export const resolve_issues_invalid_reason = (
	input_schema: z.ZodType,
	issues: ReadonlyArray<z.core.$ZodIssue>
): string | undefined => {
	const first = issues[0];
	if (!first || issues.some((issue) => issue.path.length === 0)) return undefined;
	return resolve_invalid_reason(input_schema, first.path);
};
