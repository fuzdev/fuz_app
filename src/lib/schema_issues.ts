/**
 * Validation issues from either schema library the stack's specs use: Zod
 * (`z.core.$ZodIssue`) and `@fuzdev/fuz_schema` (`SchemaIssue`). A schema is
 * wholly one library, so one parse's issues are all of one kind; these
 * helpers read either, so the dispatcher, `ActionEvent` and the
 * forward-compatible reads treat a spec the same whichever library it is
 * written in.
 *
 * @module
 */

import { z } from 'zod';
import {
	format_issue,
	is_schema,
	parse,
	SchemaError,
	type AnySchema,
	type Infer,
	type SchemaIssue
} from '@fuzdev/fuz_schema/schema.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

/** A schema of either library: a Zod schema or a `@fuzdev/fuz_schema` one. */
export type ValidationSchema = z.ZodType | AnySchema;

/** The output type of a `ValidationSchema`. */
export type ValidationOutput<T extends ValidationSchema> = T extends z.ZodType
	? z.output<T>
	: T extends AnySchema
		? Infer<T>
		: never;

/** One issue of a failed parse, in the library's own shape. */
export type AnyIssue = z.core.$ZodIssue | SchemaIssue;

/** What `parse_any` returns: the output, or the failed parse's issues in the library's order. */
export type ParseAnyResult<T> = Result<{ value: T }, { issues: Array<AnyIssue> }>;

/**
 * Parse `value` with a schema of either library: `parse` for a fuz_schema
 * schema (`is_schema`), `safeParse` for a Zod one.
 *
 * A fuz_schema parse reports at most its first hundred issues, a Zod parse
 * every issue.
 *
 * @param schema - a Zod or fuz_schema schema
 * @param value - the value to validate
 * @returns the output, or the issues
 */
export const parse_any = <T extends ValidationSchema>(
	schema: T,
	value: unknown
): ParseAnyResult<ValidationOutput<T>> => {
	if (is_schema(schema)) {
		const result = parse(schema, value);
		return result.ok
			? { ok: true, value: result.value as ValidationOutput<T> }
			: { ok: false, issues: result.issues };
	}
	const result = (schema as z.ZodType).safeParse(value);
	return result.success
		? { ok: true, value: result.data as ValidationOutput<T> }
		: { ok: false, issues: result.error.issues };
};

/**
 * Whether `issue` is Zod's: every Zod issue has a `code`, a fuz_schema issue a `kind`.
 */
export const is_zod_issue = (issue: AnyIssue): issue is z.core.$ZodIssue => 'code' in issue;

/**
 * Whether `issue` sits on the input itself rather than on one of its fields:
 * a non-object input, or an unknown key on the input object — what the Rust
 * twin refuses before reading any field.
 *
 * Zod reports both at an empty path, its `unrecognized_keys` naming the keys.
 * fuz_schema reports a non-object at an empty path and each unknown key as an
 * `unknown_key` issue whose path ends at the key, so one on the input has a
 * path of the key alone. An unknown key on a nested object is on that field,
 * as Zod's is.
 *
 * On the wire the `unknown_key` rule changes no answer today: a root
 * `unknown_key` comes from a root `object`, which `resolve_issues_invalid_reason`
 * already answers with none from its check of the input's keys, or from a
 * schema such as a `variant` whose fields resolve no reason. It is kept as the
 * direct statement of Zod's rule.
 *
 * @param issue - one issue of a failed parse
 */
export const issue_is_on_input = (issue: AnyIssue): boolean =>
	issue.path.length === 0 ||
	(!is_zod_issue(issue) && issue.kind === 'unknown_key' && issue.path.length === 1);

/** Keys a parse refused as unknown, and the path of the object holding them. */
export interface UnknownKeyTarget {
	/** The path of the object the keys are on, `[]` for the input itself. */
	path: ReadonlyArray<PropertyKey>;
	/** The unknown keys. */
	keys: ReadonlyArray<PropertyKey>;
}

/**
 * The unknown keys among `issues`, each with the path of its object, or
 * `null` when any issue is something else.
 *
 * A Zod `unrecognized_keys` issue is at its object's path and names every
 * key; a fuz_schema `unknown_key` issue is one key, the last element of its
 * path.
 *
 * @param issues - a failed parse's issues
 * @returns a target per issue, or `null` when not every issue is an unknown key
 */
export const unknown_key_targets = (
	issues: ReadonlyArray<AnyIssue>
): Array<UnknownKeyTarget> | null => {
	const targets: Array<UnknownKeyTarget> = [];
	for (const issue of issues) {
		if (is_zod_issue(issue)) {
			if (issue.code !== 'unrecognized_keys') return null;
			targets.push({ path: issue.path, keys: issue.keys });
		} else {
			if (issue.kind !== 'unknown_key' || issue.path.length === 0) return null;
			targets.push({ path: issue.path.slice(0, -1), keys: [issue.path.at(-1)!] });
		}
	}
	return targets;
};

/**
 * A failed parse's issues as text: Zod's `z.prettifyError` text for Zod
 * issues, and for fuz_schema issues their `format_issue` lines.
 *
 * @param issues - a failed parse's issues, all of one library
 */
export const format_issues = (issues: ReadonlyArray<AnyIssue>): string => {
	const first = issues[0];
	if (!first) return '';
	if (is_zod_issue(first)) {
		return z.prettifyError({ issues: issues as ReadonlyArray<z.core.$ZodIssue> });
	}
	return (issues as ReadonlyArray<SchemaIssue>).map(format_issue).join('\n');
};

/**
 * Whether `err` is a thrown validation failure of either library: a
 * `z.ZodError` or a fuz_schema `SchemaError` (`parse_or_throw`). Both carry
 * the failed parse's `issues`.
 *
 * @param err - a caught value
 */
export const is_schema_validation_error = (err: unknown): err is z.ZodError | SchemaError =>
	err instanceof z.ZodError || err instanceof SchemaError;
