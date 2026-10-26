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
	/** Sensitivity level for masking/redaction. `'secret'` masks the value. */
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
 * The `invalid_reason` a schema declares, read through its wrappers, the
 * outermost declaration winning.
 *
 * @param schema - a field schema, possibly wrapped
 * @returns the declared reason, or `undefined` when no layer declares one
 */
export const schema_invalid_reason = (schema: z.ZodType): string | undefined => {
	for (const layer of zod_get_schema_layers(schema)) {
		const reason = (layer.meta() as SchemaFieldMeta | undefined)?.invalid_reason;
		if (reason !== undefined) return reason;
	}
	return undefined;
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
