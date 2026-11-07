/**
 * fuz_app's `@fuzdev/fuz_schema` metadata conventions.
 *
 * Cross-cutting metadata read by auth and action input schemas, surface
 * generation, and test helpers. `sensitivity.ts` adds `sensitivity` to
 * fuz_schema's `SchemaMeta` (read by `find_schema_sensitivity`); this module
 * adds `invalid_reason` and `empty_input_handler_guarded` — the declared
 * refusal reason of an action input's field and its handler-guarded marker —
 * and JSON Schema's `readOnly` annotation, which `to_json_schema` writes onto
 * the node.
 *
 * @module
 */

import type { AnySchema, SchemaIssue } from '@fuzdev/fuz_schema/schema.ts';
import {
	find_schema_meta,
	get_schema_entries,
	get_schema_meta,
	unwrap_schema
} from '@fuzdev/fuz_schema/introspect.ts';
import { get_meta } from '@fuzdev/fuz_schema/meta.ts';

import { assert_validation_schema, issue_is_on_input } from './schema_issues.ts';

declare module '@fuzdev/fuz_schema/meta.ts' {
	interface SchemaMeta {
		/**
		 * The `error.data.reason` an action input refuses this field with. On a
		 * field of an action's **input** schema, every `invalid_params` whose
		 * first issue lands on the field — missing, wrong type, `null`, out of
		 * range, malformed, or a fault anywhere inside it — carries this reason,
		 * where an undeclared field's refusal carries none. The message stays the
		 * generic `invalid params`. A body with faults on several fields answers
		 * the first issue's reason, which a twin checking in another order need
		 * not match, so the reason is defined for a single-fault body only —
		 * except that an issue on the input itself (an unknown key) anywhere among
		 * the issues means no reason, as the Rust twin refuses unknown keys first.
		 * Declared reasons are named `<field>_invalid`.
		 *
		 * The declaration is the one source of the reason: the dispatcher reads
		 * it (`perform_action`), the adversarial suites expect it, and the Rust
		 * twin owes the same reason on every refusal of the field. Read through
		 * the field's layers (`get_schema_meta`), the outermost declaration
		 * winning; a declaration on a nested field overrides its parent's for a
		 * fault inside it. See `resolve_issues_invalid_reason`.
		 */
		invalid_reason?: string;
		/**
		 * Set on an action's **input** schema that accepts `{}` by design while
		 * its handler refuses `{}` with a declared reason — an input taking one
		 * of several optional selectors, where the handler names the missing or
		 * conflicting one (a schema-level check would answer a reason-less
		 * `invalid_params` first). A call with no input is never valid for such
		 * an action, so the typed surface keeps its input required
		 * (`action_input_is_optional`), and the input-shape invariant ("an input
		 * accepting `{}` accepts `undefined` too") exempts it. Read from the
		 * input schema itself (`get_meta`), so a wrapper around it drops it.
		 */
		empty_input_handler_guarded?: boolean;
		/**
		 * JSON Schema's `readOnly` annotation, which `to_json_schema` copies onto
		 * the node: written on the role and credential-type lists of the 403
		 * bodies (`http/error_schemas.ts`).
		 */
		readOnly?: boolean;
	}
}

/**
 * Whether `schema` carries `empty_input_handler_guarded: true` in its own
 * `meta` (`get_meta`).
 *
 * @param schema - an action's input schema
 * @returns whether its handler refuses the `{}` the schema admits
 * @throws Error when `schema` is no schema
 */
export const is_empty_input_handler_guarded = (schema: AnySchema): boolean => {
	assert_validation_schema(schema, 'is_empty_input_handler_guarded: the input');
	return get_meta(schema)?.empty_input_handler_guarded === true;
};

/**
 * Whether an input schema carries a sensitive value at any depth — `'secret'`
 * or `'personal'` on the schema itself or anywhere inside it, read with
 * `find_schema_meta` and `structural`: every layer, every step of a pipe,
 * every option of a union or variant, a `lazy`'s schema, and the entries,
 * rest, items and values of its objects, arrays and records.
 *
 * What keeps a read's input off the URL: `FrontendHttpTransport` sends a
 * read (`side_effects: false`) as a `GET` with the params in the query string,
 * which proxies and server logs record, unless its input carries a sensitive
 * value — that call goes as a `POST` (the transport walks each spec's input
 * once).
 *
 * @param schema - an action input schema
 * @returns `true` when any value the schema admits may hold a sensitive field
 * @throws Error when `schema` is no schema, which would otherwise read as holding none
 */
export const schema_has_sensitive_field = (schema: AnySchema): boolean => {
	assert_validation_schema(schema, 'schema_has_sensitive_field: the input');
	return find_schema_meta(schema, 'sensitivity', { structural: true }).length > 0;
};

/**
 * The `error.data.reason` an input validation failure at `path` carries: the
 * `invalid_reason` of the deepest field along `path` that declares one.
 *
 * Walks object fields only, through their entries (`get_schema_entries`), each
 * read with `get_schema_meta` through its wrappers: a segment that is not a
 * key of an object schema (an array index, a union member's key, an unknown
 * key) ends the walk, so a fault inside a declared field still resolves to
 * that field's reason. An empty path — a whole-input fault such as an unknown
 * key on the input object — resolves to none, as does a schema that is not an
 * object.
 *
 * @param input_schema - an action's input schema
 * @param path - the failing issue's path
 * @returns the declared reason, or `undefined`
 */
export const resolve_invalid_reason = (
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
 * A parse reports at most a hundred issues, so faults on the fields can crowd
 * an unknown key out of them. For a strict `object` input, `input` is
 * checked for a key the schema doesn't name, as the Rust twin checks it,
 * whatever the issues hold.
 *
 * @param input_schema - an action's input schema
 * @param issues - the failed parse's issues, in the parse's order
 * @param input - the value that was parsed
 * @returns the declared reason, or `undefined`
 */
export const resolve_issues_invalid_reason = (
	input_schema: AnySchema,
	issues: ReadonlyArray<SchemaIssue>,
	input: unknown
): string | undefined => {
	const first = issues[0];
	if (!first || issues.some(issue_is_on_input)) return undefined;
	if (has_unknown_root_key(input_schema, input)) return undefined;
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
